import { canonicalJson, sha256Hex } from '../ir/canonical.js';
import { importPublicKey, verifyArtifact } from '../ir/signing.js';
import {
  AERIS_IR_VERSION,
  LOCAL_CLASSES,
  type AerisArtifact,
  type EndpointPlan,
  type JsonValue,
  type PolicyManifest,
  type Projection,
} from '../ir/types.js';
import {
  IDEMPOTENCY_HEADER,
  OPERATION_HEADER,
  STATE_HEADER,
  type Change,
  type Receipt,
  type WireOperation,
} from '../protocol.js';
import { compareResults } from './compare.js';
import {
  AerisExecutionError,
  AerisHttpError,
  Executor,
  type Effect,
  type ExecutionRequest,
  type ExecutionResult,
} from './executor.js';
import {
  backoff,
  capturedOf,
  FAILED_STATES,
  findDependencies,
  fromRecord,
  PENDING_STATES,
  remapEntry,
  remapRow,
  remapValue,
  rowId,
  toRecord,
  type OperationState,
  type OutboxEntry,
} from './outbox.js';
import { EndpointRouter } from './router.js';
import type { LocalStore, StoredRow, StoreTx } from './store/LocalStore.js';
import { TransportError, type AerisTransport, type RuntimeRequest, type RuntimeResponse } from './transport.js';
import { randomUuid } from './values.js';

export const AERIS_RUNTIME_VERSION = '1.0.0';

export type RuntimeEvent =
  | { type: 'operation'; operationId: string; endpointId: string; state: OperationState; error?: { status: number; code: string; message: string } }
  | { type: 'blocked'; endpointId: string; reason: string }
  | { type: 'local'; endpointId: string; status: number; durationMs: number }
  | { type: 'sync'; phase: 'start' | 'snapshot' | 'delta' | 'reconcile' | 'done' | 'error'; detail?: string }
  | { type: 'shadow-mismatch'; endpointId: string; differences: readonly string[] }
  | { type: 'auth-required' }
  | { type: 'artifact'; artifactVersion: number }
  | { type: 'purged'; reason: string };

export interface SessionProvider {
  /** Trusted claims of the signed-in session (e.g. decoded from a verified token), or null when signed out. */
  context(): Promise<Record<string, JsonValue> | null> | Record<string, JsonValue> | null;
}

export interface AerisRuntimeOptions {
  store: LocalStore;
  transport: AerisTransport;
  /** keyId -> Ed25519 public key (SPKI PEM or base64 raw), shipped with the application. */
  trustedKeys: Readonly<Record<string, string>>;
  session: SessionProvider;
  /** Claims that identify the session owner; a change purges local data. Default: every claim. */
  subjectClaims?: readonly string[];
  /** Only URLs on this origin are intercepted (default: any origin). */
  apiOrigin?: string;
  /** Prefix stripped before matching routes, e.g. "" when the backend serves /api/... at the origin root. */
  apiPathPrefix?: string;
  isOnline?: () => boolean;
  /** Reads go to the network when online unless 'local-first'. */
  readStrategy?: 'network-first' | 'local-first';
  /** Execute locally in parallel to online calls and compare (architecture section 18.3). */
  shadow?: boolean | ((endpointId: string) => boolean);
  /** Max operations per reconcile call. */
  batchSize?: number;
  clock?: () => number;
  random?: () => number;
  uuid?: () => string;
  /** Web Locks implementation, defaults to navigator.locks when present. */
  locks?: LockManager;
  name?: string;
}

interface RuntimeStatus {
  artifactVersion: number | undefined;
  online: boolean;
  lastSyncAt: number | undefined;
  cursor: string | undefined;
  outbox: { pending: number; failed: number; committed: number; oldestAgeMs: number | undefined };
  metrics: Metrics;
}

interface Metrics {
  localExecutions: number;
  networkRequests: number;
  blocked: number;
  conflicts: number;
  rejections: number;
  commits: number;
  shadowRuns: number;
  shadowMismatches: number;
  localLatencyP50: number | undefined;
  localLatencyP95: number | undefined;
}

const META = {
  envelope: 'artifactEnvelope',
  maxVersion: 'maxArtifactVersion',
  policy: 'policyManifest',
  cursor: 'cursor',
  projectionVersion: 'projectionVersion',
  lastSyncAt: 'lastSyncAt',
  subject: 'subject',
  sequence: 'sequence',
  clientInstanceId: 'clientInstanceId',
  lease: 'syncLease',
} as const;

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * The AERIS browser runtime: intercepts API calls, executes compiled plans on
 * local projections when the network is unavailable, journals mutations in a
 * transactional outbox and reconciles them through the Sync Gateway.
 */
export class AerisRuntime {
  private artifact: AerisArtifact | undefined;
  private router: EndpointRouter | undefined;
  private plans = new Map<string, EndpointPlan>();
  private projections = new Map<string, Projection>();
  private executor: Executor | undefined;
  private manifest: PolicyManifest | undefined;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private syncing: Promise<void> | undefined;
  private syncAgain = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private detach: (() => void)[] = [];
  private latencies: number[] = [];
  private clientInstanceId = '';
  private readonly metrics: Metrics = {
    localExecutions: 0, networkRequests: 0, blocked: 0, conflicts: 0, rejections: 0, commits: 0,
    shadowRuns: 0, shadowMismatches: 0, localLatencyP50: undefined, localLatencyP95: undefined,
  };
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly uuid: () => string;

