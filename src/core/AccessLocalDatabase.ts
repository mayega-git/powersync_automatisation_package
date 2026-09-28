export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface WriteResult {
  rows: SqlRow[];
  /** Can be 0 on a successful write. Use `RETURNING` and read `rows` instead. */
  rowsAffected: number;
}

export interface LocalDatabaseSession {
  /** Parameters are positional (`?`), same convention throughout the module. */
  readData<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]>;

  writeData(sql: string, params?: readonly SqlValue[]): Promise<WriteResult>;
}

export interface AccessLocalDatabase extends LocalDatabaseSession {
  runInTransaction<T>(work: (tx: LocalDatabaseSession) => Promise<T>): Promise<T>;
}
