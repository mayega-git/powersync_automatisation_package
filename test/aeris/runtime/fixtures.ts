import { bytesToBase64 } from '../../../src/aeris/ir/canonical.js';
import { signArtifact } from '../../../src/aeris/ir/signing.js';
import type {
  AerisArtifact,
  AerisSignedArtifact,
  EndpointPlan,
  Expr,
  Instr,
  JsonValue,
  PolicyManifest,
  Projection,
} from '../../../src/aeris/ir/types.js';
import type {
  Change,
  DeltaResponse,
  Receipt,
  ReconcileRequest,
  ReconcileResponse,
  SnapshotEnvelope,
} from '../../../src/aeris/protocol.js';
import { TransportError, type AerisTransport, type RuntimeRequest, type RuntimeResponse } from '../../../src/aeris/runtime/transport.js';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
export const ENTITY = 'SalesPoint';

const lit = (v: JsonValue): Expr => ({ k: 'lit', v });
const input = (...path: string[]): Expr => ({ k: 'input', path });
const v = (name: string): Expr => ({ k: 'var', name });
const get = (of: Expr, field: string): Expr => ({ k: 'get', of, field });
const op = (name: Extract<Expr, { k: 'op' }>['op'], ...args: Expr[]): Expr => ({ k: 'op', op: name, args });
const param = (name: string): Expr => ({ k: 'param', name });
const ctx = (name: string): Expr => ({ k: 'ctx', name });
const now: Expr = { k: 'now', type: 'datetime-local' };

const FIELDS = ['id', 'organizationId', 'agencyId', 'salesPointName', 'status', 'currency', 'createdAt', 'updatedAt'];

const response = (record: Expr): Expr => ({
  k: 'object',
  fields: Object.fromEntries(FIELDS.map((field) => [field, get(record, field)])),
});

export const projection: Projection = {
  entity: ENTITY,
  schema: 'billing_sales',
  table: 'pos_sales_points',
  key: 'id',
  columns: [
    { name: 'id', column: 'id', type: { type: 'uuid', nullable: false } },
    { name: 'organizationId', column: 'organization_id', type: { type: 'uuid', nullable: true } },
    { name: 'agencyId', column: 'agency_id', type: { type: 'uuid', nullable: true } },
    { name: 'salesPointName', column: 'sales_point_name', type: { type: 'string', nullable: true } },
    { name: 'status', column: 'status', type: { type: 'enum', nullable: true, values: ['ACTIVE', 'INACTIVE'] } },
    { name: 'currency', column: 'currency', type: { type: 'string', nullable: true } },
    { name: 'createdAt', column: 'created_at', type: { type: 'datetime-local', nullable: true } },
    { name: 'updatedAt', column: 'updated_at', type: { type: 'datetime-local', nullable: true } },
  ],
  scope: [{ field: 'organizationId', cmp: 'eq', value: ctx('organizationId') }],
  public: false,
};

const owned: Instr[] = [
  { op: 'QUERY', out: 'sp', entity: ENTITY, mode: 'one', where: [{ field: 'id', cmp: 'eq', value: param('id') }] },
  {
    op: 'ASSERT',
    test: op('and', op('notNull', v('sp')), op('eq', ctx('organizationId'), get(v('sp'), 'organizationId'))),
    error: { status: 404, code: 'NOT_FOUND', message: op('concat', lit('Sales point not found: '), param('id')) },
  },
];

const bodyFields = {
  organizationId: { type: 'uuid' as const, nullable: true },
  agencyId: { type: 'uuid' as const, nullable: true },
  salesPointName: { type: 'string' as const, nullable: true },
  status: { type: 'enum' as const, nullable: true, values: ['ACTIVE', 'INACTIVE'] },
  currency: { type: 'string' as const, nullable: true },
};

const evidence = [{
  kind: 'route' as const,
  file: 'SalesPointController.java',
  symbol: 'SalesPointController',
  startLine: 1,
  endLine: 2,
  excerptHash: `sha256:${'0'.repeat(64)}`,
}];

function plan(partial: Omit<EndpointPlan, 'id' | 'handler' | 'evidence' | 'unresolved' | 'testVectors' | 'freshness' | 'reasons'> & Partial<EndpointPlan>): EndpointPlan {
  return {
    id: `${partial.method} ${partial.path}`,
    handler: { file: 'SalesPointController.java', symbol: 'SalesPointController' },
    evidence,
    unresolved: [],
    testVectors: [],
    freshness: { maxAgeSeconds: 3600 },
    reasons: ['test fixture'],
    ...partial,
  };
}