  constructor(private readonly options: AerisRuntimeOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.uuid = options.uuid ?? randomUuid;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Loads the persisted artifact (offline start), then tries to refresh it,
   * the policy manifest and the data from the gateway.
   */
  async start(): Promise<void> {
    await this.options.store.open([]);
    const persisted = await this.options.store.transaction(async (tx) => ({
      envelope: await tx.metaGet(META.envelope),
      policy: await tx.metaGet(META.policy),
      clientInstanceId: await tx.metaGet(META.clientInstanceId),
    }));
    if (typeof persisted.clientInstanceId === 'string') this.clientInstanceId = persisted.clientInstanceId;
    else {
      this.clientInstanceId = this.uuid();
      await this.options.store.transaction((tx) => tx.metaSet(META.clientInstanceId, this.clientInstanceId));
    }
    if (persisted.policy !== undefined) this.manifest = persisted.policy as unknown as PolicyManifest;
    if (persisted.envelope !== undefined) {
      try {
        await this.activate(persisted.envelope, false);
      } catch (error) {
        // A persisted artifact that no longer verifies (key rotation, tampering) is discarded.
        await this.options.store.transaction((tx) => tx.metaSet(META.envelope, undefined));
        this.emit({ type: 'sync', phase: 'error', detail: `persisted artifact rejected: ${(error as Error).message}` });
      }
    }
    // Operations caught mid-flight by a crash are simply sent again (the operation id deduplicates).
    await this.options.store.transaction(async (tx) => {
      for (const record of await tx.outboxList()) {
        const entry = fromRecord(record);
        if (entry.state === 'SYNCING') await tx.outboxPut(toRecord({ ...entry, state: 'QUEUED', updatedAt: this.clock() }));
      }
    });
    this.installTriggers();
    if (this.online()) await this.refresh().catch(() => undefined);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    for (const undo of this.detach) undo();
    this.detach = [];
  }

  on(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetches a newer artifact and policy manifest, then synchronizes. */
  async refresh(): Promise<void> {
    try {
      const envelope = await this.options.transport.artifact();
      if (envelope !== undefined) await this.activate(envelope, true);
    } catch (error) {
      this.emit({ type: 'sync', phase: 'error', detail: `artifact: ${(error as Error).message}` });
    }
    try {
      const manifest = await this.options.transport.policy();
      this.manifest = manifest;
      await this.options.store.transaction((tx) => tx.metaSet(META.policy, manifest as unknown as JsonValue));
    } catch (error) {
      if (error instanceof TransportError && error.kind === 'auth') this.emit({ type: 'auth-required' });
    }
    await this.sync();
  }

  /** Erases local data and pending operations (logout, user switch). */
  async purge(reason = 'logout'): Promise<void> {
    const envelope = await this.options.store.transaction((tx) => tx.metaGet(META.envelope));
    const maxVersion = await this.options.store.transaction((tx) => tx.metaGet(META.maxVersion));
    await this.options.store.purge();
    // The verified artifact and anti-downgrade floor are not user data; keep them.
    await this.options.store.transaction(async (tx) => {
      if (envelope !== undefined) await tx.metaSet(META.envelope, envelope);
      if (maxVersion !== undefined) await tx.metaSet(META.maxVersion, maxVersion);
      await tx.metaSet(META.clientInstanceId, this.clientInstanceId);
    });
    this.emit({ type: 'purged', reason });
  }

  private async activate(envelope: unknown, persist: boolean): Promise<void> {
    const keys = new Map<string, CryptoKey>();
    for (const [keyId, key] of Object.entries(this.options.trustedKeys)) keys.set(keyId, await importPublicKey(key));
    const artifact = await verifyArtifact(envelope, keys);
    if (Number(artifact.formatVersion.split('.')[0]) !== Number(AERIS_IR_VERSION.split('.')[0])) {
      throw new Error(`Unsupported IR format ${artifact.formatVersion}.`);
    }
    if (compareVersions(artifact.runtimeMinVersion, AERIS_RUNTIME_VERSION) > 0) {
      throw new Error(`Artifact requires runtime ${artifact.runtimeMinVersion}.`);
    }
    if (this.artifact !== undefined && artifact.artifactVersion === this.artifact.artifactVersion) return;
    const floor = await this.options.store.transaction((tx) => tx.metaGet(META.maxVersion));
    if (typeof floor === 'number' && artifact.artifactVersion < floor) {
      throw new Error(`Refusing artifact ${artifact.artifactVersion}: version ${floor} was already active (downgrade).`);
    }
    await this.options.store.open(artifact.projections);
    this.artifact = artifact;
    this.router = new EndpointRouter(artifact.endpoints);
    this.plans = new Map(artifact.endpoints.map((plan) => [plan.id, plan]));
    this.projections = new Map(artifact.projections.map((projection) => [projection.entity, projection]));
    this.executor = new Executor({ projections: this.projections, serverTimeZone: artifact.policies.serverTimeZone });
    await this.options.store.transaction(async (tx) => {
      if (persist) await tx.metaSet(META.envelope, envelope as JsonValue);
      await tx.metaSet(META.maxVersion, Math.max(artifact.artifactVersion, typeof floor === 'number' ? floor : 0));
    });
    this.emit({ type: 'artifact', artifactVersion: artifact.artifactVersion });
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  /** fetch-compatible entry point for applications that call it directly. */
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = await toRuntimeRequest(input, init);
    const response = await this.handle(request);
    return new Response(response.body, { status: response.status, headers: response.headers });
  }

  /**
   * Routes one request: to the network when possible, to the local plan when
   * the network is unavailable and the endpoint's class allows it.
   */
  async handle(request: RuntimeRequest): Promise<RuntimeResponse> {
    const target = this.locate(request.url);
    const match = target === undefined ? undefined : this.router?.match(request.method, target.path);
    if (target === undefined || match === undefined || this.artifact === undefined) {
      return this.network(request);
    }
    const plan = match.plan;
    const mutation = plan.writes.length > 0 || !['GET', 'HEAD'].includes(plan.method);
    const operationId = mutation ? this.uuid() : undefined;
    const outbound = operationId === undefined
      ? request
      : { ...request, headers: { ...request.headers, [IDEMPOTENCY_HEADER]: operationId } };

    if (this.online()) {
      if (!mutation && this.options.readStrategy === 'local-first' && (await this.localDecision(plan)).allowed) {
        const local = await this.executeLocal(plan, match.params, target.query, request, undefined);
        if (local !== undefined) return local;
      }
      try {
        const response = await this.network(outbound);
        if (this.shadowEnabled(plan.id) && response.status < 500) {
          void this.shadow(plan, match.params, target.query, request, response).catch(() => undefined);
        }
        if (mutation && response.status < 400) this.schedule(250);
        return response;
      } catch (error) {
        if (!(error instanceof TransportError) || error.kind !== 'network') throw error;
        // The network failed: fall through to local execution with the same operation id.
      }
    }

    // Session ownership is settled before anything local is read.
    const context = await this.options.session.context();
    if (context !== null) await this.ensureSubject(await this.subjectOf(context));
    const decision = await this.localDecision(plan);
    if (!decision.allowed) return this.blocked(plan, decision.reason);
    const local = await this.executeLocal(plan, match.params, target.query, request, operationId);
    return local ?? this.blocked(plan, 'The request could not be executed locally.');
  }

  private locate(url: string): { path: string; query: Record<string, string> } | undefined {
    let parsed: URL;
    try {
      parsed = new URL(url, this.options.apiOrigin ?? 'http://aeris.invalid');
    } catch {
      return undefined;
    }
    if (this.options.apiOrigin !== undefined && parsed.origin !== new URL(this.options.apiOrigin).origin) return undefined;
    let path = decodePathSafely(parsed.pathname);
    if (path === undefined) return undefined;
    const prefix = this.options.apiPathPrefix ?? '';
    if (prefix.length > 0) {
      if (!path.startsWith(prefix)) return undefined;
      path = path.slice(prefix.length) || '/';
    }
    const query: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      if (!(key in query)) query[key] = value;
    });
    return { path, query };
  }

