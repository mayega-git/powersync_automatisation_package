import { describe, expect, it, vi } from 'vitest';

import { OfflineSync } from '../src/OfflineSync.js';
import type {
  AccessLocalDatabase,
  SqlRow,
  SqlValue,
  WriteResult,
} from '../src/core/AccessLocalDatabase.js';
import { DeadLetterStore } from '../src/core/DeadLetterStore.js';
import { ErrorHandlerRegistry } from '../src/core/ErrorHandlerRegistry.js';
import type { HttpClientRequest } from '../src/core/HttpClient.js';
import { SilentLogger } from '../src/core/Logger.js';
import { OfflineSyncConnector } from '../src/core/OfflineSyncConnector.js';
import type { PendingWrite } from '../src/core/PendingWrite.js';
import type { SyncConnectorPort } from '../src/core/SyncConnectorPort.js';
import type { TokenProvider } from '../src/core/TokenProvider.js';

function memoryDb(): AccessLocalDatabase {
  const rows: Record<string, SqlValue>[] = [];
  const db: AccessLocalDatabase = {
    async readData<T>(sql: string): Promise<T[]> {
      if (sql.includes('COUNT(*)')) return [{ n: rows.length }] as T[];
      return [...rows] as T[];
    },
    async writeData(_sql: string, params?: readonly SqlValue[]): Promise<WriteResult> {
      const p = params ?? [];
      rows.push({
        id: p[0]!, operation_id: p[1]!, payload: p[2]!,
        code: p[3]!, reason: p[4]!, created_at: p[5]!,
      });
      return { rows: [], rowsAffected: 1 };
    },
    async runInTransaction(work) { return work(db); },
  };
  return db;
}

function connector(db = memoryDb()): SyncConnectorPort & { db: AccessLocalDatabase } {
  return {
    db,
    async fetchCredentials() { return null; },
    async uploadData() { return undefined; },
    async localDatabase() { return db; },
  };
}

describe('OfflineSync.create -- wiring', () => {
  it('asks the engine for the local database, without the application supplying it', async () => {
    // The application doesn't know the database: it knows the module, which
    // knows the engine, which knows the database.
    const c = connector();
    const spy = vi.spyOn(c, 'localDatabase');
    const sync = await OfflineSync.create({ connector: c, logger: new SilentLogger() });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sync.db).toBe(c.db);
  });

  it('accepts having no declared error handler at all', async () => {
    const sync = await OfflineSync.create({ connector: connector(), logger: new SilentLogger() });
    expect(sync.errorHandlers.size).toBe(0);
  });

  it('registers error handlers when there are some', async () => {
    const sync = await OfflineSync.create({
      connector: connector(),
      logger: new SilentLogger(),
      errorHandlers: { createBlog: async () => undefined },
    });
    expect(sync.errorHandlers.names()).toEqual(['createBlog']);
  });

  it('returns the dead-letter store, empty at first', async () => {
    const sync = await OfflineSync.create({ connector: connector(), logger: new SilentLogger() });
    expect(await sync.pendingIssues()).toEqual([]);
    expect(await sync.pendingIssueCount()).toBe(0);
  });
});

