import type { SqlValue } from './AccessLocalDatabase.js';
import type { SqlParams } from './SqlTranslator.js';
import type { AggregateDef } from './EntityRoutes.js';

export class SqlBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlBuildError';
  }
}

/** Table name to its real columns, read from the generated schema. */
export type TableColumns = Readonly<Record<string, readonly string[]>>;

/** `id` is the only exception, and only on insert. */
const RESERVED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'tenant_id',
  'created_at',
  'updated_at',
  '_metadata',
]);

export type SqlKind = 'read' | 'insert' | 'update' | 'delete' | 'mark';

export interface BuiltStatement {
  kind: SqlKind;
  /** Named parameters (`:id`); pass through SqlTranslator before hitting the database. */
  sql: string;
  params: SqlParams;
}

export interface SqlBuildInput {
  table: string;
  method: string;
  /** The `id`-named hole identifies the row; otherwise the last hole does. */
  pathParams: Readonly<Record<string, string>>;
  /**
   * Path-param name -> real column name, for a hole that filters a column
   * other than the row's own id (e.g. `{type}` -> `item_type`). A hole
   * listed here is never treated as `id`, however it's positioned in the
   * path. A hole absent from this map keeps the implicit behaviour: the
   * last hole (or the one literally named `id`) identifies the row.
   */
  paramColumns?: Readonly<Record<string, string>>;
  body?: unknown;
  /** Stored in `_metadata`. */
  metadata?: string;
  /** `null` before the first sync. */
  tenantId?: string | null;
  now?: string;
  /** Join clauses for GET requests */
  joins?: string[];
  /** Aggregate subqueries (nested JSON) */
  aggregates?: AggregateDef[];
  select?: string;
  newId?: () => string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function toSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function toCamelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  );
}

export class SqlBuilder {
  constructor(private readonly schema: TableColumns) {}

  /** A delete returns two statements: the engine may not carry `_metadata` on a DELETE. */
  build(input: SqlBuildInput): BuiltStatement[] {
    const columns = this.columnsFor(input.table);
    const method = input.method.toUpperCase();

    switch (method) {
      case 'GET':
      case 'HEAD':
        return [this.buildRead(input, columns)];
      case 'POST':
        return [this.buildInsert(input, columns)];
      case 'PUT':
      case 'PATCH':
        return [this.buildUpdate(input, columns)];
      case 'DELETE':
        return this.buildDelete(input, columns);
      default:
        throw new SqlBuildError(
          `HTTP method ${method} has no SQL equivalent. Composable methods: ` +
            'GET, HEAD, POST, PUT, PATCH, DELETE.',
        );
    }
  }

  private columnsFor(table: string): readonly string[] {
    if (!IDENTIFIER.test(table)) {
      throw new SqlBuildError(`"${table}" is not a usable table name.`);
    }
    const columns = this.schema[table];
    if (columns === undefined) {
      throw new SqlBuildError(
        `Table "${table}" is declared but missing from the engine schema. ` +
          `Known tables: ${Object.keys(this.schema).join(', ') || '(none)'}.`,
      );
    }
    for (const column of columns) {
      if (!IDENTIFIER.test(column)) {
        throw new SqlBuildError(`Column "${column}" of ${table} is not usable.`);
      }
    }
    // `id` is never declared in the schema; the engine adds it to every table.
    return columns.includes('id') ? columns : ['id', ...columns];
  }

  /**
   * `undefined` when the path has no hole at all, i.e. a collection. A hole
   * mapped in `paramColumns` is never returned here: it names a filter
   * column, not the row's id, however it's positioned in the path.
   */
  private idHole(input: SqlBuildInput): string | undefined {
    const mapped = input.paramColumns ?? {};
    const keys = Object.keys(input.pathParams).filter((k) => mapped[k] === undefined);
    if (keys.length === 0) return undefined;
    return keys.includes('id') ? 'id' : keys[keys.length - 1]!;
  }

  private pathFilters(
    input: SqlBuildInput,
    columns: readonly string[],
    excluded: string | undefined,
  ): { clauses: string[]; params: SqlParams } {
    const clauses: string[] = [];
    const params: SqlParams = {};
    for (const [name, value] of Object.entries(input.pathParams)) {
      if (name === excluded) continue;
      const column = input.paramColumns?.[name] ?? toSnakeCase(name);
      if (!columns.includes(column)) continue;
      const prefix = (input.joins && input.joins.length > 0) ? `${input.table}.` : '';
      clauses.push(`${prefix}${column} = :${column}`);
      params[column] = value;
    }
    return { clauses, params };
  }

  private bodyColumns(
    input: SqlBuildInput,
    columns: readonly string[],
    allowId: boolean,
  ): { names: string[]; params: SqlParams } {
    const names: string[] = [];
    const params: SqlParams = {};
    if (!isPlainObject(input.body)) return { names, params };

    for (const [key, value] of Object.entries(input.body)) {
      const column = toSnakeCase(key);
      if (!columns.includes(column)) continue;
      if (RESERVED_COLUMNS.has(column) && !(allowId && column === 'id')) continue;
      if (column === 'id') continue;
      if (!isSqlValue(value)) continue;
      names.push(column);
      params[column] = value;
    }
    return { names, params };
  }

