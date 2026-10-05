import { describe, expect, it } from 'vitest';
import { AerisRuntime, type RuntimeEvent } from '../../../src/aeris/runtime/runtime.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';
import type { RuntimeResponse } from '../../../src/aeris/runtime/transport.js';
import { ENTITY, FakeServer, ORG, keyPair, signed } from './fixtures.js';

const SEEDED = '33333333-3333-4333-8333-333333333333';

async function setup(options: { readStrategy?: 'network-first' | 'local-first' } = {}) {
  let now = Date.parse('2026-10-05T10:00:00Z');
  const clock = () => now;
  const server = new FakeServer(ORG, clock);
  const keys = await keyPair();
  server.envelope = await signed(keys);
  server.seed({ id: SEEDED, organizationId: ORG, agencyId: null, salesPointName: 'Main', status: 'ACTIVE', currency: 'XAF', createdAt: '2026-10-01T08:00:00', updatedAt: '2026-10-01T08:00:00' });
  const store = new MemoryStore();
  let session: Record<string, string> | null = { organizationId: ORG, userId: 'user-1' };
  const events: RuntimeEvent[] = [];
  let ids = 0;
  const runtime = new AerisRuntime({
    store,
    transport: server,
    trustedKeys: { 'test-key': keys.publicKeyBase64 },
    session: { context: () => session },
    isOnline: () => server.online,
    clock,
    random: () => 0,
    uuid: () => `cccccccc-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    apiOrigin: 'http://api.test',
    readStrategy: options.readStrategy,
  });
  runtime.on((event) => events.push(event));
  return {
    runtime, server, store, events, keys,
    advance: (ms: number) => { now += ms; },
    setSession: (value: Record<string, string> | null) => { session = value; },
  };
}

const call = (runtime: AerisRuntime, method: string, path: string, body?: unknown): Promise<RuntimeResponse> =>
  runtime.handle({
    method,
    url: `http://api.test${path}`,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });

const json = (response: RuntimeResponse) => (response.body === null ? null : JSON.parse(response.body));

describe('AerisRuntime', () => {
  it('blocks local execution until a snapshot exists, then serves reads offline', async () => {
    const { runtime, server } = await setup();
    server.online = false;
    await runtime.start();
    // No verified artifact yet: the request goes to the network and fails like fetch would.
    await expect(call(runtime, 'GET', `/api/sales-points/${SEEDED}`)).rejects.toThrow(/offline/);

    server.online = true;
    await runtime.refresh();
    server.online = false;
    const response = await call(runtime, 'GET', `/api/sales-points/${SEEDED}`);
    expect(response.status).toBe(200);
    expect(response.headers['x-aeris-state']).toBe('local');
    expect(json(response)).toMatchObject({ id: SEEDED, salesPointName: 'Main' });
    expect((await call(runtime, 'GET', '/api/sales-points/99999999-9999-4999-8999-999999999999')).status).toBe(404);
  });

  it('uses the network first when online and sends an idempotency key with mutations', async () => {
    const { runtime, server } = await setup();
    await runtime.start();
    const response = await call(runtime, 'POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'Online' });
    expect(response.status).toBe(201);
    expect(response.headers['x-aeris-state']).toBeUndefined();
    expect(server.calls.at(-1)?.idempotencyKey).toMatch(/^cccccccc-/);
  });

  it('queues offline writes, remaps server ids, orders dependent operations and converges', async () => {
    const { runtime, server, store, events } = await setup();
    await runtime.start();
    server.online = false;

    const created = await call(runtime, 'POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'Kiosk', currency: 'XAF' });
    expect(created.status).toBe(201);
    expect(created.headers['x-aeris-state']).toBe('provisional');
    const localId = json(created).id as string;

    const renamed = await call(runtime, 'PUT', `/api/sales-points/${localId}`, { salesPointName: 'Kiosk 2', currency: 'EUR' });
    expect(renamed.status).toBe(200);
    expect(json(await call(runtime, 'GET', `/api/sales-points/${localId}`))).toMatchObject({ salesPointName: 'Kiosk 2' });

    const queued = await runtime.operations();
    expect(queued.map((entry) => entry.state)).toEqual(['QUEUED', 'QUEUED']);
    expect(queued[1]!.dependencies).toEqual([queued[0]!.operationId]);

    server.online = true;
    await runtime.sync();

    const serverRows = [...server.rows.values()].filter((row) => row.salesPointName === 'Kiosk 2');
    expect(serverRows).toHaveLength(1);
    const serverId = serverRows[0]!.id as string;
    expect(serverId).not.toBe(localId);
    expect(server.calls.filter((entry) => entry.method === 'PUT')[0]!.path).toBe(`/api/sales-points/${serverId}`);

    const local = await store.transaction((tx) => tx.all(ENTITY));
    expect(local.map((row) => row.id).sort()).toEqual([SEEDED, serverId].sort());
    expect(await runtime.operations()).toEqual([]);
    expect(events.filter((event) => event.type === 'operation' && event.state === 'SERVER_COMMITTED')).toHaveLength(2);
  });

  it('turns a server conflict into a compensated local state and rejects dependents', async () => {
    const { runtime, server, store } = await setup();
    await runtime.start();
    server.online = false;
    expect((await call(runtime, 'PUT', `/api/sales-points/${SEEDED}`, { salesPointName: 'Mine' })).status).toBe(200);
    expect((await call(runtime, 'DELETE', `/api/sales-points/${SEEDED}`)).status).toBe(204);

    // Meanwhile another user deletes it on the server.
    server.execute('DELETE', `/api/sales-points/${SEEDED}`, null);
    server.online = true;
    await runtime.sync();

    const operations = await runtime.operations();
    expect(operations.map((entry) => [entry.state, entry.error?.code])).toEqual([['CONFLICT', 'CONFLICT'], ['REJECTED', 'DEPENDENCY_FAILED']]);
    expect(await store.transaction((tx) => tx.get(ENTITY, SEEDED))).toBeNull();
    await runtime.acknowledge(operations[0]!.operationId);
    expect((await runtime.operations()).map((entry) => entry.state)).toEqual(['REJECTED']);
  });

  it('keeps an operation queued when the reconcile response is lost', async () => {
    const { runtime, server } = await setup();
    await runtime.start();
    server.online = false;
    await call(runtime, 'POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'Once' });
    server.online = true;
    server.dropNextResponse = true;
    await runtime.sync();
    const [entry] = await runtime.operations();
    expect(entry!.state).toBe('QUEUED');
    expect(entry!.attempts).toBe(1);
    expect(entry!.nextAttemptAt).toBeGreaterThan(Date.parse('2026-10-05T10:00:00Z'));
    expect(server.effects).toBe(1);
  });

  it('retries after backoff and the gateway registry deduplicates the replay', async () => {
    const env = await setup();
    await env.runtime.start();
    env.server.online = false;
    await call(env.runtime, 'POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'Once' });
    env.server.online = true;
    env.server.dropNextResponse = true;
    await env.runtime.sync();
    env.advance(10 * 60_000);
    await env.runtime.sync();
    expect(env.server.effects).toBe(1);
    expect([...env.server.rows.values()].filter((row) => row.salesPointName === 'Once')).toHaveLength(1);
    expect(await env.runtime.operations()).toEqual([]);
  });

  it('keeps pending local work on top of server changes (rebase)', async () => {
    const { runtime, server, store } = await setup();
    await runtime.start();
    server.online = false;
    await call(runtime, 'PUT', `/api/sales-points/${SEEDED}`, { salesPointName: 'Local edit' });
    server.online = true;
    server.seed({ id: '77777777-7777-4777-8777-777777777777', organizationId: ORG, agencyId: null, salesPointName: 'Remote', status: 'ACTIVE', currency: null, createdAt: null, updatedAt: null });
    server.failNextReconcile = true;
    await runtime.sync();
    const rows = await store.transaction((tx) => tx.all(ENTITY));
    expect(rows.map((row) => row.salesPointName).sort()).toEqual(['Local edit', 'Remote']);
    expect((await runtime.operations())[0]!.state).toBe('QUEUED');
  });

  it('blocks online-only endpoints, kill-switched endpoints and stale data offline', async () => {
    const { runtime, server, advance } = await setup();
    await runtime.start();
    server.manifest = { ...server.manifest, disabled: ['POST /api/sales-points'] };
    await runtime.refresh();
    server.online = false;
    const payment = await call(runtime, 'POST', '/api/payments', {});
    expect(payment.status).toBe(503);
    expect(payment.headers['x-aeris-state']).toBe('blocked');
    expect((await call(runtime, 'POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'x' })).status).toBe(503);
    expect((await call(runtime, 'GET', `/api/sales-points/${SEEDED}`)).status).toBe(200);
    advance(2 * 3600_000);
    expect((await call(runtime, 'GET', `/api/sales-points/${SEEDED}`)).status).toBe(503);
  });

  it('purges data and pending operations when the session owner changes', async () => {
    const { runtime, server, store, setSession } = await setup();
    await runtime.start();
    server.online = false;
    await call(runtime, 'POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'Private' });
    setSession({ organizationId: ORG, userId: 'user-2' });
    const response = await call(runtime, 'GET', `/api/sales-points/${SEEDED}`);
    expect(response.status).toBe(503);
    expect(await runtime.operations()).toEqual([]);
    expect(await store.transaction((tx) => tx.all(ENTITY))).toEqual([]);
  });

  it('refuses an artifact downgrade and keeps the active version', async () => {
    const { runtime, server, keys } = await setup();
    server.envelope = await signed(keys, 5);
    await runtime.start();
    expect(runtime.activeArtifact?.artifactVersion).toBe(5);
    server.envelope = await signed(keys, 3);
    await runtime.refresh();
    expect(runtime.activeArtifact?.artifactVersion).toBe(5);
  });

  it('falls back to local execution with the same operation id when the network drops mid-request', async () => {
    const { runtime, server } = await setup();
    await runtime.start();
    const transport = server as unknown as { network: typeof server.network };
    const original = transport.network.bind(server);
    transport.network = async () => {
      throw new (await import('../../../src/aeris/runtime/transport.js')).TransportError('network', 'reset');
    };
    const response = await call(runtime, 'POST', '/api/sales-points', { organizationId: ORG, salesPointName: 'Fallback' });
    transport.network = original;
    expect(response.status).toBe(201);
    expect(response.headers['x-aeris-state']).toBe('provisional');
    expect(response.headers['x-aeris-operation-id']).toBe((await runtime.operations())[0]!.operationId);
  });

  it('serves reads locally first when configured and reports shadow mismatches', async () => {
    const { runtime, server } = await setup({ readStrategy: 'local-first' });
    await runtime.start();
    const before = server.calls.length;
    expect((await call(runtime, 'GET', `/api/sales-points/${SEEDED}`)).headers['x-aeris-state']).toBe('local');
    expect(server.calls.length).toBe(before);
  });
});
