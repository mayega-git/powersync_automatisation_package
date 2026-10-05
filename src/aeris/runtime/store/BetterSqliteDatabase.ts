import type {
  AccessLocalDatabase,
  LocalDatabaseSession,
  SqlRow,
  SqlValue,
  WriteResult,
} from '../../../core/AccessLocalDatabase.js';

/** The subset of better-sqlite3 used here, so the dependency stays optional. */
export interface BetterSqliteLike {
  prepare(sql: string): {
    reader: boolean;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  };
  exec(sql: string): unknown;
}

/**
 * AccessLocalDatabase over a synchronous better-sqlite3 handle (Node,
 * Electron, tests). Transactions are serialized with a promise queue because
 * the work callback is asynchronous.
 */
export class BetterSqliteDatabase implements AccessLocalDatabase {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly session: LocalDatabaseSession;

  constructor(private readonly db: BetterSqliteLike) {
    this.session = {
      readData: async <T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) =>
        this.db.prepare(sql).all(...toParams(params)) as T[],
      writeData: async (sql: string, params?: readonly SqlValue[]): Promise<WriteResult> => {
        const statement = this.db.prepare(sql);
        if (statement.reader) return { rows: statement.all(...toParams(params)) as SqlRow[], rowsAffected: 0 };
        const result = statement.run(...toParams(params));
        return { rows: [], rowsAffected: result.changes };
      },
    };
  }

  readData<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
    return this.serialized(() => this.session.readData<T>(sql, params));
  }

  writeData(sql: string, params?: readonly SqlValue[]): Promise<WriteResult> {
    return this.serialized(() => this.session.writeData(sql, params));
  }

  runInTransaction<T>(work: (tx: LocalDatabaseSession) => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(this.session);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function toParams(params?: readonly SqlValue[]): unknown[] {
  return (params ?? []).map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
}
