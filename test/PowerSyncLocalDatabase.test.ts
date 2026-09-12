import { describe, expect, it } from 'vitest';

import type { LocalDatabaseSession } from '../src/core/AccessLocalDatabase.js';
import {
  PowerSyncLocalDatabase,
  type PowerSyncWriteTarget,
} from '../src/powersync/PowerSyncLocalDatabase.js';

type Call = { sql: string; params: unknown };

/** Fake PowerSync object: records what it's asked, returns what it's told to. */
function fakeDb(overrides: Partial<PowerSyncWriteTarget> = {}) {
  const calls: Call[] = [];
  const target: PowerSyncWriteTarget = {
    async getAll<T>(sql: string, params?: any[]) {
      calls.push({ sql, params });
      return [] as T[];
    },
    async execute<T>(sql: string, params?: any[]) {
      calls.push({ sql, params });
      return { array: [] as T[], rowsAffected: 0 } as any;
    },
    async writeTransaction<T>(fn: (tx: any) => Promise<T>) {
      return fn({
        getAll: async (sql: string, params?: any[]) => {
          calls.push({ sql: `[tx] ${sql}`, params });
          return [];
        },
        execute: async (sql: string, params?: any[]) => {
          calls.push({ sql: `[tx] ${sql}`, params });
          return { array: [], rowsAffected: 1 } as any;
        },
      });
    },
    ...overrides,
  };
  return { target, calls };
}

describe('PowerSyncLocalDatabase', () => {
  it('passes positional parameters through unchanged on read', async () => {
    const { target, calls } = fakeDb();
    const db = new PowerSyncLocalDatabase(target);

    await db.readData('SELECT * FROM courses WHERE id = ?', ['c-1']);

    expect(calls).toEqual([
      { sql: 'SELECT * FROM courses WHERE id = ?', params: ['c-1'] },
    ]);
  });

  it('passes an empty array rather than undefined when there are no parameters', async () => {
    const { target, calls } = fakeDb();
    const db = new PowerSyncLocalDatabase(target);

    await db.readData('SELECT 1');

    expect(calls[0]?.params).toEqual([]);
  });

  it('copies parameters, without letting the SDK mutate the caller\'s array', async () => {
    const { target } = fakeDb({
      async execute(_sql: string, params?: any[]) {
        params?.push('injected');
        return { array: [], rowsAffected: 1 } as any;
      },
    });
    const db = new PowerSyncLocalDatabase(target);
    const params = ['c-1'] as const;

    await db.writeData('UPDATE courses SET title = ? WHERE id = ?', params);

    expect(params).toEqual(['c-1']);
  });

  it('surfaces the rows returned by a RETURNING clause', async () => {
    const { target } = fakeDb({
      async execute() {
        return { array: [{ id: 'c-1', title: 'Algebra' }], rowsAffected: 1 } as any;
      },
    });
    const db = new PowerSyncLocalDatabase(target);

    const result = await db.writeData('INSERT INTO courses ... RETURNING *');

    expect(result.rows).toEqual([{ id: 'c-1', title: 'Algebra' }]);
    expect(result.rowsAffected).toBe(1);
  });

  it('does not break when the SDK sets neither array nor rowsAffected', async () => {
    const { target } = fakeDb({
      async execute() {
        return {} as any;
      },
    });
    const db = new PowerSyncLocalDatabase(target);

    const result = await db.writeData('DELETE FROM courses WHERE id = ?', ['c-1']);

    expect(result.rows).toEqual([]);
    expect(result.rowsAffected).toBe(0);
  });

  it('gives the transactional work a session bound to the transaction, not the database', async () => {
    const { target, calls } = fakeDb();
    const db = new PowerSyncLocalDatabase(target);

    await db.runInTransaction(async (tx: LocalDatabaseSession) => {
      await tx.writeData('INSERT INTO units ...');
      await tx.readData('SELECT * FROM units');
    });

    expect(calls.map((c) => c.sql)).toEqual([
      '[tx] INSERT INTO units ...',
      '[tx] SELECT * FROM units',
    ]);
  });

  it('lets the transactional work\'s error escape, without catching it', async () => {
    const { target } = fakeDb();
    const db = new PowerSyncLocalDatabase(target);

    await expect(
      db.runInTransaction(async () => {
        throw new Error('constraint violated');
      }),
    ).rejects.toThrow('constraint violated');
  });

  it('returns the value produced by the transactional work', async () => {
    const { target } = fakeDb();
    const db = new PowerSyncLocalDatabase(target);

    const out = await db.runInTransaction(async () => 'done');

    expect(out).toBe('done');
  });
});
