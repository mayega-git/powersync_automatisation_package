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

export interface ColumnConstraints {
  maxLength?: number;
  notNull: boolean;
  /** Part of a foreign key, unique constraint or check constraint: only the server can validate it. */
  serverChecked: string[];
}

/** Constraints the database enforces on each projected column (entity -> column -> constraints). */
export async function readConstraints(databaseUrl: string, projections: readonly Projection[]): Promise<Map<string, Map<string, ColumnConstraints>>> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const columns = await pool.query<{ table_schema: string; table_name: string; column_name: string; is_nullable: string; character_maximum_length: number | null; column_default: string | null }>(
      'SELECT table_schema, table_name, column_name, is_nullable, character_maximum_length, column_default FROM information_schema.columns',
    );
    // pg_constraint, not information_schema: the latter also reports NOT NULL as CHECK constraints.
    const constraints = await pool.query<{ table_schema: string; table_name: string; column_name: string; constraint_type: string }>(
      `SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name,
              CASE con.contype WHEN 'f' THEN 'FOREIGN KEY' WHEN 'u' THEN 'UNIQUE' ELSE 'CHECK' END AS constraint_type
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN LATERAL unnest(con.conkey) AS k(attnum) ON TRUE
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE con.contype IN ('f', 'u', 'c')`,
    );
    const byTable = new Map<string, Map<string, ColumnConstraints>>();
    for (const row of columns.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      if (!byTable.has(key)) byTable.set(key, new Map());
      byTable.get(key)!.set(row.column_name, {
        ...(row.character_maximum_length === null ? {} : { maxLength: row.character_maximum_length }),
        // Spring Data R2DBC omits null columns on INSERT, so a DEFAULT fills them: only
        // NOT NULL columns without a default reject a null.
        notNull: row.is_nullable === 'NO' && row.column_default === null,
        serverChecked: [],
      });
    }
    for (const row of constraints.rows) {
      const column = byTable.get(`${row.table_schema}.${row.table_name}`)?.get(row.column_name);
      if (column !== undefined && !column.serverChecked.includes(row.constraint_type)) column.serverChecked.push(row.constraint_type);
    }
    const out = new Map<string, Map<string, ColumnConstraints>>();
    for (const projection of projections) {
      const table = byTable.get(`${projection.schema ?? 'public'}.${projection.table}`);
      if (table !== undefined) out.set(projection.entity, table);
    }
    return out;
  } finally {
    await pool.end();
  }
}

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
