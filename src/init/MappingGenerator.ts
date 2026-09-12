import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig } from './ConfigLoader.js';
import { readSchemaFile, SCHEMA_FILE, type ReplicatedSchema } from './ReplicatedSchema.js';
import { loadOperations, OPERATIONS_FILE_NAME } from './OperationsDocument.js';
import { draftsFromRows } from './OperationDraftBuilder.js';
import { writeHandlerStub, HANDLERS_FILE } from './HandlerTemplateGenerator.js';
import { fetchDocumentation } from './OpenApiSource.js';
import type {
  OpenApiOperation,
  OperationDraft,
  OperationRow,
  SyncConfig,
} from './types.js';

export const STUB_FILE = 'offline-map.stub.ts';
export { HANDLERS_FILE };

export interface GenerateOptions {
  cwd: string;
  /** Where to write the generated files, relative to cwd. */
  outDir?: string;
  loadConfigFn?: (cwd: string) => SyncConfig;
  loadOperationsFn?: (cwd: string, path?: string) => OperationRow[];
  fetchDocumentationFn?: typeof fetchDocumentation;
  readSchemaFn?: (cwd: string, path: string) => ReplicatedSchema | undefined;
}

export interface GenerateResult {
  generatedAt: string;
  operations: readonly OperationDraft[];
  /** How many carry a server endpoint -- the rest aggregate, which is normal. */
  withServerPath: number;
  /** How many got a response shape from the documentation. */
  withResponseShape: number;
  /** How many carry a table name READ from the schema, not guessed. */
  withResolvedTable: number;
  schema?: ReplicatedSchema;
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const cwd = options.cwd;
  const config = (options.loadConfigFn ?? loadConfig)(cwd);
  const rows = (options.loadOperationsFn ?? loadOperations)(cwd, config.operations);

  const selected = await readDocumentation(config, options);
  const shapes = responseShapes(selected);

  const schema = readSchema(config, cwd, options);

  const drafts = draftsFromRows(rows, shapes, schema);
  const generatedAt = new Date().toISOString();

  const outDir = join(cwd, options.outDir ?? '.');
  writeOfflineMapStub(drafts, generatedAt, join(outDir, STUB_FILE));
  writeHandlerStub(drafts, generatedAt, join(outDir, HANDLERS_FILE));

  return {
    generatedAt,
    operations: drafts,
    withServerPath: drafts.filter((d) => d.serverPath !== undefined).length,
    withResponseShape: drafts.filter((d) => d.responseShape !== undefined).length,
    withResolvedTable: drafts.filter((d) => d.tableOrigin === 'schema').length,
    ...(schema !== undefined ? { schema } : {}),
  };
}

/** Absence is not an error: it means "schema" hasn't run yet, and drafts fall back to guessed names. */
function readSchema(
  config: SyncConfig,
  cwd: string,
  options: GenerateOptions,
): ReplicatedSchema | undefined {
  const path = config.powersync?.schemaFile ?? SCHEMA_FILE;
  try {
    return (options.readSchemaFn ?? readSchemaFile)(cwd, path);
  } catch (err) {
    console.warn(
      `${path} is unreadable: ${err instanceof Error ? err.message : String(err)}\n` +
        'Drafts will come out with guessed table names.',
    );
    return undefined;
  }
}

/** Keyed by server `METHOD path`: same key on both sides, so it's an equality, not a match. */
function responseShapes(operations: readonly OpenApiOperation[]): Map<string, string> {
  const shapes = new Map<string, string>();
  for (const op of operations) {
    if (op.responseSuccess !== undefined) {
      shapes.set(`${op.method.toUpperCase()} ${op.path}`, op.responseSuccess);
    }
  }
  return shapes;
}

/** Optional: a stopped server must not fail the command, only the response shapes are missing. */
async function readDocumentation(
  config: SyncConfig,
  options: GenerateOptions,
): Promise<OpenApiOperation[]> {
  if (config.docSource === undefined || config.docSource.length === 0) return [];
  try {
    const doc = await (options.fetchDocumentationFn ?? fetchDocumentation)(config.docSource);
    return doc.operations;
  } catch (err) {
    console.warn(
      `Server documentation unreachable (${config.docSource}): ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        'The map and templates are produced anyway -- they will just be ' +
        'missing the response shapes.',
    );
    return [];
  }
}

/**
 * No longer a DRAFT: nothing is left to fill in. Everything comes from the
 * table -- connectivity is declared there, `handle` designates the template
 * of the same name, `serverPath` comes from the match. This file is an
 * OUTPUT: rewritten every time, never edited.
 */
export function writeOfflineMapStub(
  drafts: readonly OperationDraft[],
  generatedAt: string,
  path: string,
): void {
  const entries = drafts.map((draft) => {
    const lines: string[] = [];
    if (draft.callSites.length > 0) {
      lines.push(`    // called from ${draft.callSites.join(', ')}`);
    }
    if (draft.documentedAs !== undefined) {
      lines.push(`    // server endpoint: ${draft.documentedAs}`);
    } else {
      lines.push('    // no server endpoint declared (aggregation, or out of scope)');
    }
    if (draft.uncertainSegments.length > 0) {
      lines.push(
        `    // ⚠ poorly understood path segment(s): ${draft.uncertainSegments.join(', ')}`,
      );
    }

    const server =
      draft.serverPath !== undefined
        ? `\n    serverPath: ${JSON.stringify(draft.serverPath)},`
        : '';

    return `  {
${lines.join('\n')}
    operationId: ${JSON.stringify(draft.handlerName)},
    method: ${JSON.stringify(draft.method)},
    path: ${JSON.stringify(draft.path)},${server}
    connectivity: ${JSON.stringify(draft.connectivity ?? 'offline')},
    handle: ${JSON.stringify(draft.handlerName)},
  },`;
  });

  const online = drafts.filter((d) => d.connectivity === 'online').length;

  const header = `/* eslint-disable */
/**
 * GENERATED by "offline-sync discover" on ${generatedAt}.
 *
 * DO NOT EDIT: this file is rewritten in full on every run, and there's
 * nothing to fill in. Everything comes from ${OPERATIONS_FILE_NAME} -- fix
 * it there.
 *
 * ${drafts.length} operation(s): ${drafts.length - online} offline, ${online} online.
 *
 * The "handle" field designates the template of the same name in
 * ${HANDLERS_FILE}, produced by the same command from the same list.
 */
import type { OfflineMap } from '@ksm/offline-sync';

export const offlineMap: OfflineMap = {
  operations: [
`;

  const footer = `  ],
};
`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, header + entries.join('\n') + '\n' + footer, 'utf8');
}
