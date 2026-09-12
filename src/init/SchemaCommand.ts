import { join } from 'node:path';

import { loadConfig } from './ConfigLoader.js';
import { fetchReplicatedSchema, type ReplicatedSchemaSource } from './AdminSchemaSource.js';
import { guessTable, resolveTable } from './OperationDraftBuilder.js';
import { loadOperations } from './OperationsDocument.js';
import {
  filterByBuckets,
  SchemaError,
  writeSchemaFile,
  type ReplicatedSchema,
} from './ReplicatedSchema.js';
import { NO_TOKEN_MESSAGE, resolveAdminToken } from './SecretsFile.js';
import { normalizePath } from './OperationDraftBuilder.js';
import type { OperationRow, SyncConfig } from './types.js';

export { ADMIN_TOKEN_KEY as TOKEN_ENV } from './SecretsFile.js';

export interface SchemaOptions {
  cwd: string;
  loadConfigFn?: (cwd: string) => SyncConfig;
  loadOperationsFn?: (cwd: string, path?: string) => OperationRow[];
  fetchSchemaFn?: ReplicatedSchemaSource;
  token?: string;
}

/** A guessed name that no replicated table answers to. */
export interface UnresolvedTable {
  table: string;
  operations: number;
}

export interface SchemaResult {
  generatedAt: string;
  /** The retained schema, after bucket filtering. */
  schema: ReplicatedSchema;
  /** Buckets declared in the configuration. Empty = all. */
  buckets: readonly string[];
  schemaFile: string;
  /** How many operations the table declares. 0 if it doesn't exist yet. */
  operations: number;
  /** How many of them now find their table. */
  resolved: number;
  /** Guessed names still unanswered, most requested first. */
  unresolved: readonly UnresolvedTable[];
}

export async function generateSchema(options: SchemaOptions): Promise<SchemaResult> {
  const cwd = options.cwd;
  const config = (options.loadConfigFn ?? loadConfig)(cwd);

  const powersync = config.powersync;
  if (powersync === undefined) {
    throw new SchemaError(
      'The "powersync" block is missing from the configuration. Set at least ' +
        'powersync.adminUrl -- the sync engine\'s admin API URL. Without it, ' +
        'there is nobody to ask for the tables.',
    );
  }

  const token = resolveAdminToken(cwd, options.token);
  if (token === undefined) {
    throw new SchemaError(NO_TOKEN_MESSAGE);
  }

  const full = await (options.fetchSchemaFn ?? fetchReplicatedSchema)({
    adminUrl: powersync.adminUrl,
    token,
  });

  const schema = filterByBuckets(full, powersync.buckets);

  const generatedAt = new Date().toISOString();
  const schemaFile = powersync.schemaFile;
  writeSchemaFile(schema, generatedAt, join(cwd, schemaFile));

  const comparison = compare(cwd, config, schema, options);

  return { generatedAt, schema, buckets: powersync.buckets, schemaFile, ...comparison };
}

/**
 * Compares the retained schema against what the platform actually calls.
 * Absence of the operations table is not an error: `schema` can run before it.
 */
function compare(
  cwd: string,
  config: SyncConfig,
  schema: ReplicatedSchema,
  options: SchemaOptions,
): Pick<SchemaResult, 'operations' | 'resolved' | 'unresolved'> {
  let rows: OperationRow[];
  try {
    rows = (options.loadOperationsFn ?? loadOperations)(cwd, config.operations);
  } catch {
    return { operations: 0, resolved: 0, unresolved: [] };
  }

  let resolved = 0;
  const missing = new Map<string, number>();

  for (const row of rows) {
    const { path } = normalizePath(row.path);
    const guessed = guessTable(path);
    if (resolveTable(guessed, schema).origin === 'schema') {
      resolved += 1;
    } else {
      missing.set(guessed, (missing.get(guessed) ?? 0) + 1);
    }
  }

  const unresolved = [...missing.entries()]
    .map(([table, operations]) => ({ table, operations }))
    .sort((a, b) => b.operations - a.operations || a.table.localeCompare(b.table));

  return { operations: rows.length, resolved, unresolved };
}
