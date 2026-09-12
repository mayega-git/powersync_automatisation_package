import { describe, expect, it, vi } from 'vitest';

import { OfflineSync } from '../src/OfflineSync.js';
import type {
  AccessLocalDatabase,
  SqlValue,
  WriteResult,
} from '../src/core/AccessLocalDatabase.js';
import type { Handler, Response } from '../src/core/Handler.js';
import { SilentLogger } from '../src/core/Logger.js';
import type { OfflineMap, OperationMapping } from '../src/core/OperationMapping.js';
import type { SyncConnectorPort } from '../src/core/SyncConnectorPort.js';
import { OfflineMapValidationError } from '../src/core/validateOfflineMap.js';

const ok: Response = { status: 'Success', entity: { id: 'b-1' } };

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

function op(over: Partial<OperationMapping> = {}): OperationMapping {
  return {
    operationId: 'createBlog',
    method: 'POST',
    path: '/api/v1/blogs',
    serverPath: '/api/v1/blogs',
    connectivity: 'offline',
    handle: 'createBlog',
    ...over,
  };
}

const handlers: Record<string, Handler> = {
  createBlog: { async localWrite() { return ok; } },
};

const base = (map: OfflineMap) => ({
  connector: connector(),
  requests: handlers,
  offlineMap: map,
  logger: new SilentLogger(),
  httpClient: { send: async () => ({ status: 200, headers: {}, body: null }) },
});

describe('OfflineSync.create -- map validation', () => {
  it('refuses to start when two operations compete for the same path', async () => {
    // Deliberate: a bad map is a developer error, visible on the first run
    // rather than in production through random routing.
    const map = { operations: [op({ operationId: 'a' }), op({ operationId: 'b' })] };

    await expect(OfflineSync.create(base(map))).rejects.toThrow(
      OfflineMapValidationError,
    );
    await expect(OfflineSync.create(base(map))).rejects.toThrow(/"a" and "b"/);
  });

  it('treats {id} and {blogId} as the same slot', async () => {
    // Position routes, not the hole's name.
    const map = {
      operations: [
        op({ operationId: 'a', path: '/blogs/{id}' }),
        op({ operationId: 'b', path: '/blogs/{blogId}' }),
      ],
    };
    await expect(OfflineSync.create(base(map))).rejects.toThrow(
      OfflineMapValidationError,
    );
  });

  it('lets the same path through on two different methods', async () => {
    const map = {
      operations: [
        op({ operationId: 'read', method: 'GET' }),
        op({ operationId: 'createBlog', method: 'POST' }),
      ],
    };
    await expect(OfflineSync.create(base(map))).resolves.toBeInstanceOf(OfflineSync);
  });

  it('refuses an unknown connectivity rather than guessing it', async () => {
    const map = {
      operations: [op({ connectivity: 'maybe' as never })],
    };
    await expect(OfflineSync.create(base(map))).rejects.toThrow(/unknown connectivity/);
  });

  it('refuses an operation missing a required field', async () => {
    const map = { operations: [op({ handle: '' })] };
    await expect(OfflineSync.create(base(map))).rejects.toThrow(/handle/);
  });

  it('names the offending path in the error', async () => {
    const map = { operations: [op({ path: '/api/v1/blogs' }), op()] };
    const err = await OfflineSync.create(base(map)).catch((e: unknown) => e);
    expect((err as OfflineMapValidationError).path).toBe('/api/v1/blogs');
  });
});