export const auth = { authenticated: true, context: ['organizationId'] };

export const endpoints: EndpointPlan[] = [
  plan({
    method: 'GET',
    path: '/api/sales-points/{id}',
    input: { params: { id: { type: 'uuid', nullable: false } }, query: {} },
    output: { status: 200, list: false, empty: false },
    auth,
    reads: [ENTITY],
    writes: [],
    uuidSlots: 0,
    offlineClass: 'LOCAL_READ_SAFE',
    program: [...owned, { op: 'RETURN', status: 200, body: response(v('sp')) }],
  }),
  plan({
    method: 'GET',
    path: '/api/sales-points',
    input: { params: {}, query: {} },
    output: { status: 200, list: true, empty: false },
    auth,
    reads: [ENTITY],
    writes: [],
    uuidSlots: 0,
    offlineClass: 'LOCAL_READ_SAFE',
    program: [
      { op: 'QUERY', out: 'all', entity: ENTITY, mode: 'many', where: [{ field: 'organizationId', cmp: 'eq', value: ctx('organizationId') }], orderBy: [{ field: 'salesPointName', dir: 'asc' }] },
      { op: 'RETURN', status: 200, body: { k: 'map', of: v('all'), as: 'x', body: response(v('x')) } },
    ],
  }),
  plan({
    method: 'POST',
    path: '/api/sales-points',
    input: { params: {}, query: {}, body: { required: true, fields: bodyFields } },
    output: { status: 201, list: false, empty: false },
    auth,
    reads: [],
    writes: [ENTITY],
    uuidSlots: 1,
    offlineClass: 'REPLAYABLE',
    sync: { idempotencyHeader: 'Idempotency-Key', idempotency: 'backend-key', conflict: 'APPEND', idMap: [{ slot: 0, responsePath: ['id'], entity: ENTITY }] },
    program: [
      { op: 'ASSERT', test: op('notNull', input('organizationId')), error: { status: 400, code: 'VALIDATION', message: lit('organizationId: must not be null') } },
      { op: 'ASSERT', test: op('not', op('isBlank', input('salesPointName'))), error: { status: 400, code: 'VALIDATION', message: lit('salesPointName: must not be blank') } },
      {
        op: 'INSERT',
        entity: ENTITY,
        out: 'sp',
        values: {
          id: { k: 'uuid', slot: 0 },
          organizationId: input('organizationId'),
          agencyId: input('agencyId'),
          salesPointName: input('salesPointName'),
          status: { k: 'cond', test: op('notNull', input('status')), then: input('status'), else: lit('ACTIVE') },
          currency: input('currency'),
          createdAt: now,
          updatedAt: now,
        },
      },
      { op: 'QUEUE_INTENT' },
      { op: 'RETURN', status: 201, body: response(v('sp')) },
    ],
  }),
  plan({
    method: 'PUT',
    path: '/api/sales-points/{id}',
    input: { params: { id: { type: 'uuid', nullable: false } }, query: {}, body: { required: true, fields: bodyFields } },
    output: { status: 200, list: false, empty: false },
    auth,
    reads: [ENTITY],
    writes: [ENTITY],
    uuidSlots: 0,
    offlineClass: 'SPECULATIVE',
    sync: { idempotencyHeader: 'Idempotency-Key', idempotency: 'backend-key', conflict: 'SERVER_REVALIDATE', idMap: [] },
    program: [
      { op: 'ASSERT', test: op('not', op('isBlank', input('salesPointName'))), error: { status: 400, code: 'VALIDATION', message: lit('salesPointName: must not be blank') } },
      ...owned,
      {
        op: 'UPDATE',
        entity: ENTITY,
        key: get(v('sp'), 'id'),
        out: 'updated',
        values: {
          agencyId: input('agencyId'),
          salesPointName: input('salesPointName'),
          status: { k: 'cond', test: op('notNull', input('status')), then: input('status'), else: get(v('sp'), 'status') },
          currency: input('currency'),
          updatedAt: now,
        },
      },
      { op: 'QUEUE_INTENT' },
      { op: 'RETURN', status: 200, body: response(v('updated')) },
    ],
  }),
  plan({
    method: 'DELETE',
    path: '/api/sales-points/{id}',
    input: { params: { id: { type: 'uuid', nullable: false } }, query: {} },
    output: { status: 204, list: false, empty: true },
    auth,
    reads: [ENTITY],
    writes: [ENTITY],
    uuidSlots: 0,
    offlineClass: 'SPECULATIVE',
    sync: { idempotencyHeader: 'Idempotency-Key', idempotency: 'natural', conflict: 'SERVER_REVALIDATE', idMap: [] },
    program: [...owned, { op: 'DELETE', entity: ENTITY, key: get(v('sp'), 'id') }, { op: 'QUEUE_INTENT' }, { op: 'RETURN', status: 204, body: null }],
  }),
  plan({
    method: 'POST',
    path: '/api/payments',
    input: { params: {}, query: {} },
    output: { status: 200, list: false, empty: false },
    auth,
    reads: [],
    writes: [],
    uuidSlots: 0,
    offlineClass: 'ONLINE_REQUIRED',
    reasons: ['The endpoint performs an irreversible external effect.'],
  }),
];