  private buildRead(input: SqlBuildInput, columns: readonly string[]): BuiltStatement {
    const prefix = (input.joins && input.joins.length > 0) ? `${input.table}.` : '';
    let projection = input.select ? input.select : columns
      .filter((c) => c !== '_metadata')
      .map((c) => {
        const camel = toCamelCase(c);
        return camel === c ? `${prefix}${c}` : `${prefix}${c} AS ${camel}`;
      })
      .join(', ');

    if (input.aggregates && input.aggregates.length > 0) {
      const aggregateSelects = input.aggregates.map((agg) => {
        const aggColumns = this.columnsFor(agg.table).filter((c) => c !== '_metadata');
        const jsonFields = aggColumns.map((c) => `'${toCamelCase(c)}', ${agg.table}.${c}`).join(', ');
        return `(SELECT json_group_array(json_object(${jsonFields})) FROM ${agg.table} WHERE ${agg.on}) AS ${agg.field}`;
      });
      projection += ', ' + aggregateSelects.join(', ');
    }

    const idHole = this.idHole(input);
    const params: SqlParams = {};
    const where: string[] = [];

    if (idHole !== undefined) {
      where.push(`${prefix}id = :id`);
      params['id'] = input.pathParams[idHole]!;
    }
    const filters = this.pathFilters(input, columns, idHole);
    where.push(...filters.clauses);
    Object.assign(params, filters.params);

    const order = columns.includes('name')
      ? ` ORDER BY ${prefix}name COLLATE NOCASE`
      : columns.includes('created_at')
        ? ` ORDER BY ${prefix}created_at DESC`
        : '';

    const joinsClause = (input.joins && input.joins.length > 0)
      ? ` ${input.joins.join(' ')}`
      : '';

    const sql =
      `SELECT ${projection} FROM ${input.table}${joinsClause}` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      (idHole === undefined ? order : '');

    return { kind: 'read', sql, params };
  }

  private buildInsert(input: SqlBuildInput, columns: readonly string[]): BuiltStatement {
    const body = this.bodyColumns(input, columns, true);
    const now = input.now ?? new Date().toISOString();

    const names = ['id', ...body.names];
    const params: SqlParams = { ...body.params };

    const proposedId =
      isPlainObject(input.body) && typeof input.body['id'] === 'string'
        ? input.body['id']
        : undefined;
    params['id'] = proposedId ?? (input.newId ?? defaultNewId)();

    const filters = this.pathFilters(input, columns, undefined);
    for (const [column, value] of Object.entries(filters.params)) {
      if (names.includes(column) || RESERVED_COLUMNS.has(column)) continue;
      names.push(column);
      params[column] = value;
    }

    if (columns.includes('tenant_id')) {
      names.push('tenant_id');
      params['tenant_id'] = input.tenantId ?? null;
    }
    for (const timestamp of ['created_at', 'updated_at']) {
      if (columns.includes(timestamp)) {
        names.push(timestamp);
        params[timestamp] = now;
      }
    }
    if (columns.includes('_metadata') && input.metadata !== undefined) {
      names.push('_metadata');
      params['_metadata'] = input.metadata;
    }

    const sql =
      `INSERT INTO ${input.table} (${names.join(', ')})` +
      ` VALUES (${names.map((n) => `:${n}`).join(', ')})` +
      ' RETURNING *';

    return { kind: 'insert', sql, params };
  }

  private buildUpdate(input: SqlBuildInput, columns: readonly string[]): BuiltStatement {
    const id = this.requireId(input, 'an update');
    const body = this.bodyColumns(input, columns, false);

    const assignments = body.names.map((n) => `${n} = :${n}`);
    const params: SqlParams = { ...body.params };

    if (columns.includes('updated_at')) {
      assignments.push('updated_at = :updated_at');
      params['updated_at'] = input.now ?? new Date().toISOString();
    }
    if (columns.includes('_metadata') && input.metadata !== undefined) {
      assignments.push('_metadata = :_metadata');
      params['_metadata'] = input.metadata;
    }
    if (assignments.length === 0) {
      throw new SqlBuildError(
        `An update of ${input.table} would write no column: the request body has ` +
          'no field matching a column of that table.',
      );
    }

    params['id'] = id;
    const sql =
      `UPDATE ${input.table} SET ${assignments.join(', ')}` +
      ' WHERE id = :id RETURNING *';

    return { kind: 'update', sql, params };
  }

  /** Two statements sharing a transaction id, since a DELETE can't carry `_metadata` itself. */
  private buildDelete(
    input: SqlBuildInput,
    columns: readonly string[],
  ): BuiltStatement[] {
    const id = this.requireId(input, 'a delete');
    const statements: BuiltStatement[] = [];

    if (columns.includes('_metadata') && input.metadata !== undefined) {
      statements.push({
        kind: 'mark',
        sql: `UPDATE ${input.table} SET _metadata = :_metadata WHERE id = :id`,
        params: { _metadata: input.metadata, id },
      });
    }
    statements.push({
      kind: 'delete',
      sql: `DELETE FROM ${input.table} WHERE id = :id RETURNING *`,
      params: { id },
    });
    return statements;
  }

  private requireId(input: SqlBuildInput, what: string): string {
    const hole = this.idHole(input);
    if (hole === undefined) {
      throw new SqlBuildError(
        `${input.method.toUpperCase()} on ${input.table} needs ${what}, but the ` +
          'declared path has no hole to identify a row. Declare the path with its ' +
          'id, e.g. /api/.../{id}.',
      );
    }
    return input.pathParams[hole]!;
  }
}

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}
