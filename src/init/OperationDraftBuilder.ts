// Compatibility stub after the matching system was removed.
//
// `guessTable`, `resolveTable` and `normalizePath` were used by the `schema`
// command to cross-reference operations with the schema. This stub keeps
// their signature so imports don't break.

import type { ReplicatedSchema } from './ReplicatedSchema.js';

export interface NormalizedPath {
  path: string;
  paramNames: string[];
}

/** Guesses a table name from the path: the last meaningful segment. */
export function guessTable(path: string): string {
  const segments = path.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!;
    if (!s.startsWith('{') && !s.startsWith('$')) return s;
  }
  return 'unknown';
}

/** Resolves a table name against the schema. Origin is 'schema' or 'guess'. */
export function resolveTable(
  name: string,
  schema: ReplicatedSchema,
): { name: string; origin: 'schema' | 'guess' } {
  const found = Object.keys(schema.tables).find((t) => t === name || t.endsWith(name));
  return found !== undefined
    ? { name: found, origin: 'schema' }
    : { name, origin: 'guess' };
}

/** Normalizes an HTTP path, replacing holes with {name}. */
export function normalizePath(raw: string): NormalizedPath {
  const withoutQuery = raw.split('?')[0] ?? '';
  const paramNames: string[] = [];
  const path = withoutQuery
    .split('/')
    .map((s) => {
      const m = s.match(/^\$?\{([^}]+)\}$/) ?? s.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
      if (m) {
        paramNames.push(m[1]!);
        return `{${m[1]}}`;
      }
      return s;
    })
    .join('/');
  return { path, paramNames };
}

/** Builds operation drafts from table rows. */
export function draftsFromRows(
  _rows: import('./types.js').OperationRow[],
  _shapes: Map<string, string>,
  _schema?: ReplicatedSchema,
): import('./types.js').OperationDraft[] {
  return [];
}
