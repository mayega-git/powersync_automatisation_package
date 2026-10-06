import pg from 'pg';
import type { AerisArtifact, FieldType, JsonValue, Projection } from '../ir/types.js';
import type { Change, DeltaResponse, SnapshotEnvelope } from '../protocol.js';
import { canonicalJson } from '../ir/canonical.js';
import { createHash } from 'node:crypto';
import { logTableName, qualifiedTable, quoteIdent } from './sql.js';
import type { SessionClaims } from './auth.js';

const RAW_TYPES = new Set([20, 1700, 1082, 1083, 1114, 1184, 1266]);

/** pg type parsers that keep temporal and big numeric values as their exact text. */
export const rawTypes = {
  getTypeParser: (oid: number, format?: string) => (RAW_TYPES.has(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format as 'text')),
};

/** Converts a PostgreSQL value to the wire form Jackson gives the same Java value. */
export function toWire(value: unknown, type: FieldType): JsonValue {
  if (value === null || value === undefined) return null;
  if (type.list === true) {
    if (!Array.isArray(value)) return null;
    return value.map((item) => toWire(item, { ...type, list: false }));
  }
  switch (type.type) {
    case 'uuid': return String(value).toLowerCase();
    case 'string':
    case 'enum': return String(value);
    case 'integer':
    case 'decimal': return typeof value === 'number' ? value : Number(value);
    case 'boolean': return Boolean(value);
    case 'date': return String(value).slice(0, 10);
    case 'time': return String(value);
    case 'datetime-local': return String(value).replace(' ', 'T').replace(/([+-]\d{2}(:\d{2})?)$/, '');
    case 'datetime': return instantText(String(value));
    case 'json': return value as JsonValue;
  }
}

/** ISO-8601 instant like java.time.Instant.toString(): UTC, fraction in groups of three digits. */
export function instantText(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(text.trim());
  if (match === null) return text;
  const [, date, hh, mm, ss, fraction = '', zone = 'Z'] = match as unknown as [string, string, string, string, string, string?, string?];
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(hh), Number(mm), Number(ss)) - offsetMinutes * 60_000;
  const base = new Date(epoch).toISOString().slice(0, 19);
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length === 0) return `${base}Z`;
  const groups = Math.ceil(trimmed.length / 3) * 3;
  return `${base}.${trimmed.padEnd(groups, '0')}Z`;
}

function scopeWhere(projection: Projection, claims: SessionClaims, params: unknown[], projections: ReadonlyMap<string, Projection>): string | undefined {
  if (projection.public) return 'TRUE';
  const parts: string[] = [];
  for (const filter of projection.scope) {
    const claim = filter.value?.k === 'ctx' ? claims[filter.value.name] : undefined;
    if (claim === undefined || claim === null) return undefined;
    const column = projection.columns.find((candidate) => candidate.name === filter.field)!.column;
    params.push(String(claim));
    parts.push(`${quoteIdent(column)}::text = $${params.length}`);
  }
  if (projection.parent !== undefined) {
    // Visible exactly when the parent row is visible.
    const parent = projections.get(projection.parent.entity)!;
    const parentWhere = scopeWhere(parent, claims, params, projections);
    if (parentWhere === undefined) return undefined;
    const field = projection.columns.find((candidate) => candidate.name === projection.parent!.field)!.column;
    const parentKey = parent.columns.find((candidate) => candidate.name === parent.key)!.column;
    parts.push(`${quoteIdent(field)} IN (SELECT ${quoteIdent(parentKey)} FROM ${qualifiedTable(parent)} WHERE ${parentWhere})`);
  }
  return parts.length === 0 ? undefined : parts.join(' AND ');
}

/** Projections ordered so that a parent always comes before its children. */
function parentsFirst(projections: readonly Projection[]): Projection[] {
  const byEntity = new Map(projections.map((projection) => [projection.entity, projection]));
  const depth = (projection: Projection): number => (projection.parent === undefined ? 0 : 1 + depth(byEntity.get(projection.parent.entity)!));
  return [...projections].sort((a, b) => depth(a) - depth(b));
}

function selectList(projection: Projection): string {
  return projection.columns.map((column) => quoteIdent(column.column)).join(', ');
}

function rowOf(projection: Projection, raw: Record<string, unknown>): Record<string, JsonValue> {
  const row: Record<string, JsonValue> = {};
  for (const column of projection.columns) row[column.name] = toWire(raw[column.column], column.type);
  return row;
}

