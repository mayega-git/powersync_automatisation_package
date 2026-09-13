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
  declaration: EntitiesDeclaration;
  schema: ReplicatedSchema | undefined;
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

  return { tables, paths, errors, ok: errors.length === 0 };
}
