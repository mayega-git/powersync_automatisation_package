import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type {
  AccessLocalDatabase,
  LocalDatabaseSession,
  SqlRow,
  SqlValue,
  WriteResult,
} from '../src/core/AccessLocalDatabase.js';
import { DeadLetterStore } from '../src/core/DeadLetterStore.js';
import { ErrorHandlerRegistry } from '../src/core/ErrorHandlerRegistry.js';
import type { HttpClientResponse } from '../src/core/HttpClient.js';
import { SilentLogger } from '../src/core/Logger.js';
import { OfflineSyncConnector } from '../src/core/OfflineSyncConnector.js';
import { enqueue, QUEUE_TABLE, listQueued } from '../src/core/PendingQueue.js';
import type { PendingTransaction, PendingWrite } from '../src/core/PendingWrite.js';
import type { TokenProvider } from '../src/core/TokenProvider.js';

/** A real database: the queue and the dead-letter store live together in it. */
function realDb(): AccessLocalDatabase {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE ${QUEUE_TABLE} (
      id TEXT PRIMARY KEY, method TEXT, path TEXT, body TEXT, created_at TEXT
    );
    CREATE TABLE offline_sync_dead_letters (
      id TEXT PRIMARY KEY, operation_id TEXT, payload TEXT, code INTEGER,
      reason TEXT, created_at INTEGER
    );
  `);

  const session: LocalDatabaseSession = {
    async readData<T extends SqlRow = SqlRow>(
      sql: string,
      params: readonly SqlValue[] = [],
    ): Promise<T[]> {
      return sqlite.prepare(sql).all(...(params as never[])) as T[];
    },
    async writeData(
      sql: string,
      params: readonly SqlValue[] = [],
    ): Promise<WriteResult> {
      const stmt = sqlite.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all(...(params as never[])) as SqlRow[];
        return { rows, rowsAffected: rows.length };
      }
      return { rows: [], rowsAffected: stmt.run(...(params as never[])).changes };
    },
  };

  return { ...session, async runInTransaction(work) { return work(session); } };
}

const tokens: TokenProvider = {
  async getStreamToken() { return 'channel-token'; },
  async refreshStreamToken() { return 'channel-token'; },
  async getApplicativeToken() { return null; },
  async refreshApplicativeToken() { return null; },
};

function write(over: Partial<PendingWrite> = {}): PendingWrite {
  return { id: 't-1', clientId: 1, table: 'tag_entity', op: 'PUT', ...over };
}

function transaction(writes: PendingWrite[]): PendingTransaction & {
  isComplete: () => boolean;
} {
  let done = false;
  return {
    writes,
    complete: async () => { done = true; },
    isComplete: () => done,
  };
}

function build(
  db: AccessLocalDatabase,
  send: (req: unknown) => Promise<HttpClientResponse>,
  onReauthRequired?: () => void,
) {
  const logger = new SilentLogger();
  const spy = vi.fn(send);
  const connector = new OfflineSyncConnector({
    http: { send: spy },
    tokens,
    deadLetters: new DeadLetterStore({ db }),
    errors: new ErrorHandlerRegistry({ logger }),
    logger,
    syncEndpoint: 'http://engine.test',
    db,
    ...(onReauthRequired !== undefined ? { onReauthRequired } : {}),
  });
  return { connector, spy };
}

const OK: HttpClientResponse = { status: 200, headers: {}, body: {} };

describe('replay from the queue', () => {
  it('sends the original request, not the written columns', async () => {
    const db = realDb();
    await enqueue(db, {
      id: 'req-7',
      method: 'POST',
      path: '/api/education/tags?locale=en',
      body: { name: 'Algebra', categoryId: 'c-9' },
      now: '2026-09-05T10:00:00.000Z',
    });
    const { connector, spy } = build(db, async () => OK);

    await connector.uploadData(transaction([write({ metadata: 'req-7' })]));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      method: 'POST',
      // The query string is part of the call.
      url: '/api/education/tags?locale=en',
      body: { name: 'Algebra', categoryId: 'c-9' },
    });
  });

  it('uses the queue id as the idempotency key', async () => {
    // Without this key, a response lost in transit would recreate the row on
    // the next replay: the server has no way to know it's the same gesture.
    const db = realDb();
    await enqueue(db, {
      id: 'req-7',
      method: 'POST',
      path: '/api/education/tags',
      body: { name: 'Algebra' },
      now: '2026-09-05T10:00:00.000Z',
    });
    const { connector, spy } = build(db, async () => OK);

    await connector.uploadData(transaction([write({ metadata: 'req-7' })]));

    const req = spy.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(req.headers['Idempotency-Key']).toBe('req-7');
  });

  it('sends back the SAME key when the engine replays the same note', async () => {
    // The heart of the matter: the id is kept in the queue, so it doesn't
    // change from one attempt to the next.
    const db = realDb();
    await enqueue(db, {
      id: 'req-7',
      method: 'POST',
      path: '/api/education/tags',
      body: { name: 'Algebra' },
      now: '2026-09-05T10:00:00.000Z',
    });

    let first = true;
    const { connector, spy } = build(db, async () => {
      if (first) {
        first = false;
        // Transient failure AFTER the server applied the write.
        return { status: 503, headers: {}, body: {} };
      }
      return OK;
    });

    await expect(
      connector.uploadData(transaction([write({ metadata: 'req-7' })])),
    ).rejects.toThrow();
    // The queue wasn't cleared: the request is still there, with its id.
    expect(await listQueued(db)).toHaveLength(1);

    await connector.uploadData(transaction([write({ metadata: 'req-7' })]));

    const keys = spy.mock.calls.map(
      (call) => (call[0] as { headers: Record<string, string> }).headers['Idempotency-Key'],
    );
    expect(keys).toEqual(['req-7', 'req-7']);
  });

  it('sends only once when a request wrote several rows', async () => {
    // The engine returns one note per row. Without grouping, a single user
    // gesture would call the server twice.
    const db = realDb();
    await enqueue(db, {
      id: 'req-7',
      method: 'POST',
      path: '/api/education/tags',
      body: { name: 'X' },
      now: '2026-09-05T10:00:00.000Z',
    });
    const { connector, spy } = build(db, async () => OK);

    await connector.uploadData(
      transaction([
        write({ clientId: 1, metadata: 'req-7' }),
        write({ clientId: 2, table: 'category_entity', metadata: 'req-7' }),
      ]),
    );

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('removes from the queue what was sent', async () => {
    const db = realDb();
    await enqueue(db, {
      id: 'req-7', method: 'POST', path: '/api/education/tags',
      now: '2026-09-05T10:00:00.000Z',
    });
    const { connector } = build(db, async () => OK);

    await connector.uploadData(transaction([write({ metadata: 'req-7' })]));
    expect(await listQueued(db)).toEqual([]);
  });

  it('keeps the queue intact when the network fails', async () => {
    const db = realDb();
    await enqueue(db, {
      id: 'req-7', method: 'POST', path: '/api/education/tags',
      now: '2026-09-05T10:00:00.000Z',
    });
    const { connector } = build(db, async () => ({
      status: 503, headers: {}, body: {},
    }));

    const tx = transaction([write({ metadata: 'req-7' })]);
    await expect(connector.uploadData(tx)).rejects.toThrow();
    // Neither completed nor lost: it will go out again.
    expect(tx.isComplete()).toBe(false);
    expect(await listQueued(db)).toHaveLength(1);
  });

  it('marks a delete via the note that immediately precedes it', async () => {
    // A delete writes no column: the id travels through the update that
    // precedes it, in the same transaction.
    const db = realDb();
    await enqueue(db, {
      id: 'req-9', method: 'DELETE', path: '/api/education/tags/t-1',
      now: '2026-09-05T10:00:00.000Z',
    });
    const { connector, spy } = build(db, async () => OK);

    await connector.uploadData(
      transaction([
        write({ clientId: 1, op: 'PATCH', metadata: 'req-9', transactionId: 4 }),
        write({ clientId: 2, op: 'DELETE', metadata: 'req-9', transactionId: 4 }),
      ]),
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      method: 'DELETE',
      url: '/api/education/tags/t-1',
    });
  });
});

describe('the session expired while the device was offline', () => {
  it('records nothing to the dead-letter store and keeps the queue', async () => {
    const db = realDb();
    await enqueue(db, {
      id: 'req-7', method: 'POST', path: '/api/education/tags',
      now: '2026-09-05T10:00:00.000Z',
    });
    const notified = vi.fn();
    const { connector } = build(
      db,
      async () => ({ status: 401, headers: {}, body: {} }),
      notified,
    );

    const tx = transaction([write({ metadata: 'req-7' })]);
    await expect(connector.uploadData(tx)).rejects.toThrow(/session expired/);

    expect(notified).toHaveBeenCalledTimes(1);
    expect(tx.isComplete()).toBe(false);
    expect(await listQueued(db)).toHaveLength(1);
    const deadLetters = await db.readData('SELECT * FROM offline_sync_dead_letters');
    expect(deadLetters).toEqual([]);
  });

  it('notifies only once, and sends nothing more until reopened', async () => {
    // Without this guard, the engine retries every 5 seconds and both the
    // callback and the log line would fire on every pass.
    const db = realDb();
    await enqueue(db, {
      id: 'req-7', method: 'POST', path: '/api/education/tags',
      now: '2026-09-05T10:00:00.000Z',
    });
    const notified = vi.fn();
    const { connector, spy } = build(
      db,
      async () => ({ status: 401, headers: {}, body: {} }),
      notified,
    );

    // First pass: a real network call, a real notification.
    await expect(connector.uploadData(transaction([write({ metadata: 'req-7' })]))).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);

    // The engine retries -- second and third pass: neither network nor notification.
    await expect(connector.uploadData(transaction([write({ metadata: 'req-7' })]))).rejects.toThrow();
    await expect(connector.uploadData(transaction([write({ metadata: 'req-7' })]))).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(await listQueued(db)).toHaveLength(1);

    // The application reports the reconnection: the next pass retries for
    // real -- network called again, and since it still fails here (the fake
    // server always returns 401), the notification fires once more. What
    // matters: this is no longer the earlier silence, it's a REAL new attempt.
    connector.resumeAfterReconnect();
    await expect(connector.uploadData(transaction([write({ metadata: 'req-7' })]))).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it('but a 403 stays a definitive rejection: reconnecting would change nothing', async () => {
    const db = realDb();
    await enqueue(db, {
      id: 'req-7', method: 'POST', path: '/api/education/tags',
      now: '2026-09-05T10:00:00.000Z',
    });
    const { connector } = build(db, async () => ({
      status: 403, headers: {}, body: {},
    }));

    const tx = transaction([write({ metadata: 'req-7' })]);
    await connector.uploadData(tx);

    expect(tx.isComplete()).toBe(true);
    const deadLetters = await db.readData('SELECT * FROM offline_sync_dead_letters');
    expect(deadLetters).toHaveLength(1);
  });
});

describe('compatibility with hand-written handlers', () => {
  it('falls back to the JSON attached to the write when there is no queue id', async () => {
    const db = realDb();
    const { connector, spy } = build(db, async () => OK);

    await connector.uploadData(
      transaction([
        write({
          metadata: JSON.stringify({
            method: 'POST',
            path: '/api/v1/blogs',
            operationId: 'createBlog',
          }),
          data: { title: 'a' },
        }),
      ]),
    );

    expect(spy.mock.calls[0]![0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/blogs',
    });
  });
});