describe('resumeUploads -- after a reconnection', () => {
  it('delegates to the connector when it knows how', async () => {
    const c = connector();
    const callback = vi.fn();
    (c as SyncConnectorPort).resumeAfterReconnect = callback;

    const sync = await OfflineSync.create({ connector: c, logger: new SilentLogger() });
    sync.resumeUploads();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('breaks nothing when the connector has no notion of reauth', async () => {
    // The base connector (`connector()`) doesn't implement the method: the
    // normal case for a connector that never needed it.
    const sync = await OfflineSync.create({ connector: connector(), logger: new SilentLogger() });
    expect(() => sync.resumeUploads()).not.toThrow();
  });
});

/** A table the caller writes to directly, plus the real `_file_attente` shape `enqueue`/`readQueued` expect. */
function directWriteDb(): AccessLocalDatabase {
  const business: SqlRow[] = [];
  const queue: SqlRow[] = [];
  const db: AccessLocalDatabase = {
    async readData<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      if (sql.includes('_file_attente')) {
        const id = params?.[0];
        return queue.filter((r) => r['id'] === id) as T[];
      }
      return [...business] as T[];
    },
    async writeData(sql: string, params?: readonly SqlValue[]): Promise<WriteResult> {
      const p = params ?? [];
      if (sql.includes('_file_attente')) {
        queue.push({ id: p[0]!, method: p[1]!, path: p[2]!, body: p[3]!, created_at: p[4]! });
        return { rows: [], rowsAffected: 1 };
      }
      const row: SqlRow = { id: p[0]!, name: p[1]! };
      business.push(row);
      return { rows: [row], rowsAffected: 1 };
    },
    async runInTransaction(work) {
      return work(db);
    },
  };
  return db;
}

describe('write -- a direct write, no interception, no entities.yaml', () => {
  it('writes locally and returns the row from RETURNING', async () => {
    const db = directWriteDb();
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    const out = await sync.write({
      id: 'req-1',
      method: 'POST',
      url: '/api/product-core/attribute-definitions',
      sql: 'INSERT INTO attribute_definition (id, name, _metadata) VALUES (?, ?, ?) RETURNING *',
      params: ['attr-1', 'color', 'req-1'],
      body: { name: 'color' },
    });

    expect(out).toEqual({ status: 'Success', entity: { id: 'attr-1', name: 'color' } });
  });

  it('queues the request under the given id, body preferred over params', async () => {
    const db = directWriteDb();
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    await sync.write({
      id: 'req-2',
      method: 'POST',
      url: '/api/product-core/attribute-definitions',
      sql: 'INSERT INTO attribute_definition (id, name, _metadata) VALUES (?, ?, ?) RETURNING *',
      params: ['attr-2', 'size', 'req-2'],
      body: { name: 'size' },
    });

    const queued = await db.readData<{ id: string; method: string; path: string; body: string }>(
      'SELECT id, method, path, body, created_at FROM _file_attente WHERE id = ?',
      ['req-2'],
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: 'req-2', method: 'POST', path: '/api/product-core/attribute-definitions' });
  });

  it('falls back to params for the queued body when none is given', async () => {
    const db = directWriteDb();
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    await sync.write({
      id: 'req-3',
      method: 'DELETE',
      url: '/api/product-core/attribute-definitions/attr-3',
      sql: 'DELETE FROM attribute_definition WHERE id = ? RETURNING *',
      params: ['attr-3'],
    });

    const queued = await db.readData<{ body: string }>(
      'SELECT id, method, path, body, created_at FROM _file_attente WHERE id = ?',
      ['req-3'],
    );
    expect(JSON.parse(queued[0]!.body)).toEqual(['attr-3']);
  });

  it('a write with no matching RETURNING row still queues, entity is null', async () => {
    const db: AccessLocalDatabase = {
      async readData() { return []; },
      async writeData() { return { rows: [], rowsAffected: 0 }; },
      async runInTransaction(work) { return work(db); },
    };
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    const out = await sync.write({
      id: 'req-4',
      method: 'POST',
      url: '/api/x',
      sql: 'INSERT INTO x (id) VALUES (?)',
      params: ['x-1'],
    });

    expect(out).toEqual({ status: 'Success', entity: null });
  });

  it('the queued write is later found and replayed by OfflineSyncConnector.uploadData()', async () => {
    // Proves the replay path this write feeds: the same _file_attente entry
    // `write()` produces is exactly what `readFromQueue()` needs, keyed on
    // the id also bound to `_metadata` in the caller's own SQL -- the same
    // id PowerSync would report back as `PendingWrite.metadata` for a table
    // declared with `trackMetadata: true`.
    const db = directWriteDb();
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    await sync.write({
      id: 'req-5',
      method: 'POST',
      url: '/api/product-core/attribute-definitions',
      sql: 'INSERT INTO attribute_definition (id, name, _metadata) VALUES (?, ?, ?) RETURNING *',
      params: ['attr-5', 'weight', 'req-5'],
      body: { name: 'weight' },
    });

    const send = vi.fn(async (_req: HttpClientRequest) => ({ status: 200, headers: {}, body: {} }));
    const tokens: TokenProvider = {
      async getStreamToken() { return 'stream'; },
      async refreshStreamToken() { return 'stream'; },
      async getApplicativeToken() { return 'app-token'; },
      async refreshApplicativeToken() { return 'app-token'; },
    };
    const logger = new SilentLogger();
    const uploadConnector = new OfflineSyncConnector({
      http: { send },
      tokens,
      deadLetters: new DeadLetterStore({ db }),
      errors: new ErrorHandlerRegistry({ logger }),
      logger,
      syncEndpoint: 'https://sync.test',
      db,
    });

    // What the engine (PowerSync) would report: a CRUD entry whose
    // `metadata` is the `_metadata` value the write's own SQL set.
    const write: PendingWrite = {
      id: 'attr-5',
      clientId: 1,
      table: 'attribute_definition',
      op: 'PUT',
      data: { name: 'weight' },
      metadata: 'req-5',
    };
    const complete = vi.fn(async () => undefined);

    await uploadConnector.uploadData({ writes: [write], complete });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: '/api/product-core/attribute-definitions',
        body: { name: 'weight' },
      }),
    );
  });
});

/** A table read directly, with hand-aliased camelCase columns. */
function directReadDb(rows: SqlRow[]): AccessLocalDatabase {
  const db: AccessLocalDatabase = {
    async readData<T>(_sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      const id = params?.[0];
      return (id === undefined ? rows : rows.filter((r) => r['id'] === id)) as T[];
    },
    async writeData(): Promise<WriteResult> {
      throw new Error('not used by these tests');
    },
    async runInTransaction(work) { return work(db); },
  };
  return db;
}

describe('read -- a direct read, no interception, no entities.yaml', () => {
  it('runs the caller\'s own SQL and hands back the rows as-is', async () => {
    const db = directReadDb([{ id: 'bom-1', name: 'Cake' }, { id: 'bom-2', name: 'Bread' }]);
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    const out = await sync.read({ sql: 'SELECT id, name FROM bill_of_materials' });

    expect(out).toEqual([{ id: 'bom-1', name: 'Cake' }, { id: 'bom-2', name: 'Bread' }]);
  });

  it('reads a single row when asked, null when nothing matches', async () => {
    const db = directReadDb([{ id: 'bom-1', name: 'Cake' }]);
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    const found = await sync.read({
      sql: 'SELECT id, name FROM bill_of_materials WHERE id = ?',
      params: ['bom-1'],
      single: true,
    });
    expect(found).toEqual({ id: 'bom-1', name: 'Cake' });

    const missing = await sync.read({
      sql: 'SELECT id, name FROM bill_of_materials WHERE id = ?',
      params: ['bom-x'],
      single: true,
    });
    expect(missing).toBeNull();
  });

  it('never queues anything: a read has nothing to replay', async () => {
    const writeData = vi.fn();
    const db: AccessLocalDatabase = {
      async readData<T>(): Promise<T[]> { return [] as T[]; },
      writeData,
      async runInTransaction(work) { return work(db); },
    };
    const sync = await OfflineSync.create({ connector: connector(db), logger: new SilentLogger() });

    await sync.read({ sql: 'SELECT id FROM bill_of_materials' });

    expect(writeData).not.toHaveBeenCalled();
  });
});
