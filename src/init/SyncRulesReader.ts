import { load as parseYaml } from 'js-yaml';

import type { ReplicatedColumn, SqliteType } from './ReplicatedSchema.js';

const TYPE_TEXT = 2;
const TYPE_INTEGER = 4;
const TYPE_REAL = 8;

/** A replicated table, as a data query designates it. */
export interface CitedTable {
  /** Database-side name. */
  source: string;
  /** Device-side name: the alias when there is one, otherwise the same. */
  local: string;
  /** Enumerated columns. Absent on a `SELECT *`. */
  columns?: string[];
  /** What the query contained that this reader couldn't parse. */
  unresolved?: string;
}

export interface ReadBucket {
  name: string;
  tables: CitedTable[];
}

/** The database's real structure, keyed by table name. Expands the `SELECT *` queries. */
export function readStructure(connections: unknown): Map<string, ReplicatedColumn[]> {
  const byTable = new Map<string, ReplicatedColumn[]>();
  if (!Array.isArray(connections)) return byTable;

  for (const connection of connections) {
    const schemas = (connection as { schemas?: unknown })?.schemas;
    if (!Array.isArray(schemas)) continue;

    for (const schema of schemas) {
      const tables = (schema as { tables?: unknown })?.tables;
      if (!Array.isArray(tables)) continue;

      for (const table of tables) {
        const name = (table as { name?: unknown })?.name;
        const columns = (table as { columns?: unknown })?.columns;
        if (typeof name !== 'string' || !Array.isArray(columns)) continue;

        byTable.set(
          name,
          columns
            .map((c) => toColumn(c))
            .filter((c): c is ReplicatedColumn => c !== undefined),
        );
      }
    }
  }
  return byTable;
}

function toColumn(raw: unknown): ReplicatedColumn | undefined {
  const name = (raw as { name?: unknown })?.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  return { name, type: toType((raw as { sqlite_type?: unknown }).sqlite_type) };
}

/** An unknown type becomes `text`, the engine's own choice: nothing is lost that way. */
function toType(raw: unknown): SqliteType {
  if (typeof raw === 'number') {
    if (raw & TYPE_INTEGER) return 'integer';
    if (raw & TYPE_REAL) return 'real';
    if (raw & TYPE_TEXT) return 'text';
    return 'text';
  }
  if (typeof raw === 'string') {
    const lower = raw.toLowerCase();
    if (lower === 'integer') return 'integer';
    if (lower === 'real') return 'real';
  }
  return 'text';
}

/** Buckets declared by the rules, one at a time, keeping each name. */
export function readBuckets(yamlText: string): ReadBucket[] {
  const root = parseYaml(yamlText);
  if (typeof root !== 'object' || root === null) return [];

  const raw =
    (root as Record<string, unknown>)['bucket_definitions'] ??
    (root as Record<string, unknown>)['streams'];
  if (typeof raw !== 'object' || raw === null) return [];

  const buckets: ReadBucket[] = [];
  for (const [name, definition] of Object.entries(raw as Record<string, unknown>)) {
    const data = (definition as { data?: unknown })?.data;
    if (!Array.isArray(data)) continue;

    const tables: CitedTable[] = [];
    for (const query of data) {
      if (typeof query !== 'string') continue;
      const cited = readQuery(query);
      if (cited !== undefined) tables.push(cited);
    }
    if (tables.length > 0) buckets.push({ name, tables });
  }
  return buckets;
}

/** The `WHERE` clause is dropped first: it picks rows, never columns. */
export function readQuery(sql: string): CitedTable | undefined {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const split = /^select\s+(.+?)\s+from\s+(.+)$/i.exec(flat);
  if (split === null) return undefined;

  const selectList = split[1]!.trim();
  const afterFrom = split[2]!
    .replace(/\s+(where|group\s+by|order\s+by|limit|having)\b.*$/i, '')
    .trim();

  const words = afterFrom.split(' ').filter((w) => w.length > 0);
  const table = words[0];
  if (table === undefined) return undefined;

  const alias = words[1]?.toLowerCase() === 'as' ? words[2] : words[1];

  const source = identifier(table);
  const local = alias !== undefined ? identifier(alias) : source;

  if (selectList === '*') return { source, local };

  const columns = readSelectList(selectList);
  return columns === undefined
    ? { source, local, unresolved: selectList }
    : { source, local, columns };
}

/** `undefined` as soon as a piece isn't a plain column name: a computed expression, a function. */
function readSelectList(list: string): string[] | undefined {
  const parts = list.split(',').map((p) => p.trim());
  const names: string[] = [];

  for (const part of parts) {
    if (part.length === 0 || part.includes('(') || part === '*') return undefined;

    const words = part.split(' ').filter((w) => w.length > 0);
    const name =
      words.length === 1
        ? words[0]
        : words[words.length - 2]?.toLowerCase() === 'as'
          ? words[words.length - 1]
          : undefined;

    if (name === undefined) return undefined;
    names.push(identifier(name));
  }
  return names;
}

/** `public."tag_entity"` becomes `tag_entity`. */
function identifier(raw: string): string {
  const last = raw.split('.').pop() ?? raw;
  return last.replace(/^["`\[]|["`\]]$/g, '');
}
