import { describe, expect, it } from 'vitest';
import type { AerisArtifact, JsonValue, PolicyManifest, Projection } from '../../../src/aeris/ir/types.js';
import type { DeltaResponse, ReconcileRequest, ReconcileResponse, SnapshotEnvelope } from '../../../src/aeris/protocol.js';
import { AerisRuntime } from '../../../src/aeris/runtime/runtime.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';
import type { AerisTransport, RuntimeRequest, RuntimeResponse } from '../../../src/aeris/runtime/transport.js';
import { ENTITY, ORG, keyPair, projection, signed } from './fixtures.js';

const LINE = 'SalesPointLine';
const TAG = 'SalesPointLineTag';
const POINT_A = '33333333-3333-4333-8333-333333333333';
const POINT_B = '44444444-4444-4444-8444-444444444444';
const LINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TAG_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const lines: Projection = {
  entity: LINE,
  table: 'sales_point_line',
  key: 'id',
  columns: [
    { name: 'id', column: 'id', type: { type: 'uuid', nullable: false } },
    { name: 'pointId', column: 'point_id', type: { type: 'uuid', nullable: false } },
    { name: 'label', column: 'label', type: { type: 'string', nullable: true } },
  ],
  scope: [],
  public: false,
  parent: { field: 'pointId', entity: ENTITY },
};

/** A grandchild, to check the cascade follows the whole chain. */
const tags: Projection = {
  entity: TAG,
  table: 'sales_point_line_tag',
  key: 'id',
  columns: [
    { name: 'id', column: 'id', type: { type: 'uuid', nullable: false } },
    { name: 'lineId', column: 'line_id', type: { type: 'uuid', nullable: false } },
  ],
  scope: [],
  public: false,
  parent: { field: 'lineId', entity: LINE },
};

const point = (id: string, name: string) => ({
  id, organizationId: ORG, agencyId: null, salesPointName: name,
  status: 'ACTIVE', currency: 'XAF', createdAt: '2026-10-01T08:00:00', updatedAt: '2026-10-01T08:00:00',
});
const line = (id: string, pointId: string, label: string) => ({ id, pointId, label });
const tag = (id: string, lineId: string) => ({ id, lineId });

/** Serves one snapshot, then exactly the deltas the test asks for. */
class Feed implements AerisTransport {
  online = true;

  constructor(
    private readonly envelope: unknown,
    private readonly rows: Record<string, Record<string, JsonValue>[]>,
    private readonly deltas: DeltaResponse[],
  ) {}

  async artifact(): Promise<unknown> {
    return this.envelope;
  }

  async policy(): Promise<PolicyManifest> {
    return { disabled: [], freshness: {}, minArtifactVersion: 0, issuedAt: '2026-10-05T00:00:00Z' };
  }

  async snapshot(projectionVersion: string): Promise<SnapshotEnvelope> {
    return { projectionVersion, cursor: '1', generatedAt: '2026-10-05T10:00:00Z', scopeHash: 'test', entities: this.rows };
  }

  async delta(projectionVersion: string): Promise<DeltaResponse> {
    return this.deltas.shift() ?? { projectionVersion, cursor: '1', changes: [], hasMore: false };
  }

  async reconcile(_request: ReconcileRequest): Promise<ReconcileResponse> {
    return { receipts: [] };
  }

  async network(_request: RuntimeRequest): Promise<RuntimeResponse> {
    throw new Error('this test never goes to the network');
  }
}

async function setup(deltas: (projectionVersion: string) => DeltaResponse[]) {
  const keys = await keyPair();
  const envelope = await signed(keys, 1, { projections: [projection, lines, tags] });
  const projectionVersion = (envelope.artifact as AerisArtifact).projectionVersion;
  const store = new MemoryStore();
  const transport = new Feed(envelope, {
    [ENTITY]: [point(POINT_A, 'Main'), point(POINT_B, 'Annex')],
    [LINE]: [line(LINE_A, POINT_A, 'first'), line(LINE_B, POINT_B, 'second')],
    [TAG]: [tag(TAG_A, LINE_A)],
  }, deltas(projectionVersion));
  const runtime = new AerisRuntime({
    store,
    transport,
    trustedKeys: { 'test-key': keys.publicKeyBase64 },
    session: { context: () => ({ organizationId: ORG, userId: 'user-1' }) },
    isOnline: () => transport.online,
    clock: () => Date.parse('2026-10-05T10:00:00Z'),
    apiOrigin: 'http://api.test',
  });
  await runtime.start();
  return { runtime, store, rows: (entity: string) => store.transaction((tx) => tx.all(entity)) };
}

describe('a parent leaving the scope', () => {
  it('takes its children and grandchildren with it, and only those', async () => {
    const { rows } = await setup((projectionVersion) => [
      { projectionVersion, cursor: '2', changes: [{ entity: ENTITY, op: 'delete', key: POINT_A }], hasMore: false },
    ]);
    expect((await rows(ENTITY)).map((row) => row.id)).toEqual([POINT_B]);
    expect((await rows(LINE)).map((row) => row.id)).toEqual([LINE_B]);
    expect(await rows(TAG)).toEqual([]);
  });

  it('leaves every row in place when nothing left the scope', async () => {
    const { rows } = await setup(() => []);
    expect(await rows(ENTITY)).toHaveLength(2);
    expect(await rows(LINE)).toHaveLength(2);
    expect(await rows(TAG)).toHaveLength(1);
  });

  it('deletes a child without touching the rows of other parents', async () => {
    const { rows } = await setup((projectionVersion) => [
      { projectionVersion, cursor: '2', changes: [{ entity: LINE, op: 'delete', key: LINE_A }], hasMore: false },
    ]);
    expect(await rows(ENTITY)).toHaveLength(2);
    expect((await rows(LINE)).map((row) => row.id)).toEqual([LINE_B]);
    // The grandchild hung off the deleted line.
    expect(await rows(TAG)).toEqual([]);
  });
});
