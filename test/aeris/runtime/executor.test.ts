import { describe, expect, it } from 'vitest';
import { AerisHttpError, Executor, type ExecutionRequest } from '../../../src/aeris/runtime/executor.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';
import { decimalAdd, decimalMul, decimalSub, formatNow } from '../../../src/aeris/runtime/values.js';
import { ENTITY, ORG, OTHER_ORG, endpoints, projection } from './fixtures.js';

const ID = '33333333-3333-4333-8333-333333333333';
const plan = (id: string) => endpoints.find((candidate) => candidate.id === id)!;

async function setup() {
  const store = new MemoryStore();
  await store.open([projection]);
  await store.transaction(async (tx) => {
    await tx.insert(ENTITY, { id: ID, organizationId: ORG, agencyId: null, salesPointName: 'Main', status: 'ACTIVE', currency: 'XAF', createdAt: '2026-10-01T08:00:00', updatedAt: '2026-10-01T08:00:00' });
    await tx.insert(ENTITY, { id: '44444444-4444-4444-8444-444444444444', organizationId: OTHER_ORG, agencyId: null, salesPointName: 'Foreign', status: 'ACTIVE', currency: null, createdAt: null, updatedAt: null });
  });
  const executor = new Executor({ projections: new Map([[ENTITY, projection]]), serverTimeZone: 'UTC' });
  return { store, executor };
}

const request = (partial: Partial<ExecutionRequest> = {}): ExecutionRequest => ({
  params: {}, query: {}, body: undefined, context: { organizationId: ORG }, path: '/api/sales-points', ...partial,
});
const captured = { now: Date.parse('2026-10-05T18:58:28.269Z'), uuids: ['55555555-5555-4555-8555-555555555555'] };

describe('Executor', () => {
  it('reads a record owned by the session organization', async () => {
    const { store, executor } = await setup();
    const result = await store.transaction((tx) => executor.execute(plan('GET /api/sales-points/{id}'), request({ params: { id: ID.toUpperCase() } }), captured, tx));
    expect(result).toMatchObject({ status: 200, queued: false, effects: [] });
    expect(result.body).toMatchObject({ id: ID, salesPointName: 'Main' });
  });

  it('answers 404 for a foreign organization (anti-IDOR) and 400 for a malformed id', async () => {
    const { store, executor } = await setup();
    await expect(store.transaction((tx) => executor.execute(plan('GET /api/sales-points/{id}'), request({ params: { id: '44444444-4444-4444-8444-444444444444' } }), captured, tx)))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    await expect(store.transaction((tx) => executor.execute(plan('GET /api/sales-points/{id}'), request({ params: { id: 'not-a-uuid' } }), captured, tx)))
      .rejects.toMatchObject({ status: 400 });
  });

  it('creates with captured identifiers and clock, journaling the effect', async () => {
    const { store, executor } = await setup();
    const result = await store.transaction((tx) => executor.execute(plan('POST /api/sales-points'), request({
      body: { organizationId: ORG, salesPointName: 'Kiosk', currency: 'XAF', unknownField: 'ignored' },
    }), captured, tx));
    expect(result.status).toBe(201);
    expect(result.queued).toBe(true);
    expect(result.body).toEqual({
      id: captured.uuids[0], organizationId: ORG, agencyId: null, salesPointName: 'Kiosk', status: 'ACTIVE', currency: 'XAF',
      createdAt: '2026-10-05T18:58:28.269', updatedAt: '2026-10-05T18:58:28.269',
    });
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({ op: 'insert', before: null });
  });

  it('validates the body like Bean Validation and rejects unknown enum constants', async () => {
    const { store, executor } = await setup();
    await expect(store.transaction((tx) => executor.execute(plan('POST /api/sales-points'), request({ body: { organizationId: ORG, salesPointName: '   ' } }), captured, tx)))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    await expect(store.transaction((tx) => executor.execute(plan('POST /api/sales-points'), request({ body: { organizationId: ORG, salesPointName: 'x', status: 'CLOSED' } }), captured, tx)))
      .rejects.toMatchObject({ status: 400 });
    await expect(store.transaction((tx) => executor.execute(plan('POST /api/sales-points'), request(), captured, tx)))
      .rejects.toMatchObject({ status: 400, code: 'MISSING_BODY' });
  });

  it('updates keeping fields the request leaves null, and deletes', async () => {
    const { store, executor } = await setup();
    const updated = await store.transaction((tx) => executor.execute(plan('PUT /api/sales-points/{id}'), request({
      params: { id: ID }, body: { salesPointName: 'Renamed' },
    }), captured, tx));
    expect(updated.body).toMatchObject({ salesPointName: 'Renamed', status: 'ACTIVE', currency: null, updatedAt: '2026-10-05T18:58:28.269' });
    expect(updated.effects[0]).toMatchObject({ op: 'update', before: { salesPointName: 'Main' } });
    const deleted = await store.transaction((tx) => executor.execute(plan('DELETE /api/sales-points/{id}'), request({ params: { id: ID } }), captured, tx));
    expect(deleted).toMatchObject({ status: 204, body: null, queued: true });
    expect(await store.transaction((tx) => tx.get(ENTITY, ID))).toBeNull();
  });

  it('lists only the scope, in the program order', async () => {
    const { store, executor } = await setup();
    await store.transaction((tx) => tx.insert(ENTITY, { id: '66666666-6666-4666-8666-666666666666', organizationId: ORG, agencyId: null, salesPointName: 'Annex', status: 'INACTIVE', currency: null, createdAt: null, updatedAt: null }));
    const result = await store.transaction((tx) => executor.execute(plan('GET /api/sales-points'), request(), captured, tx));
    expect((result.body as { salesPointName: string }[]).map((row) => row.salesPointName)).toEqual(['Annex', 'Main']);
  });

  it('never leaves partial effects when a program fails midway', async () => {
    const { store, executor } = await setup();
    const failing = { ...plan('POST /api/sales-points'), program: [...plan('POST /api/sales-points').program!.slice(0, 3), { op: 'ASSERT' as const, test: { k: 'lit' as const, v: false }, error: { status: 409, code: 'X', message: { k: 'lit' as const, v: 'boom' } } }, ...plan('POST /api/sales-points').program!.slice(3)] };
    await expect(store.transaction((tx) => executor.execute(failing, request({ body: { organizationId: ORG, salesPointName: 'Ghost' } }), captured, tx))).rejects.toBeInstanceOf(AerisHttpError);
    expect((await store.transaction((tx) => tx.all(ENTITY))).map((row) => row.salesPointName)).toEqual(['Main', 'Foreign']);
  });
});

describe('value semantics', () => {
  it('does exact decimal arithmetic like BigDecimal', () => {
    expect(decimalAdd(0.1, 0.2)).toBe(0.3);
    expect(decimalSub(1.1, 0.1)).toBe(1);
    expect(decimalMul(19.99, 3)).toBe(59.97);
  });

  it('formats the captured clock like Jackson java.time serializers', () => {
    const instant = Date.parse('2026-10-05T18:58:28.200Z');
    expect(formatNow(instant, 'datetime', 'UTC')).toBe('2026-10-05T18:58:28.200Z');
    expect(formatNow(Date.parse('2026-10-05T18:58:28Z'), 'datetime', 'UTC')).toBe('2026-10-05T18:58:28Z');
    expect(formatNow(instant, 'datetime-local', 'Africa/Douala')).toBe('2026-10-05T19:58:28.2');
    expect(formatNow(Date.parse('2026-10-05T23:30:00Z'), 'date', 'Africa/Douala')).toBe('2026-10-06');
  });
});
