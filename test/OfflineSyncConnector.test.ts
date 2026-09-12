import { describe, expect, it, vi } from 'vitest';

import { ClassifiedError, type StatusClassifier } from '../src/core/ClassifiedError.js';
import { DeadLetterStore } from '../src/core/DeadLetterStore.js';
import { ErrorHandlerRegistry } from '../src/core/ErrorHandlerRegistry.js';
import type { HttpClientResponse } from '../src/core/HttpClient.js';
import { SilentLogger } from '../src/core/Logger.js';
import { OfflineSyncConnector } from '../src/core/OfflineSyncConnector.js';
import type { PendingWrite } from '../src/core/PendingWrite.js';
import type { TokenProvider } from '../src/core/TokenProvider.js';
import type {
  AccessLocalDatabase,
  SqlValue,
  WriteResult,
} from '../src/core/AccessLocalDatabase.js';

function memoryDb() {
  const rows: Record<string, SqlValue>[] = [];
  const db: AccessLocalDatabase = {
    async readData<T>(sql: string): Promise<T[]> {
      if (sql.includes('COUNT(*)')) return [{ n: rows.length }] as T[];
      return [...rows] as T[];
    },
    async writeData(sql: string, params?: readonly SqlValue[]): Promise<WriteResult> {
      const p = params ?? [];
      if (sql.includes('DELETE')) return { rows: [], rowsAffected: 0 };
      const i = rows.findIndex((r) => r['id'] === p[0]);
      const row = { id: p[0]!, operation_id: p[1]!, payload: p[2]!, code: p[3]!, reason: p[4]!, created_at: p[5]! };
      if (i >= 0) rows[i] = row; else rows.push(row);
      return { rows: [], rowsAffected: 1 };
    },
    async runInTransaction(work) { return work(db); },
  };
  return db;
}

const tokens: TokenProvider = {
  async getStreamToken() { return 'channel-token'; },
  async refreshStreamToken() { return 'channel-token'; },
  async getApplicativeToken() { return 'app-token'; },
  async refreshApplicativeToken() { return 'app-token'; },
};

function write(over: Partial<PendingWrite> = {}): PendingWrite {
  return {
    id: 'blog-1',
    clientId: 7,
    table: 'blogs',
    op: 'PUT',
    data: { title: 'a' },
    metadata: JSON.stringify({
      method: 'POST',
      path: '/api/v1/blogs',
      operationId: 'createBlog',
    }),
    ...over,
  };
}

function build(
  send: (req: unknown) => Promise<HttpClientResponse>,
  over: { tokens?: TokenProvider; classifyStatus?: StatusClassifier } = {},
) {
  const logger = new SilentLogger();
  const db = memoryDb();
  const deadLetters = new DeadLetterStore({ db });
  const errors = new ErrorHandlerRegistry({ logger });
  const spy = vi.fn(send);
  const connector = new OfflineSyncConnector({
    http: { send: spy },
    tokens: over.tokens ?? tokens,
    deadLetters,
    errors,
    logger,
    syncEndpoint: 'https://sync.test',
    ...(over.classifyStatus !== undefined ? { classifyStatus: over.classifyStatus } : {}),
  });
  return { connector, send: spy, deadLetters, errors, logger };
}

const ok = async (): Promise<HttpClientResponse> => ({ status: 200, headers: {}, body: {} });

function tx(writes: PendingWrite[]) {
  const complete = vi.fn(async () => undefined);
  return { transaction: { writes, complete }, complete };
}

describe('OfflineSyncConnector -- opening the channel', () => {
  it('returns the channel address and token', async () => {
    const { connector } = build(ok);
    expect(await connector.fetchCredentials()).toEqual({
      endpoint: 'https://sync.test',
      token: 'channel-token',
    });
  });

  it('returns null when the user is not signed in', async () => {
    // A valid answer, not a failure: the engine then opens no channel.
    const { connector } = build(ok, {
      tokens: { ...tokens, async getStreamToken() { return null; } },
    });
    expect(await connector.fetchCredentials()).toBeNull();
  });
});