/** Snapshot and delta reads of the projections, always restricted to the caller's scope. */
export class ProjectionReader {
  private readonly projections: ReadonlyMap<string, Projection>;

  constructor(private readonly pool: pg.Pool, private readonly artifact: AerisArtifact, private readonly schema = 'aeris') {
    this.projections = new Map(artifact.projections.map((projection) => [projection.entity, projection]));
  }

  private async readOnly<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshot(claims: SessionClaims): Promise<SnapshotEnvelope> {
    return this.readOnly(async (client) => {
      const cursor = await this.currentCursor(client);
      const entities: Record<string, Record<string, JsonValue>[]> = {};
      for (const projection of this.artifact.projections) {
        const params: unknown[] = [];
        const where = scopeWhere(projection, claims, params, this.projections);
        if (where === undefined) {
          entities[projection.entity] = [];
          continue;
        }
        const result = await client.query<Record<string, unknown>>(`SELECT ${selectList(projection)} FROM ${qualifiedTable(projection)} WHERE ${where}`, params);
        entities[projection.entity] = result.rows.map((raw) => rowOf(projection, raw));
      }
      return {
        projectionVersion: this.artifact.projectionVersion,
        cursor,
        generatedAt: new Date().toISOString(),
        scopeHash: `sha256:${createHash('sha256').update(canonicalJson(claims)).digest('hex')}`,
        entities,
      };
    });
  }

  async delta(claims: SessionClaims, since: string, pageSize: number): Promise<DeltaResponse> {
    if (!/^\d{1,19}$/.test(since)) throw new Error('Invalid cursor.');
    return this.readOnly(async (client) => {
      const pruned = await client.query<{ value: string }>(`SELECT value FROM ${quoteIdent(this.schema)}.meta WHERE key = 'pruned_through'`);
      if (pruned.rows[0] !== undefined && BigInt(since) < BigInt(pruned.rows[0].value)) {
        return { projectionVersion: this.artifact.projectionVersion, cursor: since, changes: [], hasMore: false, resnapshot: true };
      }
      const byTable = new Map<string, Projection>();
      for (const projection of this.artifact.projections) byTable.set(logTableName(projection), projection);
      const log = await client.query<{ seq: string; table_name: string; row_key: string }>(
        `SELECT seq::text AS seq, table_name, row_key FROM ${quoteIdent(this.schema)}.change_log
          WHERE seq > $1 AND table_name = ANY($2) ORDER BY seq LIMIT $3`,
        [since, [...byTable.keys()], pageSize],
      );
      const current = await this.currentCursor(client);
      const cursor = log.rows.length === pageSize ? log.rows.at(-1)!.seq : current;
      // Latest state of each changed row, filtered by the scope.
      const keysByTable = new Map<string, Set<string>>();
      for (const entry of log.rows) {
        const keys = keysByTable.get(entry.table_name) ?? new Set<string>();
        keys.add(entry.row_key);
        keysByTable.set(entry.table_name, keys);
      }
      const changes: Change[] = [];
      for (const [table, keys] of keysByTable) {
        const projection = byTable.get(table)!;
        const keyColumn = projection.columns.find((column) => column.name === projection.key)!;
        const params: unknown[] = [];
        const where = scopeWhere(projection, claims, params, this.projections);
        const visible = new Map<string, Record<string, JsonValue>>();
        if (where !== undefined) {
          params.push([...keys]);
          const result = await client.query<Record<string, unknown>>(
            `SELECT ${selectList(projection)} FROM ${qualifiedTable(projection)} WHERE (${where}) AND ${quoteIdent(keyColumn.column)}::text = ANY($${params.length})`,
            params,
          );
          for (const raw of result.rows) {
            const row = rowOf(projection, raw);
            visible.set(String(raw[keyColumn.column]).toLowerCase(), row);
          }
        }
        for (const key of keys) {
          const row = visible.get(key.toLowerCase());
          const typedKey = toWire(key, keyColumn.type);
          changes.push(row === undefined
            ? { entity: projection.entity, op: 'delete', key: typedKey }
            : { entity: projection.entity, op: 'upsert', key: typedKey, row });
        }
      }
      // A parent that became visible makes its existing children visible too (they did not change themselves).
      const upserted = new Map<string, Set<string>>();
      for (const change of changes) {
        if (change.op === 'upsert') upserted.set(change.entity, (upserted.get(change.entity) ?? new Set()).add(String(change.key).toLowerCase()));
      }
      for (const child of parentsFirst(this.artifact.projections)) {
        const parentKeys = child.parent === undefined ? undefined : upserted.get(child.parent.entity);
        if (parentKeys === undefined || parentKeys.size === 0) continue;
        const params: unknown[] = [];
        const where = scopeWhere(child, claims, params, this.projections);
        if (where === undefined) continue;
        const field = child.columns.find((column) => column.name === child.parent!.field)!.column;
        const keyColumn = child.columns.find((column) => column.name === child.key)!;
        params.push([...parentKeys]);
        const result = await client.query<Record<string, unknown>>(
          `SELECT ${selectList(child)} FROM ${qualifiedTable(child)} WHERE (${where}) AND ${quoteIdent(field)}::text = ANY($${params.length})`,
          params,
        );
        const already = new Set(changes.filter((change) => change.entity === child.entity).map((change) => String(change.key).toLowerCase()));
        for (const raw of result.rows) {
          const key = String(raw[keyColumn.column]).toLowerCase();
          if (already.has(key)) continue;
          changes.push({ entity: child.entity, op: 'upsert', key: toWire(raw[keyColumn.column], keyColumn.type), row: rowOf(child, raw) });
          upserted.set(child.entity, (upserted.get(child.entity) ?? new Set()).add(key));
        }
      }
      return { projectionVersion: this.artifact.projectionVersion, cursor, changes, hasMore: log.rows.length === pageSize };
    });
  }

