import type { TableColumns } from '../core/SqlBuilder.js';

/** Narrower than a full PowerSync schema: only what this file needs to read. */
export interface PowerSyncSchemaShape {
  tables: readonly {
    name: string;
    columns: readonly { name: string }[];
    trackMetadata?: boolean;
  }[];
}

/** Adds `id` (added by the engine to every table) and `_metadata` (only under `trackMetadata: true`). */
export function tableColumnsFromSchema(schema: PowerSyncSchemaShape): TableColumns {
  const out: Record<string, string[]> = {};

  for (const table of schema.tables) {
    const columns = ['id', ...table.columns.map((c) => c.name)];
    if (table.trackMetadata === true) columns.push('_metadata');
    out[table.name] = columns;
  }

  return out;
}
