import type pg from 'pg';
import { EndpointRouter } from '../runtime/router.js';
import type { AerisArtifact, EndpointPlan, JsonValue } from '../ir/types.js';
import type { Receipt, ReconcileRequest, ReconcileResponse, WireOperation } from '../protocol.js';
import { quoteIdent } from './sql.js';
import type { ProjectionReader } from './data.js';

export interface BackendCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface BackendAnswer {
  status: number;
  body: JsonValue | null;
}

export type BackendClient = (call: BackendCall) => Promise<BackendAnswer>;

export class BatchAuthError extends Error {
  constructor() {
    super('The backend refused the session.');
    this.name = 'BatchAuthError';
  }
}

const IN_PROGRESS_TAKEOVER_MS = 120_000;

/**
 * Applies queued operations through the backend's public API, exactly once
 * per (subject, operation id): the registry answers replays with the stored
 * receipt, and the backend sees the same Idempotency-Key on every attempt.
 */
export class Reconciler {
  private readonly router: EndpointRouter;
  private readonly plans: Map<string, EndpointPlan>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly artifact: AerisArtifact,
    private readonly reader: ProjectionReader,
    private readonly backend: BackendClient,
    private readonly options: { backendUrl: string; idempotencyHeader: string; schema: string; maxBatch: number },
  ) {
    this.router = new EndpointRouter(artifact.endpoints);
    this.plans = new Map(artifact.endpoints.map((plan) => [plan.id, plan]));
  }

  async reconcile(subject: string, forwardedHeaders: Record<string, string>, request: ReconcileRequest): Promise<ReconcileResponse> {
    if (!Array.isArray(request.operations)) throw new Error('operations must be an array.');
    if (request.operations.length > this.options.maxBatch) throw new Error(`At most ${this.options.maxBatch} operations per batch.`);
    const receipts: Receipt[] = [];
    let halted = false;
    for (const operation of request.operations) {
      if (halted) {
        receipts.push({ operationId: operation.operationId, status: 'RETRY', retryAfterMs: 1_000 });
        continue;
      }
      const receipt = await this.apply(subject, forwardedHeaders, operation);
      receipts.push(receipt);
      // Later operations may depend on this one: keep the order.
      if (receipt.status === 'RETRY') halted = true;
    }
    return { receipts };
  }

  private async apply(subject: string, headers: Record<string, string>, operation: WireOperation): Promise<Receipt> {
    const problem = this.check(operation);
    if (problem !== undefined) return { operationId: String(operation.operationId), status: 'REJECTED', error: { status: 400, code: 'INVALID_OPERATION', message: problem } };
    const plan = this.plans.get(operation.endpointId)!;
    const schema = quoteIdent(this.options.schema);

    const claimed = await this.pool.query<{ status: string }>(
      `INSERT INTO ${schema}.operations (subject, operation_id, endpoint, status) VALUES ($1, $2, $3, 'IN_PROGRESS')
        ON CONFLICT (subject, operation_id) DO NOTHING RETURNING status`,
      [subject, operation.operationId, operation.endpointId],
    );
    if (claimed.rowCount === 0) {
      const existing = await this.pool.query<{ status: string; receipt: Receipt | null; endpoint: string; age_ms: string }>(
        `SELECT status, receipt, endpoint, (EXTRACT(EPOCH FROM now() - updated_at) * 1000)::bigint::text AS age_ms
           FROM ${schema}.operations WHERE subject = $1 AND operation_id = $2`,
        [subject, operation.operationId],
      );
      const row = existing.rows[0];
      if (row === undefined) return { operationId: operation.operationId, status: 'RETRY', retryAfterMs: 500 };
      if (row.endpoint !== operation.endpointId) {
        return { operationId: operation.operationId, status: 'REJECTED', error: { status: 422, code: 'OPERATION_ID_REUSED', message: 'This operation id was used for another endpoint.' } };
      }
      if (row.status !== 'IN_PROGRESS' && row.receipt !== null) return { ...row.receipt, replayed: true };
      if (Number(row.age_ms) < IN_PROGRESS_TAKEOVER_MS) return { operationId: operation.operationId, status: 'RETRY', retryAfterMs: 2_000 };
      const takeover = await this.pool.query(
        `UPDATE ${schema}.operations SET updated_at = now() WHERE subject = $1 AND operation_id = $2 AND status = 'IN_PROGRESS'
           AND updated_at < now() - make_interval(secs => $3) RETURNING status`,
        [subject, operation.operationId, IN_PROGRESS_TAKEOVER_MS / 1000],
      );
      if (takeover.rowCount === 0) return { operationId: operation.operationId, status: 'RETRY', retryAfterMs: 2_000 };
    }

    let answer: BackendAnswer;
    try {
      const query = new URLSearchParams(operation.query).toString();
      answer = await this.backend({
        method: operation.method,
        url: `${this.options.backendUrl}${operation.path}${query ? `?${query}` : ''}`,
        headers: {
          ...headers,
          'content-type': 'application/json',
          accept: 'application/json',
          [this.options.idempotencyHeader.toLowerCase()]: operation.operationId,
          'x-aeris-replay': '1',
        },
        body: operation.body === null || operation.body === undefined ? null : JSON.stringify(operation.body),
      });
    } catch {
      await this.release(subject, operation.operationId);
      return { operationId: operation.operationId, status: 'RETRY', retryAfterMs: 5_000 };
    }

    if (answer.status === 401) {
      await this.release(subject, operation.operationId);
      throw new BatchAuthError();
    }
    const receipt = await this.classify(plan, operation, answer);
    if (receipt.status === 'RETRY') {
      await this.release(subject, operation.operationId);
      return receipt;
    }
    await this.pool.query(
      `UPDATE ${schema}.operations SET status = $3, receipt = $4, updated_at = now() WHERE subject = $1 AND operation_id = $2`,
      [subject, operation.operationId, receipt.status, JSON.stringify(receipt)],
    );
    return receipt;
  }

  private check(operation: WireOperation): string | undefined {
    if (typeof operation.operationId !== 'string' || !/^[0-9a-fA-F-]{8,64}$/.test(operation.operationId)) return 'Invalid operation id.';
    const plan = this.plans.get(operation.endpointId);
    if (plan === undefined) return `Unknown endpoint ${String(operation.endpointId)}.`;
    if (typeof operation.path !== 'string' || operation.method !== plan.method) return 'Method does not match the endpoint.';
    // The gateway only forwards to the route the operation claims: never an open proxy.
    const match = this.router.match(operation.method, operation.path);
    if (match === undefined || match.plan.id !== plan.id) return 'Path does not match the endpoint route.';
    if (operation.query !== undefined && (typeof operation.query !== 'object' || Object.values(operation.query).some((value) => typeof value !== 'string'))) {
      return 'Invalid query.';
    }
    return undefined;
  }

  private async release(subject: string, operationId: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${quoteIdent(this.options.schema)}.operations WHERE subject = $1 AND operation_id = $2 AND status = 'IN_PROGRESS'`, [subject, operationId]);
  }

  private async classify(plan: EndpointPlan, operation: WireOperation, answer: BackendAnswer): Promise<Receipt> {
    const operationId = operation.operationId;
    const errorOf = (code: string) => ({
      status: answer.status,
      code,
      message: typeof answer.body === 'object' && answer.body !== null && !Array.isArray(answer.body) && typeof (answer.body as Record<string, JsonValue>).message === 'string'
        ? (answer.body as Record<string, string>).message!
        : `Backend answered ${answer.status}.`,
    });
    if (answer.status >= 200 && answer.status < 300) {
      const idMap: Record<string, string> = {};
      for (const mapping of plan.sync?.idMap ?? []) {
        let value: JsonValue | undefined = answer.body;
        for (const part of mapping.responsePath) {
          value = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>)[part] : undefined;
        }
        const local = operation.localIds?.[mapping.slot];
        if (typeof value === 'string' && typeof local === 'string') idMap[local] = value;
      }
      return {
        operationId,
        status: 'COMMITTED',
        committedAt: new Date().toISOString(),
        serverCursor: await this.reader.currentCursor(),
        canonicalResponse: { status: answer.status, body: answer.body },
        idMap,
      };
    }
    if (answer.status === 408 || answer.status === 425 || answer.status === 429 || answer.status >= 500) {
      return { operationId, status: 'RETRY', retryAfterMs: answer.status === 429 ? 10_000 : 5_000, error: errorOf('BACKEND_UNAVAILABLE') };
    }
    if ([404, 409, 410, 412].includes(answer.status)) return { operationId, status: 'CONFLICT', error: errorOf('CONFLICT') };
    return { operationId, status: 'REJECTED', error: errorOf(answer.status === 403 ? 'FORBIDDEN' : 'REJECTED') };
  }
}