  async currentCursor(client: pg.PoolClient | pg.Pool = this.pool): Promise<string> {
    const result = await client.query<{ cursor: string }>(`SELECT COALESCE(max(seq), 0)::text AS cursor FROM ${quoteIdent(this.schema)}.change_log`);
    return result.rows[0]!.cursor;
  }

  /** Scoped rows of every projection, without needing the gateway schema (differential tests). */
  async rows(claims: SessionClaims): Promise<Record<string, Record<string, JsonValue>[]>> {
    return this.readOnly(async (client) => {
      const entities: Record<string, Record<string, JsonValue>[]> = {};
      for (const projection of this.artifact.projections) {
        const params: unknown[] = [];
        const where = scopeWhere(projection, claims, params, this.projections);
        if (where === undefined) {
          entities[projection.entity] = [];
          continue;
        }
        const result = await client.query<Record<string, unknown>>(`SELECT ${selectList(projection)} FROM ${qualifiedTable(projection)} WHERE ${where}`, params);
        entities[projection.entity] = result.rows.map((raw) => rowOf(projection, raw));
      }
      return entities;
    });
  }

  /** A few keys of rows outside the session scope, to check that nothing leaks. */
  async foreignKeys(projection: Projection, claims: SessionClaims, limit: number): Promise<JsonValue[]> {
    if (projection.public) return [];
    const params: unknown[] = [];
    const where = scopeWhere(projection, claims, params, this.projections);
    if (where === undefined) return [];
    const keyColumn = projection.columns.find((column) => column.name === projection.key)!;
    params.push(limit);
    const result = await this.pool.query<Record<string, unknown>>(
      // COALESCE: a null parent reference makes the scope test unknown, and such
      // a row is invisible, so the probe must list it rather than drop it.
      `SELECT ${quoteIdent(keyColumn.column)} AS k FROM ${qualifiedTable(projection)} WHERE NOT COALESCE((${where}), FALSE) LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => toWire(row.k, keyColumn.type));
  }

  /** Deletes log rows older than the retention window; older cursors then re-snapshot. */
  async prune(retentionDays: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query<{ seq: string }>(
        `DELETE FROM ${quoteIdent(this.schema)}.change_log WHERE changed_at < now() - make_interval(days => $1) AND seq IS NOT NULL RETURNING seq::text AS seq`,
        [retentionDays],
      );
      const highest = deleted.rows.reduce<bigint>((max, row) => (BigInt(row.seq) > max ? BigInt(row.seq) : max), 0n);
      if (highest > 0n) {
        await client.query(
          `INSERT INTO ${quoteIdent(this.schema)}.meta (key, value) VALUES ('pruned_through', $1)
            ON CONFLICT (key) DO UPDATE SET value = GREATEST(${quoteIdent(this.schema)}.meta.value::bigint, EXCLUDED.value::bigint)::text`,
          [highest.toString()],
        );
      }
      await client.query('COMMIT');
      return deleted.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
