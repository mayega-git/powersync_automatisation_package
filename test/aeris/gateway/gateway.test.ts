import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_URL, suite } from './database.js';
import { createGateway, type Gateway } from '../../../src/aeris/gateway/server.js';
import type { GatewayConfig } from '../../../src/aeris/gateway/config.js';
import { rawTypes } from '../../../src/aeris/gateway/data.js';
import { AerisRuntime } from '../../../src/aeris/runtime/runtime.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';
import { HttpTransport } from '../../../src/aeris/runtime/transport.js';
import { ENTITY, keyPair, ORG, OTHER_ORG, signed } from '../runtime/fixtures.js';


/** A backend with the SalesPoint semantics, storing in PostgreSQL and honoring Idempotency-Key. */
async function startBackend(pool: pg.Pool): Promise<{ server: Server; url: string; executions: () => number }> {
  let executions = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const org = String(request.headers['x-test-org'] ?? '');
      const key = request.headers['idempotency-key'];
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(payload === null ? '' : JSON.stringify(payload));
      };
      if (typeof key === 'string') {
        const stored = await pool.query<{ status: number; body: unknown }>('SELECT status, body FROM backend.idempotency WHERE key = $1', [key]);
        if (stored.rows[0] !== undefined) return send(stored.rows[0].status, stored.rows[0].body);
      }
      const remember = async (status: number, payload: unknown) => {
        if (typeof key === 'string') await pool.query('INSERT INTO backend.idempotency (key, status, body) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [key, status, JSON.stringify(payload)]);
        send(status, payload);
      };
      const match = /^\/api\/sales-points(?:\/([^/?]+))?/.exec(request.url ?? '');
      if (match === null) return send(404, null);
      const id = match[1];
      const view = (row: Record<string, unknown>) => ({
        id: row.id, organizationId: row.organization_id, agencyId: row.agency_id, salesPointName: row.sales_point_name,
        status: row.status, currency: row.currency, createdAt: String(row.created_at).replace(' ', 'T'), updatedAt: String(row.updated_at).replace(' ', 'T'),
      });
      if (request.method === 'GET' && id === undefined) {
        const rows = await pool.query('SELECT * FROM billing_sales.pos_sales_points WHERE organization_id = $1', [org]);
        return send(200, rows.rows.map(view));
      }
      const existing = id === undefined ? undefined : (await pool.query('SELECT * FROM billing_sales.pos_sales_points WHERE id = $1 AND organization_id = $2', [id, org])).rows[0];
      if (request.method === 'GET') return existing === undefined ? send(404, null) : send(200, view(existing));
      executions += 1;
      if (request.method === 'POST') {
        const inserted = await pool.query(
          `INSERT INTO billing_sales.pos_sales_points (id, organization_id, agency_id, sales_point_name, status, currency, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now()) RETURNING *`,
          [body.organizationId, body.agencyId ?? null, body.salesPointName, body.status ?? 'ACTIVE', body.currency ?? null],
        );
        return remember(201, view(inserted.rows[0]));
      }
      if (existing === undefined) return remember(404, { message: 'Sales point not found' });
      if (request.method === 'PUT') {
        const updated = await pool.query(
          `UPDATE billing_sales.pos_sales_points SET agency_id = $2, sales_point_name = $3, status = COALESCE($4, status), currency = $5, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, body.agencyId ?? null, body.salesPointName, body.status ?? null, body.currency ?? null],
        );
        return remember(200, view(updated.rows[0]));
      }
      if (request.method === 'DELETE') {
        await pool.query('DELETE FROM billing_sales.pos_sales_points WHERE id = $1', [id]);
        return remember(204, null);
      }
      return send(405, null);
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}`, executions: () => executions };
}

suite('Sync Gateway against PostgreSQL', () => {
  let pool: pg.Pool;
  let gateway: Gateway;
  let backend: Awaited<ReturnType<typeof startBackend>>;
  let keys: Awaited<ReturnType<typeof keyPair>>;
  let online = true;

  const runtimeFor = (org: string, user: string) => new AerisRuntime({
    store: new MemoryStore(),
    transport: (() => {
      const http = new HttpTransport({ gatewayUrl: `${gateway.url()}/aeris`, authHeaders: () => ({ 'x-test-org': org, 'x-test-user': user }) });
      const guard = <T extends (...args: never[]) => Promise<unknown>>(fn: T): T => (async (...args: Parameters<T>) => {
        if (!online) throw new (await import('../../../src/aeris/runtime/transport.js')).TransportError('network', 'offline');
        return fn(...args);
      }) as T;
      return {
        artifact: guard(() => http.artifact()),
        policy: guard(() => http.policy()),
        snapshot: guard((version: string) => http.snapshot(version)),
        delta: guard((version: string, since: string) => http.delta(version, since)),
        reconcile: guard((request: Parameters<HttpTransport['reconcile']>[0]) => http.reconcile(request)),
        network: guard((request: Parameters<HttpTransport['network']>[0]) => http.network({ ...request, headers: { ...request.headers, 'x-test-org': org } })),
      };
    })(),
    trustedKeys: { 'test-key': keys.publicKeyBase64 },
    session: { context: () => ({ organizationId: org, userId: user }) },
    isOnline: () => online,
    apiOrigin: backend.url,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, types: rawTypes });
    await pool.query('DROP SCHEMA IF EXISTS billing_sales CASCADE; DROP SCHEMA IF EXISTS backend CASCADE; DROP SCHEMA IF EXISTS aeris CASCADE;');
    await pool.query(`CREATE SCHEMA billing_sales; CREATE SCHEMA backend;
      CREATE TABLE billing_sales.pos_sales_points (id uuid PRIMARY KEY, organization_id uuid, agency_id uuid, sales_point_name text, status text, currency text, created_at timestamp, updated_at timestamp);
      CREATE TABLE backend.idempotency (key text PRIMARY KEY, status int, body jsonb);`);
    keys = await keyPair();
    const directory = await mkdtemp(join(tmpdir(), 'aeris-gateway-'));
    const artifactFile = join(directory, 'artifact.signed.json');
    await writeFile(artifactFile, JSON.stringify(await signed(keys)));
    backend = await startBackend(pool);
    const config: GatewayConfig = {
      listen: { host: '127.0.0.1', port: 0 },
      artifactFile,
      trustedKeys: { 'test-key': keys.publicKeyBase64 },
      backend: { url: backend.url, timeoutMs: 5_000, forwardHeaders: ['x-test-org'] },
      database: { url: DATABASE_URL!, schema: 'aeris', poolSize: 4 },
      auth: { mode: 'trusted-headers', claims: { organizationId: 'x-test-org', userId: 'x-test-user' }, acknowledgeInsecure: true },
      subjectClaims: ['organizationId', 'userId'],
      policy: { disabled: [], freshness: {}, minArtifactVersion: 0 },
      cors: { origins: [] },
      limits: { maxBatch: 50, maxBodyBytes: 1_000_000, deltaPageSize: 2 },
      retentionDays: 30,
    };
    gateway = await createGateway(config, { pool, log: () => undefined });
    await gateway.setup();
    await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await gateway?.close();
    await new Promise<void>((resolve) => backend?.server.close(() => resolve()));
    await pool?.end();
  });

  beforeEach(async () => {
    online = true;
    await pool.query('DELETE FROM billing_sales.pos_sales_points; DELETE FROM backend.idempotency; DELETE FROM aeris.operations;');
  });

  it('syncs a scoped snapshot, replays offline writes exactly once and converges on canonical rows', async () => {
    await pool.query(`INSERT INTO billing_sales.pos_sales_points VALUES
      ('aaaaaaaa-0000-4000-8000-000000000001', $1, NULL, 'Mine', 'ACTIVE', 'XAF', '2026-01-01 08:00:00.123456', '2026-01-01 08:00:00.123456'),
      ('aaaaaaaa-0000-4000-8000-000000000002', $2, NULL, 'Theirs', 'ACTIVE', 'XAF', '2026-01-01 08:00:00', '2026-01-01 08:00:00')`, [ORG, OTHER_ORG]);
    const runtime = runtimeFor(ORG, 'u1');
    await runtime.start();
    const store = (runtime as unknown as { options: { store: MemoryStore } }).options.store;
    const local = await store.transaction((tx) => tx.all(ENTITY));
    expect(local.map((row) => row.salesPointName)).toEqual(['Mine']);
    expect(local[0]!.createdAt).toBe('2026-01-01T08:00:00.123456');

    online = false;
    const created = await runtime.handle({ method: 'POST', url: `${backend.url}/api/sales-points`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId: ORG, salesPointName: 'Offline kiosk' }) });
    expect(created.status).toBe(201);
    const localId = JSON.parse(created.body!).id as string;
    expect((await runtime.handle({ method: 'PUT', url: `${backend.url}/api/sales-points/${localId}`, headers: {}, body: JSON.stringify({ salesPointName: 'Renamed offline' }) })).status).toBe(200);

    online = true;
    await runtime.sync();
    const server = await pool.query<{ id: string; sales_point_name: string }>('SELECT id, sales_point_name FROM billing_sales.pos_sales_points WHERE organization_id = $1 ORDER BY sales_point_name', [ORG]);
    expect(server.rows.map((row) => row.sales_point_name)).toEqual(['Mine', 'Renamed offline']);
    const serverId = server.rows.find((row) => row.sales_point_name === 'Renamed offline')!.id;
    expect(serverId).not.toBe(localId);
    expect(backend.executions()).toBe(2);
    const converged = await store.transaction((tx) => tx.all(ENTITY));
    expect(converged.map((row) => row.id).sort()).toEqual(['aaaaaaaa-0000-4000-8000-000000000001', serverId].sort());
    expect(await runtime.operations()).toEqual([]);
    runtime.stop();
  });

  it('answers a replayed batch from the registry without re-executing', async () => {
    const response = await fetch(`${gateway.url()}/aeris/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-org': ORG, 'x-test-user': 'u1' },
      body: JSON.stringify({
        clientInstanceId: 'c1', artifactVersion: 1,
        operations: [{ operationId: 'bbbbbbbb-0000-4000-8000-000000000001', endpointId: 'POST /api/sales-points', method: 'POST', path: '/api/sales-points', query: {}, body: { organizationId: ORG, salesPointName: 'Once' }, baseCursor: '0', dependencies: [], localIds: ['cccccccc-0000-4000-8000-000000000001'], preconditionHash: 'x', createdAt: new Date().toISOString() }],
      }),
    });
    const first = await response.json() as { receipts: { status: string; idMap: Record<string, string> }[] };
    expect(first.receipts[0]!.status).toBe('COMMITTED');
    expect(Object.keys(first.receipts[0]!.idMap)).toEqual(['cccccccc-0000-4000-8000-000000000001']);
    const again = await (await fetch(`${gateway.url()}/aeris/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-org': ORG, 'x-test-user': 'u1' },
      body: JSON.stringify({ clientInstanceId: 'c1', artifactVersion: 1, operations: [{ operationId: 'bbbbbbbb-0000-4000-8000-000000000001', endpointId: 'POST /api/sales-points', method: 'POST', path: '/api/sales-points', query: {}, body: { organizationId: ORG, salesPointName: 'Once' }, baseCursor: '0', dependencies: [], localIds: [], preconditionHash: 'x', createdAt: new Date().toISOString() }] }),
    })).json() as { receipts: { status: string; replayed?: boolean }[] };
    expect(again.receipts[0]).toMatchObject({ status: 'COMMITTED', replayed: true });
    expect((await pool.query('SELECT count(*)::int AS n FROM billing_sales.pos_sales_points')).rows[0].n).toBe(1);
  });

  it('refuses to forward to a route other than the endpoint claims (no open proxy)', async () => {
    const before = backend.executions();
    const response = await fetch(`${gateway.url()}/aeris/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-org': ORG, 'x-test-user': 'u1' },
      body: JSON.stringify({ clientInstanceId: 'c1', artifactVersion: 1, operations: [{ operationId: 'dddddddd-0000-4000-8000-000000000001', endpointId: 'POST /api/sales-points', method: 'POST', path: '/admin/drop-everything', query: {}, body: {}, baseCursor: null, dependencies: [], localIds: [], preconditionHash: 'x', createdAt: new Date().toISOString() }] }),
    });
    const body = await response.json() as { receipts: { status: string; error: { code: string } }[] };
    expect(body.receipts[0]).toMatchObject({ status: 'REJECTED', error: { code: 'INVALID_OPERATION' } });
    expect(backend.executions()).toBe(before);
  });

  it('streams deltas in commit order, removes rows leaving the scope and never skips concurrent commits', async () => {
    const runtime = runtimeFor(ORG, 'u2');
    await runtime.start();
    const store = (runtime as unknown as { options: { store: MemoryStore } }).options.store;
    // Concurrent writers: a long transaction takes an id first but commits last.
    const slow = await pool.connect();
    await slow.query('BEGIN');
    await slow.query(`INSERT INTO billing_sales.pos_sales_points VALUES ('eeeeeeee-0000-4000-8000-000000000001', $1, NULL, 'Slow', 'ACTIVE', NULL, now(), now())`, [ORG]);
    for (let index = 2; index <= 6; index += 1) {
      await pool.query(`INSERT INTO billing_sales.pos_sales_points VALUES ($1, $2, NULL, $3, 'ACTIVE', NULL, now(), now())`, [`eeeeeeee-0000-4000-8000-00000000000${index}`, ORG, `Fast ${index}`]);
    }
    await runtime.sync();
    await slow.query('COMMIT');
    slow.release();
    await pool.query(`UPDATE billing_sales.pos_sales_points SET organization_id = $1 WHERE id = 'eeeeeeee-0000-4000-8000-000000000002'`, [OTHER_ORG]);
    await runtime.sync();
    const names = (await store.transaction((tx) => tx.all(ENTITY))).map((row) => row.salesPointName).sort();
    expect(names).toEqual(['Fast 3', 'Fast 4', 'Fast 5', 'Fast 6', 'Slow']);
    runtime.stop();
  });
});
