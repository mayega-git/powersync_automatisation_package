import pg from 'pg';
import type { Projection } from '../ir/types.js';

const COMPATIBLE: Readonly<Record<string, readonly string[]>> = {
  uuid: ['uuid'],
  string: ['text', 'character varying', 'character', 'citext', 'USER-DEFINED', 'uuid'],
  enum: ['text', 'character varying', 'character', 'USER-DEFINED', 'smallint', 'integer'],
  integer: ['smallint', 'integer', 'bigint', 'numeric'],
  decimal: ['numeric', 'double precision', 'real', 'integer', 'bigint', 'smallint', 'money'],
  boolean: ['boolean'],
  'datetime-local': ['timestamp without time zone'],
  datetime: ['timestamp with time zone', 'timestamp without time zone'],
  date: ['date'],
  time: ['time without time zone', 'time with time zone'],
  json: ['json', 'jsonb', 'text', 'ARRAY'],
};

/**
 * Compares projections with the live database schema. Returns entity -> problem
 * for every projection whose table or columns are missing or incompatible.
 */
export async function checkProjections(databaseUrl: string, projections: readonly Projection[]): Promise<Map<string, string>> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const { rows } = await pool.query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(
      'SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns',
    );
    const tables = new Map<string, Map<string, string>>();
    for (const row of rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!tables.has(key)) tables.set(key, new Map());
      tables.get(key)!.set(row.column_name, row.data_type);
    }
    const problems = new Map<string, string>();
    for (const projection of projections) {
      const name = `${projection.schema ?? 'public'}.${projection.table}`;
      const columns = tables.get(name);
      if (columns === undefined) {
        problems.set(projection.entity, `Table ${name} does not exist in the database.`);
        continue;
      }
      const issues: string[] = [];
      for (const column of projection.columns) {
        const actual = columns.get(column.column);
        if (actual === undefined) issues.push(`missing column ${column.column}`);
        else if (column.type.list === true ? actual !== 'ARRAY' && actual !== 'jsonb' && actual !== 'json' : !(COMPATIBLE[column.type.type] ?? []).includes(actual)) {
          issues.push(`${column.column} is ${actual}, expected ${column.type.type}`);
        }
      }
      if (issues.length > 0) problems.set(projection.entity, `${name} does not match the entity mapping: ${issues.slice(0, 5).join('; ')}.`);
    }
    return problems;
  } finally {
    await pool.end();
  }
}