describe('OfflineSync.create -- wiring', () => {
  it('asks the engine for the local database, without the application supplying it', async () => {
    // The application doesn't know the database: it knows the module, which
    // knows the engine, which knows the database.
    const c = connector();
    const spy = vi.spyOn(c, 'localDatabase');
    const sync = await OfflineSync.create({
      ...base({ operations: [op()] }),
      connector: c,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sync.db).toBe(c.db);
  });

  it('registers the supplied handlers', async () => {
    const sync = await OfflineSync.create(base({ operations: [op()] }));
    expect(sync.requests.names()).toEqual(['createBlog']);
  });

  it('accepts having no declared error handler at all', async () => {
    const sync = await OfflineSync.create(base({ operations: [op()] }));
    expect(sync.errorHandlers.size).toBe(0);
  });

  it('registers error handlers when there are some', async () => {
    const sync = await OfflineSync.create({
      ...base({ operations: [op()] }),
      errorHandlers: { createBlog: async () => undefined },
    });
    expect(sync.errorHandlers.names()).toEqual(['createBlog']);
  });

  it('validates the map BEFORE touching the engine', async () => {
    // Otherwise a database would be opened for a module that won't start.
    const c = connector();
    const spy = vi.spyOn(c, 'localDatabase');
    await OfflineSync.create({
      ...base({ operations: [op({ operationId: 'a' }), op({ operationId: 'b' })] }),
      connector: c,
    }).catch(() => undefined);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('OfflineSync -- in operation', () => {
  it('carries a request through end to end', async () => {
    const sync = await OfflineSync.create(base({ operations: [op()] }));

    const out = await sync.interceptRequest({
      method: 'POST',
      url: '/api/v1/blogs',
      body: { title: 'a' },
    });

    expect(out).toBe(ok);
  });

  it('builds nothing more after startup', async () => {
    // Two identical requests: the second is recognized as a duplicate, which
    // proves the SAME guard serves one request after another.
    const localWrite = vi.fn(async () => ok);
    const sync = await OfflineSync.create({
      ...base({ operations: [op()] }),
      requests: { createBlog: { localWrite } },
    });

    await sync.interceptRequest({ method: 'POST', url: '/api/v1/blogs', body: { t: 'a' } });
    await sync.interceptRequest({ method: 'POST', url: '/api/v1/blogs', body: { t: 'a' } });

    expect(localWrite).toHaveBeenCalledTimes(1);
  });

  it('returns the dead-letter store, empty at first', async () => {
    const sync = await OfflineSync.create(base({ operations: [op()] }));
    expect(await sync.pendingIssues()).toEqual([]);
    expect(await sync.pendingIssueCount()).toBe(0);
  });
});

describe('handles -- is this call mine?', () => {
  it('distinguishes what the map declares from what it ignores', async () => {
    // Call this before interceptRequest when the application has its own
    // HTTP client: an unknown request would be relayed by the module's own
    // client, which carries neither session cookies nor custom headers.
    const sync = await OfflineSync.create({
      connector: connector(),
      requests: { listTags: { async localWrite() { return ok; } } },
      offlineMap: {
        operations: [
          {
            operationId: 'listTags',
            method: 'GET',
            path: '/api/education/{resource}',
            connectivity: 'offline',
            handle: 'listTags',
          },
        ],
      },
      logger: new SilentLogger(),
    });

    expect(sync.handles({ method: 'GET', url: '/api/education/tags' })).toBe(true);
    // Same path, different method: not the same operation.
    expect(sync.handles({ method: 'POST', url: '/api/education/tags' })).toBe(false);
    expect(sync.handles({ method: 'GET', url: '/api/something/else' })).toBe(false);
  });
});

describe('resumeUploads -- after a reconnection', () => {
  it('delegates to the connector when it knows how', async () => {
    const c = connector();
    const callback = vi.fn();
    (c as SyncConnectorPort).resumeAfterReconnect = callback;

    const sync = await OfflineSync.create({ ...base({ operations: [op()] }), connector: c });
    sync.resumeUploads();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('breaks nothing when the connector has no notion of reauth', async () => {
    // The base connector (`connector()`) doesn't implement the method: the
    // normal case for a connector that never needed it.
    const sync = await OfflineSync.create(base({ operations: [op()] }));
    expect(() => sync.resumeUploads()).not.toThrow();
  });
});
