import { describe, expect, it } from 'vitest';
import { AerisHttpError, Executor, type ExecutionRequest } from '../../../src/aeris/runtime/executor.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';
import { dateOf, decimalAdd, decimalDividePrecision, decimalMul, decimalRound, decimalSub, formatNow, isIsoTemporal, shiftTemporal } from '../../../src/aeris/runtime/values.js';
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

  it('rounds to a MathContext precision like BigDecimal', () => {
    expect(decimalDividePrecision(1, 3, 16, 'HALF_EVEN')).toBe(0.3333333333333333);
    expect(decimalDividePrecision(2, 3, 16, 'HALF_EVEN')).toBe(0.6666666666666667);
    expect(decimalDividePrecision(10, 4, 16, 'HALF_EVEN')).toBe(2.5);
    expect(decimalDividePrecision(22, 7, 7, 'HALF_EVEN')).toBe(3.142857);
    expect(decimalDividePrecision(-2, 3, 7, 'HALF_EVEN')).toBe(-0.6666667);
    expect(decimalDividePrecision(1e-10, 3, 16, 'HALF_EVEN')).toBe(3.333333333333333e-11);
    expect(decimalDividePrecision(123456, 1, 2, 'HALF_UP')).toBe(120000);
    expect(decimalDividePrecision(1, 8, 0, 'HALF_UP')).toBe(0.125);
    expect(() => decimalDividePrecision(1, 3, 0, 'HALF_UP')).toThrow(/Non-terminating/);
    expect(() => decimalDividePrecision(1, 0, 16, 'HALF_EVEN')).toThrow(/zero/);
    expect(decimalRound(1234.5678, 6, 'HALF_UP')).toBe(1234.57);
    expect(decimalRound(99.95, 3, 'HALF_EVEN')).toBe(100);
    expect(decimalRound(125, 2, 'HALF_EVEN')).toBe(120);
    expect(decimalRound(135, 2, 'HALF_EVEN')).toBe(140);
  });

  it('formats the captured clock like Jackson java.time serializers', () => {
    const instant = Date.parse('2026-10-05T18:58:28.200Z');
    expect(formatNow(instant, 'datetime', 'UTC')).toBe('2026-10-05T18:58:28.200Z');
    expect(formatNow(Date.parse('2026-10-05T18:58:28Z'), 'datetime', 'UTC')).toBe('2026-10-05T18:58:28Z');
    expect(formatNow(instant, 'datetime-local', 'Africa/Douala')).toBe('2026-10-05T19:58:28.2');
    expect(formatNow(Date.parse('2026-10-05T23:30:00Z'), 'date', 'Africa/Douala')).toBe('2026-10-06');
  });

  /**
   * java.time arithmetic, on the three points where a naive implementation is
   * wrong: a month shift clamps the day to the end of the target month, the
   * rendering drops the seconds when the time is whole (Java's own
   * `toString()`), and the fraction of an instant keeps its width. A response
   * body carrying a temporal is compared character for character against the
   * backend's, so the shape is part of the contract.
   */
  it('shifts a temporal exactly as java.time does, rendering as Java prints it', () => {
    expect(shiftTemporal('2026-01-31', 1, 'months')).toBe('2026-02-28');
    expect(shiftTemporal('2024-01-31', 1, 'months')).toBe('2024-02-29');
    expect(shiftTemporal('2024-02-29', 1, 'years')).toBe('2025-02-28');
    expect(shiftTemporal('2026-03-01', -1, 'days')).toBe('2026-02-28');
    expect(shiftTemporal('2026-12-31', 1, 'days')).toBe('2027-01-01');
    expect(shiftTemporal('2026-05-15', -2, 'weeks')).toBe('2026-05-01');
    // A whole time prints without its seconds, exactly like LocalDateTime.toString().
    expect(shiftTemporal('2026-01-01T10:30:00', 1, 'days')).toBe('2026-01-02T10:30');
    expect(shiftTemporal('2026-01-01T10:30:45', 2, 'hours')).toBe('2026-01-01T12:30:45');
    expect(shiftTemporal('2026-01-01T23:30', 45, 'minutes')).toBe('2026-01-02T00:15');
    expect(shiftTemporal('2026-01-01T00:00:00', -1, 'seconds')).toBe('2025-12-31T23:59:59');
    // An instant keeps its offset and the width of its fraction.
    expect(shiftTemporal('2026-10-09T08:42:28.486389Z', 10, 'seconds')).toBe('2026-10-09T08:42:38.486389Z');
    // Not a temporal, or not a whole amount: no answer rather than a wrong one.
    expect(shiftTemporal('later today', 1, 'days')).toBeUndefined();
    expect(shiftTemporal('2026-01-01', 1.5, 'days')).toBeUndefined();
  });

  it('accepts exactly what LocalDate.parse and LocalDateTime.parse accept', () => {
    expect(isIsoTemporal('2026-02-28', 'local-date')).toBe(true);
    // The calendar, not just the shape: February never has 31 days.
    expect(isIsoTemporal('2026-02-31', 'local-date')).toBe(false);
    expect(isIsoTemporal('2024-02-29', 'local-date')).toBe(true);
    expect(isIsoTemporal('2026-02-29', 'local-date')).toBe(false);
    expect(isIsoTemporal('2026-01-01T10:30', 'local-datetime')).toBe(true);
    expect(isIsoTemporal('2026-01-01T10:30:45.123456789', 'local-datetime')).toBe(true);
    expect(isIsoTemporal('2026-01-01T24:00', 'local-datetime')).toBe(false);
    expect(isIsoTemporal('2026-01-01', 'local-datetime')).toBe(false);
  });

  it('builds a date from its parts, and has no answer for one java.time refuses', () => {
    expect(dateOf(2026, 1, 1)).toBe('2026-01-01');
    expect(dateOf(2026, 12, 31)).toBe('2026-12-31');
    expect(dateOf(2024, 2, 29)).toBe('2024-02-29');
    // java.time throws DateTimeException for these; the guard the compiler
    // emits turns the missing answer into that same failure.
    expect(dateOf(2026, 2, 29)).toBeUndefined();
    expect(dateOf(2026, 13, 1)).toBeUndefined();
    expect(dateOf(2026, 0, 1)).toBeUndefined();
    expect(dateOf(2026, 4, 31)).toBeUndefined();
  });
});
