import { describe, expect, it, vi } from 'vitest';

import type { OfflineSyncConnector } from '../src/core/OfflineSyncConnector.js';
import type { PendingTransaction } from '../src/core/PendingWrite.js';
import {
  PowerSyncConnector,
  toPendingTransaction,
  type PowerSyncCrudSource,
  type PowerSyncCrudTransaction,
} from '../src/powersync/PowerSyncConnector.js';
import { tableColumnsFromSchema } from '../src/powersync/SchemaColumns.js';

function crudTx(
  crud: PowerSyncCrudTransaction['crud'],
): { tx: PowerSyncCrudTransaction; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => undefined);
  return { tx: { crud, complete, transactionId: 3 }, complete };
}

const entry = {
  clientId: 7,
  id: 'blog-1',
  op: 'PUT',
  table: 'blogs',
  opData: { title: 'a' },
  metadata: '{"method":"POST","path":"/api/v1/blogs"}',
  transactionId: 3,
};

function source(tx: PowerSyncCrudTransaction | null): PowerSyncCrudSource {
  return {
    async getAll() { return []; },
    async execute() { return { array: [], rowsAffected: 0 } as never; },
    async writeTransaction(fn) { return fn({} as never); },
    async getNextCrudTransaction() { return tx; },
  };
}

describe('toPendingTransaction', () => {
  it('translates an SDK write into the module\'s neutral shape', () => {
    const { tx } = crudTx([entry]);
    expect(toPendingTransaction(tx).writes[0]).toEqual({
      id: 'blog-1',
      clientId: 7,
      table: 'blogs',
      op: 'PUT',
      data: { title: 'a' },
      metadata: '{"method":"POST","path":"/api/v1/blogs"}',
      transactionId: 3,
    });
  });

  it('does not invent absent fields', () => {
    const { tx } = crudTx([{ clientId: 1, id: 'x', op: 'DELETE', table: 't' }]);
    const w = toPendingTransaction(tx).writes[0]!;

    expect(w.data).toBeUndefined();
    expect(w.metadata).toBeUndefined();
    expect(w.transactionId).toBeUndefined();
  });

  it('passes complete() through unchanged, without wrapping it', async () => {
    // It's what removes writes from the queue: calling it or not IS the
    // answer given to the engine.
    const { tx, complete } = crudTx([entry]);
    await toPendingTransaction(tx).complete();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('recognizes the three write kinds', () => {
    for (const op of ['PUT', 'PATCH', 'DELETE'] as const) {
      const { tx } = crudTx([{ ...entry, op }]);
      expect(toPendingTransaction(tx).writes[0]?.op).toBe(op);
    }
  });

  it('accepts a lowercase write kind', () => {
    const { tx } = crudTx([{ ...entry, op: 'delete' }]);
    expect(toPendingTransaction(tx).writes[0]?.op).toBe('DELETE');
  });

  it('falls back to PATCH, the least destructive, for an unknown kind', () => {
    // PUT would overwrite columns nobody meant to change; DELETE would
    // destroy the row. PATCH only touches what's given.
    const { tx } = crudTx([{ ...entry, op: 'UNKNOWN' }]);
    expect(toPendingTransaction(tx).writes[0]?.op).toBe('PATCH');
  });
});

describe('PowerSyncConnector', () => {
  function build(tx: PowerSyncCrudTransaction | null) {
    const uploadData = vi.fn(async (_t: PendingTransaction) => undefined);
    const connector = {
      uploadData,
      async fetchCredentials() {
        return { endpoint: 'https://sync.test', token: 'token' };
      },
    } as unknown as OfflineSyncConnector;
    return {
      powersync: new PowerSyncConnector({ db: source(tx), connector }),
      uploadData,
    };
  }

  it('gives the local database to the module', async () => {
    const { powersync } = build(null);
    const db = await powersync.localDatabase();
    expect(typeof db.writeData).toBe('function');
    expect(typeof db.runInTransaction).toBe('function');
  });

  it('does nothing when the queue is empty', async () => {
    const { powersync, uploadData } = build(null);
    await powersync.uploadData();
    expect(uploadData).not.toHaveBeenCalled();
  });

  it('hands the translated transaction to the upload logic', async () => {
    const { tx } = crudTx([entry]);
    const { powersync, uploadData } = build(tx);

    await powersync.uploadData();

    expect(uploadData).toHaveBeenCalledTimes(1);
    expect(uploadData.mock.calls[0]![0].writes).toHaveLength(1);
  });

  it('lets what the upload logic throws escape', async () => {
    // The output contract belongs to OfflineSyncConnector: swallowing an
    // error here would tell the engine everything went fine.
    const { tx } = crudTx([entry]);
    const connector = {
      async uploadData() {
        throw new Error('transient failure');
      },
    } as unknown as OfflineSyncConnector;
    const powersync = new PowerSyncConnector({ db: source(tx), connector });

    await expect(powersync.uploadData()).rejects.toThrow('transient failure');
  });

  it('forwards the channel credentials', async () => {
    const { powersync } = build(null);
    expect(await powersync.fetchCredentials()).toEqual({
      endpoint: 'https://sync.test',
      token: 'token',
    });
  });
});

describe('tableColumnsFromSchema', () => {
  it('adds id, which the engine adds itself to every table', () => {
    const columns = tableColumnsFromSchema({
      tables: [{ name: 'tag_entity', columns: [{ name: 'name' }] }],
    });
    expect(columns['tag_entity']).toEqual(['id', 'name']);
  });

  it('adds _metadata only when the table tracks it', () => {
    const columns = tableColumnsFromSchema({
      tables: [
        { name: 'tracked', columns: [{ name: 'a' }], trackMetadata: true },
        { name: 'untracked', columns: [{ name: 'a' }] },
      ],
    });
    // Without it, no replay would be possible on that table.
    expect(columns['tracked']).toContain('_metadata');
    expect(columns['untracked']).not.toContain('_metadata');
  });
});
