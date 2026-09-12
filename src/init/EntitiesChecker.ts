import { pathsInCode, pathShape } from './Checker.js';
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
