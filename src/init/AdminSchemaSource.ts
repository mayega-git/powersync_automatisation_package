import type { ReplicatedColumn, ReplicatedSchema, ReplicatedTable, SqliteType } from './ReplicatedSchema.js';
import { SchemaError } from './ReplicatedSchema.js';
import { readBuckets, readStructure } from './SyncRulesReader.js';

export interface AdminApiOptions {
  adminUrl: string;
  /** The engine's admin token, one of the `api.tokens` values in its configuration. */
  token: string;
}

/** `schema` depends only on this signature, never on how the result was obtained. */
export type ReplicatedSchemaSource = (options: AdminApiOptions) => Promise<ReplicatedSchema>;

/**
 * Shape of the sync-rules-analysis library, reduced to what's called. Loaded
 * on demand, declared as an optional dependency: the module stays one npm
 * package, and an app that never runs `schema` doesn't need to install it.
 */
interface RulesAnalyzer {
  StaticSchema: new (connections: unknown) => object;
  SqlSyncRules: {
    fromYaml(
      yaml: string,
      options: { defaultSchema: string; schema: object },
    ): { config: { bucketSources: readonly BucketSource[] } };
  };
  sqlTypeName(definition: unknown): SqliteType;
}

interface BucketSource {
  readonly name: string;
  readonly dataSources: readonly {
    resolveResultSets(schema: object, tables: Record<string, Record<string, unknown>>): void;
  }[];
}

const ANALYZER_PACKAGE = '@powersync/service-sync-rules';

export const fetchReplicatedSchema: ReplicatedSchemaSource = async (options) => {
  const base = options.adminUrl.replace(/\/+$/, '');

  const structure = await call(base, options.token, '/api/admin/v1/schema', {});
  const diagnostics = await call(base, options.token, '/api/admin/v1/diagnostics', {
    sync_rules_content: true,
  });

  const rules = readRulesText(diagnostics);

  const payload = unwrap(structure);
  const connections = (payload as { connections?: unknown }).connections;
  const defaultSchema =
    typeof (payload as { defaultSchema?: unknown }).defaultSchema === 'string'
      ? (payload as { defaultSchema: string }).defaultSchema
      : 'public';

  const analyzer = await loadAnalyzer();

  const tables =
    analyzer !== undefined
      ? viaLibrary(analyzer, connections, defaultSchema, rules)
      : viaLocalReader(connections, rules);

  return { source: base, tables, analyzedBy: analyzer !== undefined ? 'library' : 'local-reader' };
};

/** Reference path: the same library the engine uses itself, one bucket at a time. */
function viaLibrary(
  analyzer: RulesAnalyzer,
  connections: unknown,
  defaultSchema: string,
  rules: string,
): ReplicatedTable[] {
  const staticSchema = new analyzer.StaticSchema(connections);
  const { config } = analyzer.SqlSyncRules.fromYaml(rules, { defaultSchema, schema: staticSchema });

  const byName = new Map<string, ReplicatedTable>();

  for (const bucket of config.bucketSources) {
    const found: Record<string, Record<string, unknown>> = {};
    for (const source of bucket.dataSources) {
      source.resolveResultSets(staticSchema, found);
    }

    for (const [name, columns] of Object.entries(found)) {
      const table = keep(byName, name, bucket.name);
      for (const definition of Object.values(columns)) {
        add(table, toColumn(definition, analyzer));
      }
    }
  }

  return [...byName.values()];
}

/** Fallback path: read the rules with what's already installed. */
function viaLocalReader(connections: unknown, rules: string): ReplicatedTable[] {
  const structure = readStructure(connections);
  const byName = new Map<string, ReplicatedTable>();

  for (const bucket of readBuckets(rules)) {
    for (const cited of bucket.tables) {
      const table = keep(byName, cited.local, bucket.name);
      const real = structure.get(cited.source) ?? [];

      if (cited.columns === undefined) {
        for (const column of real) add(table, column);
      } else {
        for (const name of cited.columns) {
          add(table, real.find((c) => c.name === name) ?? { name, type: 'text' });
        }
      }
    }
  }

  return [...byName.values()];
}

/** A table cited in several buckets gives only ONE table client-side. */
function keep(
  byName: Map<string, ReplicatedTable>,
  name: string,
  bucket: string,
): ReplicatedTable {
  const existing = byName.get(name);
  const table: ReplicatedTable = existing ?? { name, columns: [], buckets: [] };
  if (existing === undefined) byName.set(name, table);
  if (!table.buckets.includes(bucket)) table.buckets.push(bucket);
  return table;
}

function add(table: ReplicatedTable, column: ReplicatedColumn | undefined): void {
  if (column === undefined) return;
  if (!table.columns.some((c) => c.name === column.name)) table.columns.push(column);
}

async function call(
  base: string,
  token: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SchemaError(
      `The sync engine is unreachable at ${base} ` +
        `(${err instanceof Error ? err.message : String(err)}). "schema" is the ` +
        'ONLY command that requires the engine to be running.',
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new SchemaError(
      `The engine's admin API refused the token (${response.status}). Check that ` +
        'PS_ADMIN_TOKEN matches one of the values declared under "api.tokens" ' +
        "in the engine's configuration.",
    );
  }
  if (!response.ok) {
    throw new SchemaError(`The engine's admin API returned ${response.status} on ${path}.`);
  }
  return response.json();
}

/** Accepts both `{"data": {...}}` and the bare object: the wrapper varies by version. */
function unwrap(response: unknown): Record<string, unknown> {
  const obj = (response ?? {}) as Record<string, unknown>;
  const inner = obj['data'];
  return typeof inner === 'object' && inner !== null
    ? (inner as Record<string, unknown>)
    : obj;
}

function readRulesText(diagnostics: unknown): string {
  const active = (unwrap(diagnostics) as { active_sync_rules?: { content?: unknown } })
    ?.active_sync_rules;
  const content = active?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new SchemaError(
      'The engine declares no active sync rules. Nothing is replicated, so no ' +
        'table can be declared.',
    );
  }
  return content;
}

/** Absence is not an error: the library uses `using` declarations Node 20 can't parse. */
async function loadAnalyzer(): Promise<RulesAnalyzer | undefined> {
  try {
    return (await import(ANALYZER_PACKAGE)) as unknown as RulesAnalyzer;
  } catch {
    return undefined;
  }
}

function toColumn(definition: unknown, analyzer: RulesAnalyzer): ReplicatedColumn | undefined {
  const name = (definition as { name?: unknown })?.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  return { name, type: analyzer.sqlTypeName(definition) };
}