export function artifact(version = 1, overrides: Partial<AerisArtifact> = {}): AerisArtifact {
  return {
    format: 'aeris-ir',
    formatVersion: '1.0.0',
    artifactVersion: version,
    runtimeMinVersion: '1.0.0',
    sourceRevision: 'sha256:test',
    createdAt: '2026-10-05T00:00:00Z',
    adapter: { id: 'test', version: '1', language: 'java', framework: 'spring-boot' },
    projectionVersion: 'proj-1',
    endpoints,
    projections: [projection],
    policies: {
      serverTimeZone: 'UTC',
      defaultFreshnessSeconds: {
        LOCAL_READ_SAFE: 3600, LOCAL_WRITE_SAFE: 3600, REPLAYABLE: 3600, SPECULATIVE: 600, ONLINE_REQUIRED: 0, UNSUPPORTED: 0,
      },
      onlineOnly: [],
    },
    testVectors: [],
    diagnostics: [],
    ...overrides,
  };
}

export interface KeyPair {
  privateKey: CryptoKey;
  publicKeyBase64: string;
}

export async function keyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKeyBase64: bytesToBase64(raw) };
}

export async function signed(keys: KeyPair, version = 1, overrides: Partial<AerisArtifact> = {}): Promise<AerisSignedArtifact> {
  return signArtifact(artifact(version, overrides), keys.privateKey, 'test-key');
}

type Row = Record<string, JsonValue>;

/**
 * A fake backend plus Sync Gateway, behaving like the Spring service: the
 * server generates its own identifiers and timestamps, checks ownership and
 * deduplicates replays on the operation id.
 */
export class FakeServer implements AerisTransport {
  rows = new Map<string, Row>();
  log: { cursor: number; entity: string; key: string; op: 'upsert' | 'delete' }[] = [];
  registry = new Map<string, Receipt>();
  calls: { method: string; path: string; idempotencyKey?: string }[] = [];
  online = true;
  envelope: AerisSignedArtifact | undefined;
  manifest: PolicyManifest = { disabled: [], freshness: {}, minArtifactVersion: 0, issuedAt: '2026-10-05T00:00:00Z' };
  failNextReconcile = false;
  /** Process the batch, then lose the response (the client cannot know it was applied). */
  dropNextResponse = false;
  idCounter = 0;
  effects = 0;

  constructor(private readonly org = ORG, private readonly clock: () => number = () => Date.now()) {}

  private cursor(): number {
    return this.log.length === 0 ? 0 : this.log[this.log.length - 1]!.cursor;
  }

  private write(key: string, row: Row | null): void {
    if (row === null) this.rows.delete(key);
    else this.rows.set(key, row);
    this.log.push({ cursor: this.cursor() + 1, entity: ENTITY, key, op: row === null ? 'delete' : 'upsert' });
  }

  seed(row: Row): void {
    this.write(row.id as string, row);
  }

  serverId(): string {
    this.idCounter += 1;
    return `aaaaaaaa-0000-4000-8000-${String(this.idCounter).padStart(12, '0')}`;
  }

  private ensureOnline(): void {
    if (!this.online) throw new TransportError('network', 'offline');
  }

  async artifact(): Promise<unknown> {
    this.ensureOnline();
    return this.envelope;
  }

  async policy(): Promise<PolicyManifest> {
    this.ensureOnline();
    return this.manifest;
  }

  async snapshot(projectionVersion: string): Promise<SnapshotEnvelope> {
    this.ensureOnline();
    return {
      projectionVersion,
      cursor: String(this.cursor()),
      generatedAt: new Date(this.clock()).toISOString(),
      scopeHash: 'test',
      entities: { [ENTITY]: [...this.rows.values()].filter((row) => row.organizationId === this.org) },
    };
  }

