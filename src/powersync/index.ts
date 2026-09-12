// Entry point of the PowerSync adapter: `@ksm/offline-sync/powersync`.
// Separate from the main entry point so `@ksm/offline-sync` itself names no
// engine. Checked by test/boundary.test.ts: `src/core/` cannot import
// `src/powersync/`.

export {
  PowerSyncLocalDatabase,
  type PowerSyncWriteTarget,
} from "./PowerSyncLocalDatabase.js";

export {
  PowerSyncConnector,
  toPendingTransaction,
  type PowerSyncConnectorOptions,
  type PowerSyncCrudEntry,
  type PowerSyncCrudSource,
  type PowerSyncCrudTransaction,
} from "./PowerSyncConnector.js";

export {
  tableColumnsFromSchema,
  type PowerSyncSchemaShape,
} from "./SchemaColumns.js";
