import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { declaredPaths } from './EntitiesFile.js';
import { EntityRoutes, EntityRoutesError } from '../core/EntityRoutes.js';
import type { EntitiesDeclaration } from '../core/EntityRoutes.js';
import type { ReplicatedSchema } from './ReplicatedSchema.js';

export interface EntitiesFinding {
  message: string;
  /** The table or path concerned, to sort the report. */
  subject: string;
}

export interface EntitiesCheckResult {
  tables: string[];
  paths: string[];
  errors: EntitiesFinding[];
  ok: boolean;
}

export interface EntitiesCheckOptions {
  cwd: string;
  declaration: EntitiesDeclaration;
  schema: ReplicatedSchema | undefined;
  /** Where to look for paths: `routes.browser` from the configuration. */
  directories: readonly string[];
  /** Overridable in tests, so they don't depend on disk. */
  pathsInCodeFn?: (cwd: string, directories: readonly string[]) => Set<string>;
}

export function checkEntities(options: EntitiesCheckOptions): EntitiesCheckResult {
  const errors: EntitiesFinding[] = [];
  const tables = Object.keys(options.declaration);
  const paths = declaredPaths(options.declaration);

  try {
    EntityRoutes.build(options.declaration);
  } catch (err) {
    if (err instanceof EntityRoutesError) {
      errors.push({ subject: 'declaration', message: err.message });
    } else {
      throw err;
    }
  }

  if (options.schema === undefined) {
    errors.push({
      subject: 'schema',
      message:
        'The schema file was not found: cannot verify that the declared ' +
        'tables exist. Run "offline-sync schema" -- it requires a running ' +
        'engine, but its result is versioned.',
    });
  } else {
    const known = new Set(options.schema.tables.map((t) => t.name));
    for (const table of tables) {
      if (known.has(table)) continue;
      errors.push({
        subject: table,
        message:
          `Table "${table}" is not replicated by the engine. Known tables: ` +
          `${[...known].join(', ') || '(none)'}. A missing table will never ` +
          'receive anything, and nothing will say so at runtime.',
      });
    }
  }

  const inCode = (options.pathsInCodeFn ?? pathsInCode)(
    options.cwd,
    options.directories,
  );
  for (const path of paths) {
    const shape = pathShape(path);
    const found =
      inCode.has(shape) || [...inCode].some((c) => c.startsWith(shape + '/'));
    if (found) continue;
    errors.push({
      subject: path,
      message:
        `Path "${path}" doesn't appear anywhere in ${options.directories.join(', ')}. ` +
        'No request will ever use it, so nothing will be intercepted. Check ' +
        'the spelling, or the directory where browser calls live.',
    });
  }

  return { tables, paths, errors, ok: errors.length === 0 };
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo',
]);

/** Every source file under a set of directories, regardless of file naming patterns. */
function collectFiles(cwd: string, include: readonly string[]): string[] {
  const found = new Set<string>();
  for (const pattern of include) {
    const base = pattern.split(/[*?[]/)[0] ?? '';
    const start = join(cwd, base.endsWith(sep) ? base.slice(0, -1) : base);
    walk(start, found);
  }
  return [...found].sort();
}

function walk(path: string, out: Set<string>): void {
  let info;
  try {
    info = statSync(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (SOURCE_EXTENSIONS.some((e) => path.endsWith(e))) out.add(path);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    walk(join(path, entry), out);
  }
}

const QUERY_INTERPOLATION = /\$\{\s*(qs|query|params|search)\s*\}/gi;

/** The shape of a path, with its holes emptied out, so two differently-named holes still match. */
function pathShape(path: string): string {
  const withoutQuery = (path.split('?')[0] ?? '').replace(QUERY_INTERPOLATION, '');
  return withoutQuery
    .split('/')
    .map((s) => (/^\$?\{[^}]*\}$/.test(s) ? '{}' : s))
    .join('/')
    .replace(/\/$/, '');
}

/** Every path written literally across a set of directories. */
function pathsInCode(cwd: string, directories: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const file of collectFiles(cwd, directories)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/["'`](\/[^"'`\n]*)["'`]/g)) {
      found.add(pathShape(m[1]!));
    }
  }
  return found;
}