  async delta(projectionVersion: string, since: string): Promise<DeltaResponse> {
    this.ensureOnline();
    const changes: Change[] = [];
    for (const entry of this.log.filter((candidate) => candidate.cursor > Number(since))) {
      const row = this.rows.get(entry.key);
      if (row === undefined || row.organizationId !== this.org) changes.push({ entity: ENTITY, op: 'delete', key: entry.key });
      else changes.push({ entity: ENTITY, op: 'upsert', key: entry.key, row });
    }
    return { projectionVersion, cursor: String(this.cursor()), changes, hasMore: false };
  }

  async reconcile(request: ReconcileRequest): Promise<ReconcileResponse> {
    this.ensureOnline();
    if (this.failNextReconcile) {
      this.failNextReconcile = false;
      throw new TransportError('network', 'connection reset');
    }
    const receipts: Receipt[] = [];
    for (const operation of request.operations) {
      const known = this.registry.get(operation.operationId);
      if (known !== undefined) {
        receipts.push({ ...known, replayed: true });
        continue;
      }
      const response = this.execute(operation.method, operation.path, operation.body, operation.operationId);
      let receipt: Receipt;
      if (response.status < 300) {
        receipt = {
          operationId: operation.operationId,
          status: 'COMMITTED',
          serverCursor: String(this.cursor()),
          canonicalResponse: response,
          committedAt: new Date(this.clock()).toISOString(),
        };
      } else if (response.status === 404 || response.status === 409) {
        receipt = { operationId: operation.operationId, status: 'CONFLICT', error: { status: response.status, code: 'CONFLICT', message: 'gone' } };
      } else {
        receipt = { operationId: operation.operationId, status: 'REJECTED', error: { status: response.status, code: 'REJECTED', message: 'invalid' } };
      }
      this.registry.set(operation.operationId, receipt);
      receipts.push(receipt);
    }
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new TransportError('network', 'response lost');
    }
    return { receipts };
  }

  async network(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.ensureOnline();
    const url = new URL(request.url, 'http://api.test');
    const body = request.body ? JSON.parse(request.body) as JsonValue : null;
    const result = this.execute(request.method, url.pathname, body, request.headers['Idempotency-Key']);
    return {
      status: result.status,
      headers: { 'content-type': 'application/json' },
      body: result.body === null ? null : JSON.stringify(result.body),
    };
  }

  /** The "backend": same semantics as SalesPointService, with server-side ids and clock. */
  execute(method: string, path: string, body: JsonValue, idempotencyKey?: string): { status: number; body: JsonValue | null } {
    this.calls.push({ method, path, ...(idempotencyKey ? { idempotencyKey } : {}) });
    const now = new Date(this.clock()).toISOString().replace('Z', '');
    const match = /^\/api\/sales-points(?:\/([^/]+))?$/.exec(path);
    if (match === null) return { status: 404, body: null };
    const id = match[1];
    const payload = (body ?? {}) as Record<string, JsonValue>;
    const owned = id === undefined ? undefined : this.rows.get(id.toLowerCase());
    const visible = owned !== undefined && owned.organizationId === this.org ? owned : undefined;
    if (method === 'GET' && id === undefined) {
      return { status: 200, body: [...this.rows.values()].filter((row) => row.organizationId === this.org) };
    }
    if (method === 'GET') return visible === undefined ? { status: 404, body: null } : { status: 200, body: visible };
    if (method === 'POST') {
      if (typeof payload.salesPointName !== 'string' || payload.salesPointName.trim() === '') return { status: 400, body: null };
      this.effects += 1;
      const row: Row = {
        id: this.serverId(),
        organizationId: payload.organizationId ?? null,
        agencyId: payload.agencyId ?? null,
        salesPointName: payload.salesPointName,
        status: payload.status ?? 'ACTIVE',
        currency: payload.currency ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.write(row.id as string, row);
      return { status: 201, body: row };
    }
    if (visible === undefined) return { status: 404, body: null };
    if (method === 'PUT') {
      this.effects += 1;
      const row: Row = {
        ...visible,
        agencyId: payload.agencyId ?? null,
        salesPointName: payload.salesPointName ?? null,
        status: payload.status ?? visible.status ?? null,
        currency: payload.currency ?? null,
        updatedAt: now,
      };
      this.write(row.id as string, row);
      return { status: 200, body: row };
    }
    if (method === 'DELETE') {
      this.effects += 1;
      this.write(visible.id as string, null);
      return { status: 204, body: null };
    }
    return { status: 405, body: null };
  }
}
