import type {
  LockContext,
  QueryResult,
  SqliteRecord,
  Transaction,
} from '@powersync/common';

import type {
  AccessLocalDatabase,
  LocalDatabaseSession,
  SqlRow,
  SqlValue,
  WriteResult,
} from '../core/AccessLocalDatabase.js';

/** Narrower than `PowerSyncDatabase`: only what this adapter needs to read, write, and transact. */
export interface PowerSyncWriteTarget {
  getAll<T>(sql: string, parameters?: any[]): Promise<T[]>;
  execute<T = SqliteRecord>(
    query: string,
    params?: any[] | undefined,
  ): Promise<QueryResult<T>>;
  writeTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

function toParams(params?: readonly SqlValue[]): any[] {
  return params === undefined ? [] : [...params];
}

class PowerSyncSession implements LocalDatabaseSession {
  protected constructor(protected readonly ctx: PowerSyncWriteTarget | LockContext) {}

  static on(ctx: PowerSyncWriteTarget | LockContext): LocalDatabaseSession {
    return new PowerSyncSession(ctx);
  }

  async readData<T extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]> {
    return this.ctx.getAll<T>(sql, toParams(params));
  }

  async writeData(sql: string, params?: readonly SqlValue[]): Promise<WriteResult> {
    const result = await this.ctx.execute<SqlRow>(sql, toParams(params));
    return {
      rows: result.array ?? [],
      rowsAffected: result.rowsAffected ?? 0,
    };
  }
}

export class PowerSyncLocalDatabase
  extends PowerSyncSession
  implements AccessLocalDatabase
{
  constructor(private readonly db: PowerSyncWriteTarget) {
    super(db);
  }

  async runInTransaction<T>(
    work: (tx: LocalDatabaseSession) => Promise<T>,
  ): Promise<T> {
    return this.db.writeTransaction((tx) => work(PowerSyncSession.on(tx)));
  }
}
