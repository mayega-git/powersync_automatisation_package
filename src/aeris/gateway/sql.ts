import type { AerisArtifact, Projection } from '../ir/types.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

export function qualifiedTable(projection: Pick<Projection, 'schema' | 'table'>): string {
  return projection.schema === undefined ? quoteIdent(projection.table) : `${quoteIdent(projection.schema)}.${quoteIdent(projection.table)}`;
}

/** Name used in the change log for a projection's table (schema.table, as TG_TABLE_SCHEMA.TG_TABLE_NAME). */
export function logTableName(projection: Pick<Projection, 'schema' | 'table'>): string {
  return `${projection.schema ?? 'public'}.${projection.table}`;
}

/** Lock id serializing change sequencing with commits. */
export const SEQUENCE_LOCK = 7212041;

/**
 * Idempotent setup of the gateway schema: change log with commit-ordered
 * sequence numbers, capture triggers on every projected table, and the
 * operation registry. Run by a role that owns the projected tables.
 */
export function setupSql(artifact: AerisArtifact, schema = 'aeris'): string {
  const s = quoteIdent(schema);
  const statements = [
    `CREATE SCHEMA IF NOT EXISTS ${s};`,
    `CREATE SEQUENCE IF NOT EXISTS ${s}.change_seq;`,
    `CREATE TABLE IF NOT EXISTS ${s}.change_log (
  id bigserial PRIMARY KEY,
  seq bigint,
  table_name text NOT NULL,
  row_key text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS change_log_seq_idx ON ${s}.change_log (seq);`,
    `CREATE INDEX IF NOT EXISTS change_log_changed_at_idx ON ${s}.change_log (changed_at);`,
    `CREATE TABLE IF NOT EXISTS ${s}.meta (key text PRIMARY KEY, value text NOT NULL);`,
    `CREATE TABLE IF NOT EXISTS ${s}.operations (
  subject text NOT NULL,
  operation_id text NOT NULL,
  endpoint text NOT NULL,
  status text NOT NULL,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, operation_id)
);`,
    // Row capture: one log row per changed key (and the old key when a key changes).
    `CREATE OR REPLACE FUNCTION ${s}.capture_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  key_column text := TG_ARGV[0];
  old_key text;
  new_key text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_key := to_jsonb(OLD) ->> key_column; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_key := to_jsonb(NEW) ->> key_column; END IF;
  IF old_key IS NOT NULL AND old_key IS DISTINCT FROM new_key THEN
    INSERT INTO ${s}.change_log (table_name, row_key) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, old_key);
  END IF;
  IF new_key IS NOT NULL THEN
    INSERT INTO ${s}.change_log (table_name, row_key) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, new_key);
  END IF;
  RETURN NULL;
END $$;`,
    // Sequence numbers are taken at commit, under a transaction-scoped lock held until
    // the commit completes: readers never observe seq N+1 before seq N is visible.
    `CREATE OR REPLACE FUNCTION ${s}.sequence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(${SEQUENCE_LOCK});
  UPDATE ${s}.change_log SET seq = nextval('${schema}.change_seq') WHERE id = NEW.id AND seq IS NULL;
  RETURN NULL;
END $$;`,
    `DROP TRIGGER IF EXISTS aeris_sequence ON ${s}.change_log;`,
    `CREATE CONSTRAINT TRIGGER aeris_sequence AFTER INSERT ON ${s}.change_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${s}.sequence_change();`,
  ];
  const seen = new Set<string>();
  for (const projection of artifact.projections) {
    const table = qualifiedTable(projection);
    if (seen.has(table)) continue;
    seen.add(table);
    const keyColumn = projection.columns.find((column) => column.name === projection.key)!.column;
    statements.push(`DROP TRIGGER IF EXISTS aeris_capture ON ${table};`);
    statements.push(`CREATE TRIGGER aeris_capture AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${s}.capture_change('${keyColumn}');`);
  }
  return `${statements.join('\n\n')}\n`;
}
