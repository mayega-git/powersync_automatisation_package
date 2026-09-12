import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type {
  AccessLocalDatabase,
  LocalDatabaseSession,
  SqlRow,
  SqlValue,
  WriteResult,
} from '../src/core/AccessLocalDatabase.js';
import { ComposedOperations } from '../src/core/ComposedOperations.js';
import { EntityRoutes } from '../src/core/EntityRoutes.js';
import { SilentLogger } from '../src/core/Logger.js';
import { QUEUE_TABLE, listQueued } from '../src/core/PendingQueue.js';
import type { TableColumns } from '../src/core/SqlBuilder.js';

/**
 * A real SQLite database behind the module's port. A fake object would only
 * say the module built the expected statement; here the statement is
 * ACTUALLY executed, so a bogus column or a forgotten RETURNING fails the test.
 */
function realDb(): AccessLocalDatabase & { close(): void } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tag_entity (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, category_id TEXT,
      tenant_id TEXT, created_at TEXT, updated_at TEXT, _metadata TEXT
    );
    CREATE TABLE category_entity (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, domain TEXT,
      tenant_id TEXT, created_at TEXT, updated_at TEXT, _metadata TEXT
    );
    CREATE TABLE ${QUEUE_TABLE} (
      id TEXT PRIMARY KEY, method TEXT, path TEXT, body TEXT, created_at TEXT
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
      const info = stmt.run(...(params as never[]));
      return { rows: [], rowsAffected: info.changes };
    },
  };

  return {
    ...session,
    async runInTransaction<T>(work: (tx: LocalDatabaseSession) => Promise<T>) {
      sqlite.exec('BEGIN');
      try {
        const r = await work(session);
        sqlite.exec('COMMIT');
        return r;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => sqlite.close(),
  };
}

const SCHEMA: TableColumns = {
  tag_entity: [
    'id',
    'name',
    'description',
    'category_id',
    'tenant_id',
    'created_at',
    'updated_at',
    '_metadata',
  ],
  category_entity: [
    'id',
    'name',
    'description',
    'domain',
    'tenant_id',
    'created_at',
    'updated_at',
    '_metadata',
  ],
};

const NOW = '2026-09-05T10:00:00.000Z';

function build() {
  const db = realDb();
  const composed = new ComposedOperations({
    routes: EntityRoutes.build({
      tag_entity: '/api/education/tags',
      category_entity: '/api/education/categories',
    }),
    schema: SCHEMA,
    logger: new SilentLogger(),
    now: () => NOW,
    newRequestId: () => 'req-7',
    newRowId: () => 'new-tag',
  });

  async function call(method: string, url: string, body?: unknown) {
    const req = { method, url, ...(body !== undefined ? { body } : {}) };
    const entity = composed.resolve(req);
    if (entity === undefined) return undefined;
    return composed.run(db, req, entity);
  }

  return { db, composed, call };
}

describe('ComposedOperations: creation', () => {
  it('writes the business row and keeps the request, in one transaction', async () => {
    const { db, call } = build();

    const response = await call('POST', '/api/education/tags', {
      name: 'Algebra',
      categoryId: 'c-9',
    });

    expect(response!.status).toBe('Success');
    const row = response!.entity as Record<string, unknown>;
    expect(row['id']).toBe('new-tag');
    expect(row['name']).toBe('Algebra');
    expect(row['category_id']).toBe('c-9');
    // The id ALONE, not the request: the request is in the queue.
    expect(row['_metadata']).toBe('req-7');

    const queue = await listQueued(db);
    expect(queue).toEqual([
      {
        id: 'req-7',
        method: 'POST',
        path: '/api/education/tags',
        body: { name: 'Algebra', categoryId: 'c-9' },
        createdAt: NOW,
      },
    ]);
    db.close();
  });

  it('keeps the path\'s query string', async () => {
    const { db, call } = build();
    await call('POST', '/api/education/tags?locale=en', { name: 'X' });
    expect((await listQueued(db))[0]!.path).toBe('/api/education/tags?locale=en');
    db.close();
  });

  it('inherits an already-synced tenant, even from a neighboring table', async () => {
    const { db, call } = build();
    // The target table is empty; a neighbor in the same bucket carries the tenant.
    await db.writeData(
      "INSERT INTO category_entity (id, name, tenant_id) VALUES ('c-1', 'X', 'ten-1')",
    );

    await call('POST', '/api/education/tags', { name: 'Algebra' });
    const rows = await db.readData<SqlRow>('SELECT tenant_id FROM tag_entity');
    expect(rows[0]!['tenant_id']).toBe('ten-1');
    db.close();
  });

  it('accepts a null tenant before the first sync', async () => {
    const { db, call } = build();
    const response = await call('POST', '/api/education/tags', { name: 'X' });
    expect((response!.entity as SqlRow)['tenant_id']).toBeNull();
    db.close();
  });

  it('ignores a body field that is not a column', async () => {
    const { db, call } = build();
    const response = await call('POST', '/api/education/tags', {
      name: 'X',
      buttonColor: 'red',
    });
    expect(response!.status).toBe('Success');
    db.close();
  });
});

describe('ComposedOperations: reads', () => {
  it('returns the list, aliased for the screen', async () => {
    const { db, call } = build();
    await db.writeData(
      "INSERT INTO tag_entity (id, name, category_id) VALUES ('t-1', 'Zeta', 'c-9')",
    );
    await db.writeData(
      "INSERT INTO tag_entity (id, name, category_id) VALUES ('t-2', 'Alpha', 'c-9')",
    );

    const response = await call('GET', '/api/education/tags');
    const rows = response!.entity as Record<string, unknown>[];
    // Order is preserved: without it, the list would reorder itself.
    expect(rows.map((l) => l['name'])).toEqual(['Alpha', 'Zeta']);
    // The screen expects categoryId, the table carries category_id.
    expect(rows[0]!['categoryId']).toBe('c-9');
    expect(rows[0]).not.toHaveProperty('_metadata');
    db.close();
  });

  it('returns ONE row, not a one-row list, on a path with an id', async () => {
    const { db, call } = build();
    await db.writeData("INSERT INTO tag_entity (id, name) VALUES ('t-1', 'Alpha')");

    const response = await call('GET', '/api/education/tags/t-1');
    expect((response!.entity as SqlRow)['name']).toBe('Alpha');
    db.close();
  });

  it('queues nothing: a read is never replayed', async () => {
    const { db, call } = build();
    await call('GET', '/api/education/tags');
    expect(await listQueued(db)).toEqual([]);
    db.close();
  });
});

describe('ComposedOperations: updates and deletes', () => {
  it('updates without touching the tenant or the creation date', async () => {
    const { db, call } = build();
    await db.writeData(
      "INSERT INTO tag_entity (id, name, tenant_id, created_at)" +
        " VALUES ('t-1', 'Alpha', 'ten-1', '2020-01-01')",
    );

    await call('PUT', '/api/education/tags/t-1', { name: 'Beta' });
    const row = (await db.readData<SqlRow>('SELECT * FROM tag_entity'))[0]!;
    expect(row['name']).toBe('Beta');
    expect(row['tenant_id']).toBe('ten-1');
    expect(row['created_at']).toBe('2020-01-01');
    expect(row['updated_at']).toBe(NOW);
    db.close();
  });

  it('marks the row before deleting it, in the same transaction', async () => {
    const { db, call } = build();
    await db.writeData("INSERT INTO tag_entity (id, name) VALUES ('t-1', 'Alpha')");

    const response = await call('DELETE', '/api/education/tags/t-1');
    // RETURNING gives back the deleted row: rowsAffected would not be reliable.
    expect((response!.entity as SqlRow)['id']).toBe('t-1');
    expect(await db.readData('SELECT * FROM tag_entity')).toEqual([]);

    const queue = await listQueued(db);
    expect(queue[0]!.method).toBe('DELETE');
    expect(queue[0]!.path).toBe('/api/education/tags/t-1');
    expect(queue[0]!.body).toBeUndefined();
    db.close();
  });
});

describe('ComposedOperations: what it does not concern', () => {
  it('does not recognize an undeclared route', () => {
    const { db, composed } = build();
    expect(
      composed.resolve({ method: 'GET', url: '/api/education/courses' }),
    ).toBeUndefined();
    expect(composed.resolve({ method: 'POST', url: '/api/auth/login' })).toBeUndefined();
    db.close();
  });

  it('leaves nothing behind when the write fails', async () => {
    const { db, call } = build();
    await db.writeData("INSERT INTO tag_entity (id, name) VALUES ('t-1', 'Alpha')");

    // Same id: the primary key constraint fails the insert.
    await expect(
      call('POST', '/api/education/tags', { id: 't-1', name: 'Duplicate' }),
    ).rejects.toThrow();

    // Neither a corrupted business row nor an orphan request in the queue.
    const rows = await db.readData<SqlRow>('SELECT name FROM tag_entity');
    expect(rows.map((l) => l['name'])).toEqual(['Alpha']);
    expect(await listQueued(db)).toEqual([]);
    db.close();
  });
});
