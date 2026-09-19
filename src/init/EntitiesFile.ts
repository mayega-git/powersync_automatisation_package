import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

import type { EntitiesDeclaration, EntityRule } from '../core/EntityRoutes.js';
import type { ReplicatedSchema } from './ReplicatedSchema.js';

export const ENTITIES_FILE = 'offline-sync.entities.yaml';

export class EntitiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntitiesError';
  }
}

const HEADER = `# Which table for which requests. WRITTEN BY HAND, versioned.
#
# The module intercepts the requests defined below to query the local SQLite database.
#
#   RULE 1, by prefix -- one line covers a whole table:
#       tag_entity: /api/education/tags
#     covers listing, creating, reading one row, updating and deleting it.
#     The longest prefix wins.
#
#   RULE 2, by path and joins -- define an array of endpoints. You can define simple paths
#     or complex queries with JOINs for GET requests:
#       category_entity:
#         - /api/education/categories
#         - /api/education/categories/{id}
#         - path: /api/education/categories/with-tags
#           method: GET
#           joins:
#             - "LEFT JOIN education_tags ON education_tags.category_id = category_entity.id"
#
# WATCH OUT FOR AMBIGUOUS COLUMNS in JOINs: make sure your backend can handle the structure
# returned by SQLite when multiple tables are merged.

entities:
`;

/** Never replaces an existing file: it holds work done by hand. */
export function writeEntitiesTemplate(
  cwd: string,
  schema: ReplicatedSchema,
  path: string = ENTITIES_FILE,
): { path: string; written: boolean; missing: string[] } {
  const fullPath = isAbsolute(path) ? path : join(cwd, path);

  if (existsSync(fullPath)) {
    const existing = new Set(Object.keys(loadEntitiesFrom(fullPath)));
    const missing = schema.tables
      .map((t) => t.name)
      .filter((name) => !existing.has(name));
    return { path: fullPath, written: false, missing };
  }

  const lines = schema.tables.map(
    (t) => `  ${t.name}:  # to fill in: "/api/..." or a list of requests`,
  );
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, HEADER + lines.join('\n') + '\n', 'utf8');
  return { path: fullPath, written: true, missing: [] };
}

export function loadEntities(
  cwd: string,
  path: string = ENTITIES_FILE,
): EntitiesDeclaration {
  const fullPath = isAbsolute(path) ? path : join(cwd, path);
  if (!existsSync(fullPath)) {
    throw new EntitiesError(
      `${path} was not found. Run "offline-sync entities" to write a template ` +
        'from the tables the engine replicates.',
    );
  }
  return loadEntitiesFrom(fullPath);
}

function loadEntitiesFrom(path: string): EntitiesDeclaration {
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new EntitiesError(`${path} is empty or malformed.`);
  }

  const entities = (raw as Record<string, unknown>)['entities'];
  if (entities === undefined || entities === null) {
    throw new EntitiesError(
      `${path} has no "entities:" block. It's the only key expected at the ` +
        'root of the file.',
    );
  }
  if (typeof entities !== 'object' || Array.isArray(entities)) {
    throw new EntitiesError(
      `The "entities:" block of ${path} isn't a list of tables. Expected ` +
        'form: a table name, then a prefix or a list of requests.',
    );
  }

  const out: Record<string, EntityRule> = {};
  for (const [table, rule] of Object.entries(entities as Record<string, unknown>)) {
    if (rule === null || rule === undefined) {
      continue;
    }
    if (typeof rule === 'string') {
      out[table] = rule;
      continue;
    }
    if (Array.isArray(rule)) {
      out[table] = rule.map((l) => {
        if (typeof l === 'string') return String(l);
        if (typeof l === 'object' && l !== null) {
          const obj = l as Record<string, unknown>;
          return {
            path: String(obj['path']),
            method: obj['method'] ? String(obj['method']) : undefined,
            joins: Array.isArray(obj['joins']) ? obj['joins'].map(String) : undefined,
            aggregates: Array.isArray(obj['aggregates'])
              ? obj['aggregates'].map((a: any) => ({
                  field: String(a.field),
                  table: String(a.table),
                  on: String(a.on),
                }))
              : undefined,
            select: obj['select'] ? String(obj['select']) : undefined,
            params:
              typeof obj['params'] === 'object' && obj['params'] !== null
                ? Object.fromEntries(
                    Object.entries(obj['params'] as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
                  )
                : undefined,
          };
        }
        throw new EntitiesError(`Invalid rule format for ${table}`);
      });
      continue;
    }
    throw new EntitiesError(
      `Table ${table} declares something other than a prefix or a list of ` +
        `requests in ${path}.`,
    );
  }

  return out;
}

/**
 * The TypeScript transcription the application imports, since the browser
 * doesn't read a file off disk -- only what the bundler put in the package.
 * Rewritten by "entities" and by "check-entities", so the two files can't diverge.
 */
export function writeEntitiesModule(
  declaration: EntitiesDeclaration,
  path: string,
  generatedAt: string,
): void {
  const lines = Object.entries(declaration).map(([table, rule]) =>
    typeof rule === 'string'
      ? `  ${table}: ${JSON.stringify(rule)},`
      : `  ${table}: [\n${rule
          .map((l) => `    ${JSON.stringify(l)},`)
          .join('\n')}\n  ],`,
  );

  const content = `/* eslint-disable */
/**
 * GENERATED from ${ENTITIES_FILE} on ${generatedAt}.
 *
 * DO NOT EDIT: this file is the transcription of the YAML, rewritten on
 * every "offline-sync entities" and "offline-sync check-entities". The YAML is
 * the only thing written by hand.
 */
import type { EntitiesDeclaration } from '@ksm/offline-sync';

export const entities: EntitiesDeclaration = {
${lines.join('\n')}
};
`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Declared paths, flattened: what `check` looks for in the code. */
export function declaredPaths(declaration: EntitiesDeclaration): string[] {
  const paths: string[] = [];
  for (const rule of Object.values(declaration)) {
    if (typeof rule === 'string') {
      paths.push(rule);
      continue;
    }
    for (const line of rule) {
      if (typeof line === 'string') {
        const parts = line.trim().split(/\s+/);
        if (parts.length === 2) paths.push(parts[1]!);
        else if (parts.length === 1) paths.push(parts[0]!);
      } else if (typeof line === 'object' && line !== null) {
        paths.push(line.path);
      }
    }
  }
  return paths;
}