  private async network(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.metrics.networkRequests += 1;
    return this.options.transport.network(request);
  }

  private async localDecision(plan: EndpointPlan): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    if (!LOCAL_CLASSES.has(plan.offlineClass)) return { allowed: false, reason: `${plan.offlineClass}: ${plan.reasons[0] ?? 'not available offline'}` };
    if (this.manifest?.disabled.includes(plan.id)) return { allowed: false, reason: 'Disabled by the server policy manifest.' };
    if (this.manifest !== undefined && this.artifact !== undefined && this.artifact.artifactVersion < this.manifest.minArtifactVersion) {
      return { allowed: false, reason: 'The local artifact is older than the minimum version the server accepts.' };
    }
    const meta = await this.options.store.transaction(async (tx) => ({
      lastSyncAt: await tx.metaGet(META.lastSyncAt),
      projectionVersion: await tx.metaGet(META.projectionVersion),
    }));
    if (meta.projectionVersion !== this.artifact?.projectionVersion || typeof meta.lastSyncAt !== 'number') {
      return { allowed: false, reason: 'Local data has not been synchronized for this artifact yet.' };
    }
    const maxAge = this.manifest?.freshness[plan.id] ?? plan.freshness.maxAgeSeconds;
    if (this.clock() - meta.lastSyncAt > maxAge * 1000) {
      return { allowed: false, reason: `Local data is older than ${maxAge}s.` };
    }
    return { allowed: true };
  }

  private async executeLocal(
    plan: EndpointPlan,
    params: Record<string, string>,
    query: Record<string, string>,
    request: RuntimeRequest,
    operationId: string | undefined,
  ): Promise<RuntimeResponse | undefined> {
    const context = await this.options.session.context();
    if (context === null && plan.auth.authenticated) return this.blocked(plan, 'No authenticated session is available offline.');
    for (const claim of plan.auth.context) {
      if (context?.[claim] === undefined || context[claim] === null) return this.blocked(plan, `Session claim ${claim} is missing.`);
    }
    if (plan.auth.anyAuthority !== undefined && plan.auth.anyAuthority.length > 0) {
      const granted = toStringList(context?.authorities ?? context?.roles);
      if (!plan.auth.anyAuthority.some((authority) => granted.includes(authority))) {
        return this.errorResponse(403, 'FORBIDDEN', 'Access denied.', request.url);
      }
    }
    const subject = await this.subjectOf(context);
    await this.ensureSubject(subject);

    let body: JsonValue | undefined;
    if (request.body !== undefined && request.body !== null && request.body.length > 0) {
      try {
        body = JSON.parse(request.body) as JsonValue;
      } catch {
        return this.errorResponse(400, 'INVALID_BODY', 'Malformed JSON request body.', request.url);
      }
    }
    const frozenContext: Record<string, JsonValue> = {};
    for (const claim of plan.auth.context) frozenContext[claim] = context?.[claim] ?? null;
    const execution: ExecutionRequest = { params, query, body, context: frozenContext, path: pathOf(request.url) };
    const captured = { now: this.clock(), uuids: Array.from({ length: plan.uuidSlots }, () => this.uuid()) };
    const started = this.clock();
    try {
      const result = await this.options.store.transaction(async (tx) => {
        const outcome = await this.executor!.execute(plan, execution, captured, tx);
        if (outcome.queued) {
          if (operationId === undefined) throw new AerisExecutionError(`${plan.id} queued an intent on a read.`);
          await this.enqueue(tx, plan, operationId, params, query, body ?? null, frozenContext, captured, outcome, subject, request.url);
        }
        return outcome;
      });
      this.metrics.localExecutions += 1;
      this.recordLatency(this.clock() - started);
      this.emit({ type: 'local', endpointId: plan.id, status: result.status, durationMs: this.clock() - started });
      if (result.queued && operationId !== undefined) {
        this.emit({ type: 'operation', operationId, endpointId: plan.id, state: 'QUEUED' });
      }
      const headers: Record<string, string> = {
        ...JSON_HEADERS,
        [STATE_HEADER.toLowerCase()]: result.queued ? 'provisional' : 'local',
      };
      if (result.queued && operationId !== undefined) headers[OPERATION_HEADER.toLowerCase()] = operationId;
      return {
        status: result.status,
        headers: result.body === null ? omitContentType(headers) : headers,
        body: result.body === null ? null : JSON.stringify(result.body),
      };
    } catch (error) {
      if (error instanceof AerisHttpError) return this.errorResponse(error.status, error.code, error.message, request.url);
      throw error;
    }
  }

  private async enqueue(
    tx: StoreTx,
    plan: EndpointPlan,
    operationId: string,
    params: Record<string, string>,
    query: Record<string, string>,
    body: JsonValue | null,
    context: Record<string, JsonValue>,
    captured: { now: number; uuids: readonly string[] },
    outcome: ExecutionResult,
    subject: string,
    url: string,
  ): Promise<void> {
    const entries = (await tx.outboxList()).map(fromRecord);
    const pending = entries.filter((entry) => PENDING_STATES.has(entry.state));
    const sequence = ((await tx.metaGet(META.sequence)) as number | undefined ?? 0) + 1;
    await tx.metaSet(META.sequence, sequence);
    const cursor = await tx.metaGet(META.cursor);
    const entry: OutboxEntry = {
      operationId,
      sequence,
      state: 'QUEUED',
      endpointId: plan.id,
      method: plan.method,
      path: pathOf(url),
      params,
      query,
      body,
      context,
      captured: { now: captured.now, uuids: [...captured.uuids] },
      localIds: [...captured.uuids],
      dependencies: findDependencies(pending, { params, query, body }, outcome.effects),
      artifactVersion: this.artifact!.artifactVersion,
      projectionVersion: this.artifact!.projectionVersion,
      baseCursor: typeof cursor === 'string' ? cursor : null,
      preconditionHash: await preconditionHash(outcome.effects),
      effects: outcome.effects,
      localResponse: { status: outcome.status, body: outcome.body },
      subject,
      createdAt: this.clock(),
      attempts: 0,
      nextAttemptAt: 0,
      updatedAt: this.clock(),
    };
    await tx.outboxPut(toRecord(entry));
  }

  private blocked(plan: EndpointPlan, reason: string): RuntimeResponse {
    this.metrics.blocked += 1;
    this.emit({ type: 'blocked', endpointId: plan.id, reason });
    return {
      status: 503,
      headers: { ...JSON_HEADERS, [STATE_HEADER.toLowerCase()]: 'blocked', 'retry-after': '30' },
      body: JSON.stringify({ status: 503, error: 'Service Unavailable', code: 'AERIS_OFFLINE_UNAVAILABLE', message: reason }),
    };
  }

  private errorResponse(status: number, code: string, message: string, url: string): RuntimeResponse {
    return {
      status,
      headers: { ...JSON_HEADERS, [STATE_HEADER.toLowerCase()]: 'local' },
      body: JSON.stringify({
        timestamp: new Date(this.clock()).toISOString(),
        path: pathOf(url),
        status,
        error: reasonPhrase(status),
        code,
        message,
      }),
    };
  }

  private shadowEnabled(endpointId: string): boolean {
    const shadow = this.options.shadow;
    return typeof shadow === 'function' ? shadow(endpointId) : shadow === true;
  }

  /** Runs the plan on a throw-away transaction and compares with the server answer. */
  private async shadow(
    plan: EndpointPlan,
    params: Record<string, string>,
    query: Record<string, string>,
    request: RuntimeRequest,
    response: RuntimeResponse,
  ): Promise<void> {
    if (!LOCAL_CLASSES.has(plan.offlineClass) || this.executor === undefined) return;
    const context = await this.options.session.context();
    if (context === null) return;
    let body: JsonValue | undefined;
    try {
      body = request.body ? JSON.parse(request.body) as JsonValue : undefined;
    } catch {
      return;
    }
    const execution: ExecutionRequest = { params, query, body, context, path: pathOf(request.url) };
    const captured = { now: this.clock(), uuids: Array.from({ length: plan.uuidSlots }, () => this.uuid()) };
    const rollback = new Error('aeris-shadow-rollback');
    let local: { status: number; body: JsonValue | null } | undefined;
    try {
      await this.options.store.transaction(async (tx) => {
        try {
          const result = await this.executor!.execute(plan, execution, captured, tx);
          local = { status: result.status, body: result.body };
        } catch (error) {
          if (error instanceof AerisHttpError) local = { status: error.status, body: null };
          else throw error;
        }
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    if (local === undefined) return;
    this.metrics.shadowRuns += 1;
    let serverBody: JsonValue | null = null;
    try {
      serverBody = response.body ? JSON.parse(response.body) as JsonValue : null;
    } catch {
      return;
    }
    const comparison = compareResults(plan, local, { status: response.status, body: serverBody }, {
      generated: new Set(captured.uuids.map((id) => id.toLowerCase())),
    });
    if (!comparison.equal) {
      this.metrics.shadowMismatches += 1;
      this.emit({ type: 'shadow-mismatch', endpointId: plan.id, differences: comparison.differences });
    }
  }

  // -------------------------------------------------------------------------
  // Synchronization
  // -------------------------------------------------------------------------

  /** One synchronization cycle; concurrent calls coalesce. Never throws. */
  sync(): Promise<void> {
    if (this.syncing !== undefined) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.withSyncLock(() => this.syncCycle());
        } while (this.syncAgain && this.online());
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  private async syncCycle(): Promise<void> {
    if (this.artifact === undefined || !this.online()) return;
    this.emit({ type: 'sync', phase: 'start' });
    try {
      const context = await this.options.session.context();
      if (context === null) return;
      await this.ensureSubject(await this.subjectOf(context));
      const meta = await this.options.store.transaction(async (tx) => ({
        cursor: await tx.metaGet(META.cursor),
        projectionVersion: await tx.metaGet(META.projectionVersion),
      }));
      if (typeof meta.cursor !== 'string' || meta.projectionVersion !== this.artifact.projectionVersion) {
        await this.snapshot();
      }
      // A failed reconcile must not keep fresh server data away: pull deltas regardless.
      let reconcileError: unknown;
      try {
        await this.reconcile();
      } catch (error) {
        reconcileError = error;
      }
      await this.pullDeltas();
      if (reconcileError !== undefined) throw reconcileError;
      this.emit({ type: 'sync', phase: 'done' });
    } catch (error) {
      if (error instanceof TransportError && error.kind === 'auth') this.emit({ type: 'auth-required' });
      this.emit({ type: 'sync', phase: 'error', detail: (error as Error).message });
      this.schedule(backoff(1, this.random, 5_000, 60_000));
    }
  }

  private async snapshot(): Promise<void> {
    const artifact = this.artifact!;
    this.emit({ type: 'sync', phase: 'snapshot' });
    const envelope = await this.options.transport.snapshot(artifact.projectionVersion);
    if (envelope.projectionVersion !== artifact.projectionVersion) {
      throw new TransportError('protocol', 'Snapshot was cut for another projection version.');
    }
    await this.options.store.transaction((tx) => this.rebase(tx, async () => {
      for (const projection of artifact.projections) {
        await tx.clear(projection.entity);
        for (const row of envelope.entities[projection.entity] ?? []) await tx.put(projection.entity, this.wireRow(projection, row));
      }
      await tx.metaSet(META.cursor, envelope.cursor);
      await tx.metaSet(META.projectionVersion, artifact.projectionVersion);
      await tx.metaSet(META.lastSyncAt, this.clock());
    }));
    this.flushDeferred();
  }

  private async pullDeltas(): Promise<void> {
    const artifact = this.artifact!;
    for (let page = 0; page < 1_000; page += 1) {
      const cursor = await this.options.store.transaction((tx) => tx.metaGet(META.cursor));
      if (typeof cursor !== 'string') return;
      this.emit({ type: 'sync', phase: 'delta' });
      const delta = await this.options.transport.delta(artifact.projectionVersion, cursor);
      if (delta.resnapshot === true || delta.projectionVersion !== artifact.projectionVersion) {
        await this.snapshot();
        return;
      }
      await this.options.store.transaction((tx) => this.rebase(tx, async () => {
        await this.applyChanges(tx, delta.changes);
        await tx.metaSet(META.cursor, delta.cursor);
        await tx.metaSet(META.lastSyncAt, this.clock());
      }));
      this.flushDeferred();
      if (!delta.hasMore) return;
    }
  }

  private async applyChanges(tx: StoreTx, changes: readonly Change[]): Promise<void> {
    for (const change of changes) {
      const projection = this.projections.get(change.entity);
      if (projection === undefined) continue;
      if (change.op === 'delete') await tx.delete(change.entity, change.key);
      else if (change.row !== undefined) await tx.put(change.entity, this.wireRow(projection, change.row));
    }
  }

  private wireRow(projection: Projection, row: Record<string, JsonValue>): StoredRow {
    const out: StoredRow = {};
    for (const column of projection.columns) out[column.name] = row[column.name] ?? null;
    return out;
  }

  /**
   * Applies server state under the pending local operations: undo them
   * (reverse order), apply the server change, redo them (original order) with
   * their captured inputs. Operations whose redo now fails are marked
   * CONFLICT; committed operations are dropped once the cursor covers them.
   */
  private async rebase(tx: StoreTx, applyServer: () => Promise<void>, drop: ReadonlyMap<string, Receipt> = new Map()): Promise<void> {
    const entries = (await tx.outboxList()).map(fromRecord);
    const applied = entries.filter((entry) => PENDING_STATES.has(entry.state) || drop.has(entry.operationId));
    for (const entry of [...applied].reverse()) await this.undo(tx, entry.effects);

    await applyServer();

    const cursor = await tx.metaGet(META.cursor);
    for (const entry of entries) {
      if (entry.state === 'SERVER_COMMITTED' && entry.serverCursor !== undefined && typeof cursor === 'string' &&
        compareCursors(entry.serverCursor, cursor) <= 0) {
        await tx.outboxDelete(entry.operationId);
      }
    }

    const failed = new Set<string>();
    for (const entry of applied) {
      const receipt = drop.get(entry.operationId);
      if (receipt !== undefined) {
        const state: OperationState = receipt.status === 'CONFLICT' ? 'CONFLICT' : 'REJECTED';
        failed.add(entry.operationId);
        await tx.outboxPut(toRecord({ ...entry, state, effects: [], error: receipt.error, updatedAt: this.clock() }));
        continue;
      }
      if (entry.dependencies.some((dependency) => failed.has(dependency))) {
        failed.add(entry.operationId);
        await tx.outboxPut(toRecord({
          ...entry,
          state: 'REJECTED',
          effects: [],
          error: { status: 424, code: 'DEPENDENCY_FAILED', message: 'An operation this one depends on was rejected.' },
          updatedAt: this.clock(),
        }));
        continue;
      }
      const plan = this.plans.get(entry.endpointId);
      if (plan === undefined || plan.program === undefined || plan.uuidSlots > entry.captured.uuids.length) {
        // The plan changed shape: keep the intent for the server, without a local effect.
        await tx.outboxPut(toRecord({ ...entry, effects: [], updatedAt: this.clock() }));
        continue;
      }
      try {
        const result = await this.executor!.execute(plan, {
          params: entry.params,
          query: entry.query,
          body: entry.body ?? undefined,
          context: entry.context,
          path: entry.path,
        }, capturedOf(entry), tx);
        await tx.outboxPut(toRecord({
          ...entry,
          effects: result.effects,
          localResponse: { status: result.status, body: result.body },
          updatedAt: this.clock(),
        }));
      } catch (error) {
        if (!(error instanceof AerisHttpError)) throw error;
        failed.add(entry.operationId);
        await tx.outboxPut(toRecord({
          ...entry,
          state: 'CONFLICT',
          effects: [],
          error: { status: error.status, code: error.code, message: `Local revalidation failed: ${error.message}` },
          updatedAt: this.clock(),
        }));
      }
    }
    for (const operationId of failed) {
      const entry = entries.find((candidate) => candidate.operationId === operationId)!;
      const after = fromRecord((await tx.outboxGet(operationId))!);
      this.deferEmit({ type: 'operation', operationId, endpointId: entry.endpointId, state: after.state, ...(after.error ? { error: after.error } : {}) });
      if (after.state === 'CONFLICT') this.metrics.conflicts += 1;
      else this.metrics.rejections += 1;
    }
  }

  private async undo(tx: StoreTx, effects: readonly Effect[]): Promise<void> {
    for (const effect of [...effects].reverse()) {
      if (effect.op === 'insert') await tx.delete(effect.entity, effect.key);
      else if (effect.before !== null) await tx.put(effect.entity, effect.before);
    }
  }

  private async reconcile(): Promise<void> {
    const artifact = this.artifact!;
    const batchSize = this.options.batchSize ?? 25;
    for (let round = 0; round < 100; round += 1) {
      const batch = await this.options.store.transaction(async (tx) => {
        const entries = (await tx.outboxList()).map(fromRecord);
        const ready = readyOperations(entries, this.clock()).slice(0, batchSize);
        for (const entry of ready) await tx.outboxPut(toRecord({ ...entry, state: 'SYNCING', updatedAt: this.clock() }));
        return ready;
      });
      if (batch.length === 0) return;
      this.emit({ type: 'sync', phase: 'reconcile', detail: `${batch.length} operation(s)` });
      for (const entry of batch) this.emit({ type: 'operation', operationId: entry.operationId, endpointId: entry.endpointId, state: 'SYNCING' });
      let receipts: readonly Receipt[];
      try {
        const response = await this.options.transport.reconcile({
          clientInstanceId: this.clientInstanceId,
          artifactVersion: artifact.artifactVersion,
          operations: batch.map(toWire),
        });
        receipts = response.receipts;
      } catch (error) {
        await this.options.store.transaction(async (tx) => {
          for (const entry of batch) await this.requeue(tx, entry.operationId);
        });
        throw error;
      }
      await this.applyReceipts(batch, receipts);
      if (receipts.some((receipt) => receipt.status === 'RETRY')) return;
    }
  }

  private async requeue(tx: StoreTx, operationId: string, retryAfterMs?: number): Promise<void> {
    const record = await tx.outboxGet(operationId);
    if (record === null) return;
    const entry = fromRecord(record);
    if (entry.state !== 'SYNCING') return;
    const attempts = entry.attempts + 1;
    await tx.outboxPut(toRecord({
      ...entry,
      state: 'QUEUED',
      attempts,
      nextAttemptAt: this.clock() + Math.max(retryAfterMs ?? 0, backoff(attempts, this.random)),
      updatedAt: this.clock(),
    }));
  }

  private async applyReceipts(batch: readonly OutboxEntry[], receipts: readonly Receipt[]): Promise<void> {
    const byId = new Map(receipts.map((receipt) => [receipt.operationId, receipt]));
    const failures = new Map<string, Receipt>();
    const committed: { entry: OutboxEntry; receipt: Receipt }[] = [];
    await this.options.store.transaction(async (tx) => {
      for (const entry of batch) {
        const receipt = byId.get(entry.operationId);
        if (receipt === undefined || receipt.status === 'RETRY') {
          await this.requeue(tx, entry.operationId, receipt?.retryAfterMs);
          continue;
        }
        if (receipt.status === 'COMMITTED') {
          const idMap = new Map(Object.entries(receipt.idMap ?? this.idMapFromResponse(entry, receipt))
            .filter(([local, server]) => local.toLowerCase() !== server.toLowerCase())
            .map(([local, server]) => [local.toLowerCase(), server]));
          if (idMap.size > 0) await this.remap(tx, idMap);
          const current = fromRecord((await tx.outboxGet(entry.operationId))!);
          await tx.outboxPut(toRecord({
            ...current,
            state: 'SERVER_COMMITTED',
            serverCursor: receipt.serverCursor,
            canonicalResponse: receipt.canonicalResponse,
            updatedAt: this.clock(),
          }));
          committed.push({ entry, receipt });
        } else {
          failures.set(entry.operationId, receipt);
          // Back to QUEUED so rebase treats it as applied, then drops it.
          await tx.outboxPut(toRecord({ ...entry, state: 'QUEUED', updatedAt: this.clock() }));
        }
      }
      if (failures.size > 0) await this.rebase(tx, async () => undefined, failures);
    });
    for (const { entry } of committed) {
      this.metrics.commits += 1;
      this.emit({ type: 'operation', operationId: entry.operationId, endpointId: entry.endpointId, state: 'SERVER_COMMITTED' });
    }
    this.flushDeferred();
  }

  /** Derives local -> server ids from the canonical response when the gateway did not. */
  private idMapFromResponse(entry: OutboxEntry, receipt: Receipt): Record<string, string> {
    const plan = this.plans.get(entry.endpointId);
    const out: Record<string, string> = {};
    if (plan?.sync === undefined || receipt.canonicalResponse === undefined) return out;
    for (const mapping of plan.sync.idMap) {
      let value: JsonValue | undefined = receipt.canonicalResponse.body;
      for (const part of mapping.responsePath) {
        value = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>)[part] : undefined;
      }
      const local = entry.captured.uuids[mapping.slot];
      if (typeof value === 'string' && local !== undefined) out[local] = value;
    }
    return out;
  }

  /** Rewrites local identifiers everywhere: projection rows (re-keyed) and the outbox. */
  private async remap(tx: StoreTx, idMap: ReadonlyMap<string, string>): Promise<void> {
    for (const projection of this.projections.values()) {
      for (const row of await tx.all(projection.entity)) {
        const next = remapRow(row, idMap)!;
        if (canonicalJson(next) === canonicalJson(row)) continue;
        await tx.delete(projection.entity, row[projection.key] ?? null);
        await tx.put(projection.entity, next);
      }
    }
    for (const record of await tx.outboxList()) {
      const entry = fromRecord(record);
      const next = remapEntry(entry, idMap);
      if (next !== entry) await tx.outboxPut(toRecord({ ...next, context: remapValue(entry.context, idMap) }));
    }
  }

  private async withSyncLock(work: () => Promise<void>): Promise<void> {
    const locks = this.options.locks ?? (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
    const name = `aeris-sync-${this.options.name ?? 'default'}`;
    if (locks !== undefined) {
      await locks.request(name, { ifAvailable: true }, async (lock) => {
        if (lock !== null) await work();
      });
      return;
    }
    // Fallback lease in the shared store: another tab holding a live lease means it is syncing.
    const acquired = await this.options.store.transaction(async (tx) => {
      const lease = await tx.metaGet(META.lease) as { holder: string; until: number } | undefined;
      if (lease !== undefined && lease.holder !== this.clientInstanceId && lease.until > this.clock()) return false;
      await tx.metaSet(META.lease, { holder: this.clientInstanceId, until: this.clock() + 60_000 });
      return true;
    });
    if (!acquired) return;
    try {
      await work();
    } finally {
      await this.options.store.transaction((tx) => tx.metaSet(META.lease, undefined));
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Operations the UI may want to show ("to synchronize", conflicts to resolve). */
  async operations(): Promise<OutboxEntry[]> {
    return this.options.store.transaction(async (tx) => (await tx.outboxList()).map(fromRecord));
  }

  /** Removes a CONFLICT or REJECTED operation once the user has seen it. */
  async acknowledge(operationId: string): Promise<void> {
    await this.options.store.transaction(async (tx) => {
      const record = await tx.outboxGet(operationId);
      if (record !== null && FAILED_STATES.has(fromRecord(record).state)) await tx.outboxDelete(operationId);
    });
  }

  async status(): Promise<RuntimeStatus> {
    const entries = await this.operations();
    const meta = await this.options.store.transaction(async (tx) => ({
      lastSyncAt: await tx.metaGet(META.lastSyncAt),
      cursor: await tx.metaGet(META.cursor),
    }));
    const pending = entries.filter((entry) => PENDING_STATES.has(entry.state));
    const oldest = pending.reduce<number | undefined>((min, entry) => (min === undefined || entry.createdAt < min ? entry.createdAt : min), undefined);
    return {
      artifactVersion: this.artifact?.artifactVersion,
      online: this.online(),
      lastSyncAt: typeof meta.lastSyncAt === 'number' ? meta.lastSyncAt : undefined,
      cursor: typeof meta.cursor === 'string' ? meta.cursor : undefined,
      outbox: {
        pending: pending.length,
        failed: entries.filter((entry) => FAILED_STATES.has(entry.state)).length,
        committed: entries.filter((entry) => entry.state === 'SERVER_COMMITTED').length,
        oldestAgeMs: oldest === undefined ? undefined : this.clock() - oldest,
      },
      metrics: { ...this.metrics },
    };
  }

  /** Read-only local query helper for UIs (e.g. "show what is stored offline"). */
  get activeArtifact(): AerisArtifact | undefined {
    return this.artifact;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private online(): boolean {
    if (this.options.isOnline !== undefined) return this.options.isOnline();
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    return nav?.onLine ?? true;
  }

  private async subjectOf(context: Record<string, JsonValue> | null): Promise<string> {
    if (context === null) return 'anonymous';
    const claims = this.options.subjectClaims ?? Object.keys(context).sort();
    const subject: Record<string, JsonValue> = {};
    for (const claim of claims) subject[claim] = context[claim] ?? null;
    return `sha256:${await sha256Hex(canonicalJson(subject))}`;
  }

  /** A different session owner never sees, nor replays, the previous one's data. */
  private async ensureSubject(subject: string): Promise<void> {
    const current = await this.options.store.transaction((tx) => tx.metaGet(META.subject));
    if (current === subject) return;
    if (current !== undefined) await this.purge('session-changed');
    await this.options.store.transaction((tx) => tx.metaSet(META.subject, subject));
  }

  private installTriggers(): void {
    const target = globalThis as unknown as {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
      document?: { visibilityState?: string; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void };
    };
    const onOnline = () => {
      void this.refresh().catch(() => undefined);
    };
    const onVisible = () => {
      if (target.document?.visibilityState === 'visible') void this.sync();
    };
    if (target.addEventListener !== undefined) {
      target.addEventListener('online', onOnline);
      this.detach.push(() => target.removeEventListener?.('online', onOnline));
    }
    if (target.document?.addEventListener !== undefined) {
      target.document.addEventListener('visibilitychange', onVisible);
      this.detach.push(() => target.document?.removeEventListener?.('visibilitychange', onVisible));
    }
    const interval = setInterval(() => {
      if (this.online()) void this.sync();
    }, 30_000);
    (interval as unknown as { unref?: () => void }).unref?.();
    this.detach.push(() => clearInterval(interval));
  }

  private schedule(delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((candidate) => candidate !== timer);
      void this.sync();
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.push(timer);
  }

  /** Events produced inside a transaction are only published once it commits. */
  private deferred: RuntimeEvent[] = [];

  private deferEmit(event: RuntimeEvent): void {
    this.deferred.push(event);
  }

  private flushDeferred(): void {
    const events = this.deferred;
    this.deferred = [];
    for (const event of events) this.emit(event);
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A faulty listener must not break the runtime.
      }
    }
  }

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 500) this.latencies.shift();
    const sorted = [...this.latencies].sort((a, b) => a - b);
    this.metrics.localLatencyP50 = sorted[Math.floor(sorted.length * 0.5)];
    this.metrics.localLatencyP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
}

/**
 * Operations that may be sent now: queued, due, and not blocked by an
 * earlier unconfirmed operation they depend on or whose rows they touch.
 */
export function readyOperations(entries: readonly OutboxEntry[], now: number): OutboxEntry[] {
  const unconfirmed = new Map<string, OutboxEntry>();
  const failed = new Set(entries.filter((entry) => FAILED_STATES.has(entry.state)).map((entry) => entry.operationId));
  const ready: OutboxEntry[] = [];
  const touchedByUnconfirmed = new Set<string>();
  for (const entry of entries) {
    if (PENDING_STATES.has(entry.state)) {
      const rows = entry.effects.map((effect) => rowId(effect.entity, effect.key));
      const blockedByDependency = entry.dependencies.some((dependency) => unconfirmed.has(dependency) || failed.has(dependency));
      const blockedByRow = rows.some((row) => touchedByUnconfirmed.has(row));
      const due = entry.state === 'QUEUED' && entry.nextAttemptAt <= now;
      if (due && !blockedByDependency && !blockedByRow && ready.every((candidate) => !entry.dependencies.includes(candidate.operationId))) {
        ready.push(entry);
      }
      unconfirmed.set(entry.operationId, entry);
      for (const row of rows) touchedByUnconfirmed.add(row);
    }
  }
  return ready;
}

function toWire(entry: OutboxEntry): WireOperation {
  return {
    operationId: entry.operationId,
    endpointId: entry.endpointId,
    method: entry.method,
    path: entry.path,
    query: entry.query,
    body: entry.body,
    baseCursor: entry.baseCursor,
    dependencies: entry.dependencies,
    localIds: entry.localIds,
    preconditionHash: entry.preconditionHash,
    createdAt: new Date(entry.createdAt).toISOString(),
  };
}

async function preconditionHash(effects: readonly Effect[]): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(effects.map((effect) => ({ entity: effect.entity, key: effect.key, before: effect.before }))))}`;
}

function compareCursors(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function pathOf(url: string): string {
  try {
    return new URL(url, 'http://aeris.invalid').pathname;
  } catch {
    return url;
  }
}

function decodePathSafely(path: string): string | undefined {
  try {
    decodeURIComponent(path);
    return path;
  } catch {
    return undefined;
  }
}

function omitContentType(headers: Record<string, string>): Record<string, string> {
  const { 'content-type': _ignored, ...rest } = headers;
  return rest;
}

function toStringList(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

const REASONS: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict',
  415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 500: 'Internal Server Error', 503: 'Service Unavailable',
};

function reasonPhrase(status: number): string {
  return REASONS[status] ?? (status >= 500 ? 'Internal Server Error' : 'Bad Request');
}

async function toRuntimeRequest(input: string | URL | Request, init?: RequestInit): Promise<RuntimeRequest> {
  const request = new Request(input, init);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.text();
  return { method: request.method, url: request.url, headers, body };
}
