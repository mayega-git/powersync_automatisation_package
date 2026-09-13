/** Where to reach the sync engine's admin API, and which buckets belong to this platform. */
export interface PowerSyncAdminSpec {
  adminUrl: string;
  /** A trailing star is accepted (`yownews_*`). Empty means "all". */
  buckets: string[];
  /** Where to write the application's schema file. */
  schemaFile: string;
  /** Endpoint that mints a token sized for the engine, distinct from the user's session. */
  tokenEndpoint?: string;
}

export interface SyncConfig {
  /** Optional: without it, `schema` refuses to run. */
  powersync?: PowerSyncAdminSpec;
}