describe('OfflineSyncConnector -- nominal upload', () => {
  it('rebuilds the request from the JSON attached to the write', async () => {
    const { connector, send } = build(ok);
    const { transaction } = tx([write()]);

    await connector.uploadData(transaction);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/blogs',
      body: { title: 'a' },
    });
  });

  it('sets the applicative token, not the channel one', async () => {
    const { connector, send } = build(ok);
    await connector.uploadData(tx([write()]).transaction);

    const req = send.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(req.headers['Authorization']).toBe('Bearer app-token');
  });

  it('copies the idempotency key carried by the write, without making one up', async () => {
    const { connector, send } = build(ok);
    await connector.uploadData(
      tx([write({ data: { title: 'a', idempotencyKey: 'k-42' } })]).transaction,
    );

    const req = send.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(req.headers['Idempotency-Key']).toBe('k-42');
  });

  it('marks every replayed request, so it does not fall back into the local database', async () => {
    // When the Service Worker is the gate, it also catches what this
    // connector sends. Without this marker, the replay would go back to
    // SQLite instead of the server: the queue would empty with nothing
    // reaching the server.
    const { connector, send } = build(ok);
    await connector.uploadData(tx([write()]).transaction);

    const req = send.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(req.headers['X-Offline-Sync-Replay']).toBe('1');
  });

  it('sends no key when the write carries none', async () => {
    const { connector, send } = build(ok);
    await connector.uploadData(tx([write()]).transaction);

    const req = send.mock.calls[0]![0] as { headers: Record<string, string> };
    expect(req.headers['Idempotency-Key']).toBeUndefined();
  });

  it('marks the transaction complete once everything went through', async () => {
    const { connector } = build(ok);
    const { transaction, complete } = tx([write(), write({ clientId: 8 })]);

    await connector.uploadData(transaction);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('OfflineSyncConnector -- transient failure', () => {
  it('lets the error escape and marks NOTHING as complete', async () => {
    // The most counter-intuitive point: letting the error through is the
    // only way to ask for a retry. Catching it would lose the write.
    const { connector } = build(async () => ({ status: 503, headers: {}, body: {} }));
    const { transaction, complete } = tx([write()]);

    const err = await connector.uploadData(transaction).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClassifiedError);
    expect((err as ClassifiedError).kind).toBe('retry');
    expect(complete).not.toHaveBeenCalled();
  });

  it('treats 408, 429 and 5xx as transient', async () => {
    for (const status of [408, 429, 500, 503]) {
      const { connector } = build(async () => ({ status, headers: {}, body: {} }));
      const err = await connector
        .uploadData(tx([write()]).transaction)
        .catch((e: unknown) => e);
      expect((err as ClassifiedError).kind).toBe('retry');
    }
  });

  it('lets a transport failure escape without transforming it', async () => {
    const { connector } = build(async () => {
      throw new Error('no network');
    });
    await expect(connector.uploadData(tx([write()]).transaction)).rejects.toThrow(
      'no network',
    );
  });
});

describe('OfflineSyncConnector -- definitive rejection', () => {
  it('records to the dead-letter store and marks the transaction complete', async () => {
    // NOT marking it complete would replay forever a write the server will
    // always refuse, blocking the whole queue behind it.
    const { connector, deadLetters } = build(async () => ({
      status: 422,
      headers: {},
      body: {},
    }));
    const { transaction, complete } = tx([write()]);

    await connector.uploadData(transaction);

    expect(complete).toHaveBeenCalledTimes(1);
    const entries = await deadLetters.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ operationId: 'createBlog', code: 422 });
  });

  it('applies the declared handler before recording', async () => {
    const order: string[] = [];
    const { connector, errors, deadLetters } = build(async () => ({
      status: 403,
      headers: {},
      body: {},
    }));
    errors.register('createBlog', async () => {
      order.push('handler');
    });

    await connector.uploadData(tx([write()]).transaction);
    order.push(`store:${(await deadLetters.list()).length}`);

    expect(order).toEqual(['handler', 'store:1']);
  });

  it('records even when the developer\'s handler fails', async () => {
    const { connector, errors, deadLetters } = build(async () => ({
      status: 403,
      headers: {},
      body: {},
    }));
    errors.register('createBlog', async () => {
      throw new Error('screen already closed');
    });

    await connector.uploadData(tx([write()]).transaction);

    expect(await deadLetters.count()).toBe(1);
  });

  it('continues with the following writes after a rejection', async () => {
    const { connector, send } = build(async (req) => {
      const url = (req as { url: string }).url;
      return url.includes('refused')
        ? { status: 422, headers: {}, body: {} }
        : { status: 200, headers: {}, body: {} };
    });
    const refused = write({
      clientId: 1,
      metadata: JSON.stringify({ method: 'POST', path: '/refused', operationId: 'a' }),
    });
    const { transaction, complete } = tx([refused, write({ clientId: 2 })]);

    await connector.uploadData(transaction);

    expect(send).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('OfflineSyncConnector -- unusable metadata', () => {
  it('discards a write with no metadata, without sending anything', async () => {
    const { connector, send, deadLetters } = build(ok);
    const { transaction, complete } = tx([write({ metadata: undefined })]);

    await connector.uploadData(transaction);

    expect(send).not.toHaveBeenCalled();
    expect(await deadLetters.count()).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('discards unreadable JSON rather than blocking the queue', async () => {
    const { connector, deadLetters } = build(ok);
    await connector.uploadData(tx([write({ metadata: '{ not json' })]).transaction);

    expect(await deadLetters.count()).toBe(1);
  });

  it('discards valid JSON with neither a path nor a method', async () => {
    const { connector, deadLetters } = build(ok);
    await connector.uploadData(
      tx([write({ metadata: JSON.stringify({ something: 'else' }) })]).transaction,
    );

    expect(await deadLetters.count()).toBe(1);
  });
});

describe('OfflineSyncConnector -- injectable status classification (Fix 2)', () => {
  it('uses the built-in rules when no classifier is supplied', async () => {
    const { connector } = build(async () => ({ status: 409, headers: {}, body: {} }));
    const err = (await connector
      .uploadData(tx([write()]).transaction)
      .catch((e: unknown) => e)) as ClassifiedError;

    // 409 has no built-in rule: it falls back to a definitive rejection.
    expect(err).toBeUndefined();
  });

  it('lets a custom classifier override a status the built-in rules would reject', async () => {
    const { connector, deadLetters } = build(
      async () => ({ status: 409, headers: {}, body: {} }),
      { classifyStatus: (res) => (res.status === 409 ? 'retry' : undefined) },
    );

    const err = await connector
      .uploadData(tx([write()]).transaction)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClassifiedError);
    expect((err as ClassifiedError).kind).toBe('retry');
    expect(await deadLetters.count()).toBe(0);
  });

  it('falls back to the built-in rules when the classifier returns undefined', async () => {
    const { connector, deadLetters } = build(
      async () => ({ status: 422, headers: {}, body: {} }),
      { classifyStatus: () => undefined },
    );

    await connector.uploadData(tx([write()]).transaction);

    expect(await deadLetters.count()).toBe(1);
  });

  it('lets a custom classifier turn a normally-retried status into a reauth', async () => {
    const onReauthRequired = vi.fn();
    const logger = new SilentLogger();
    const db = memoryDb();
    const connector = new OfflineSyncConnector({
      http: { send: async () => ({ status: 403, headers: {}, body: {} }) },
      tokens,
      deadLetters: new DeadLetterStore({ db }),
      errors: new ErrorHandlerRegistry({ logger }),
      logger,
      syncEndpoint: 'https://sync.test',
      onReauthRequired,
      classifyStatus: (res) => (res.status === 403 ? 'reauth' : undefined),
    });

    const err = await connector
      .uploadData(tx([write()]).transaction)
      .catch((e: unknown) => e);

    expect((err as ClassifiedError).kind).toBe('reauth');
    expect(onReauthRequired).toHaveBeenCalledTimes(1);
  });
});
