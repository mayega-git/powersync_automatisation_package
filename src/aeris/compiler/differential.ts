import pg from 'pg';
import { globMatch } from './config.js';
import { ProjectionReader, rawTypes } from '../gateway/data.js';
import { LOCAL_CLASSES, type AerisArtifact, type EndpointPlan, type JsonValue, type Projection } from '../ir/types.js';
import { compareResults } from '../runtime/compare.js';
import { AerisHttpError, Executor } from '../runtime/executor.js';
import { MemoryStore } from '../runtime/store/MemoryStore.js';
import { randomUuid } from '../runtime/values.js';
import { buildVectors } from './vectors.js';

export interface DifferentialOptions {
  artifact: AerisArtifact;
  backendUrl: string;
  databaseUrl: string;
  /** Bearer token (Authorization header). */
  token?: string;
  /** Extra headers authenticating the session on the backend. */
  headers?: Record<string, string>;
  /** Session claims the backend derives from the credentials above. */
  claims?: Record<string, JsonValue>;
  /** Endpoint id glob, e.g. "* /api/sales-points/**". */
  only?: string;
  /** Also run mutations (only against a disposable environment). */
  writes?: boolean;
  maxKeysPerEndpoint?: number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export interface CaseResult {
  endpoint: string;
  request: string;
  local: { status: number; body: JsonValue | null };
  server: { status: number; body: JsonValue | null };
  differences: readonly string[];
}

export interface DifferentialSummary {
  endpoints: number;
  cases: number;
  matches: number;
  mismatches: number;
  skipped: { endpoint: string; reason: string }[];
  results: CaseResult[];
}

const ROLLBACK = new Error('aeris-differential-rollback');

/**
 * Differential test (architecture section 18.1): the same request on the same
 * data, once through the local executor on the session's projection read from
 * the real database, once through the backend. Any difference beyond
 * independently generated identifiers and timestamps is a parity failure.
 */
export async function runDifferential(options: DifferentialOptions): Promise<DifferentialSummary> {
  const log = options.log ?? (() => undefined);
  const fetchImpl = options.fetch ?? fetch;
  const artifact = options.artifact;
  const claims = options.claims ?? {};
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 4, types: rawTypes });
  const reader = new ProjectionReader(pool, artifact);
  const projections = new Map(artifact.projections.map((projection) => [projection.entity, projection]));
  const executor = new Executor({ projections, serverTimeZone: artifact.policies.serverTimeZone });
  const summary: DifferentialSummary = { endpoints: 0, cases: 0, matches: 0, mismatches: 0, skipped: [], results: [] };
  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  try {
    const rows = await reader.rows(claims);
    const store = new MemoryStore();
    await store.open(artifact.projections);
    await store.transaction(async (tx) => {
      for (const [entity, list] of Object.entries(rows)) for (const row of list) await tx.put(entity, row);
    });
    log(`Loaded the session projection: ${Object.values(rows).reduce((sum, list) => sum + list.length, 0)} rows in ${artifact.projections.length} projections.`);
    const vectors = options.writes === true ? await buildVectors(artifact, { claims }) : [];

    for (const plan of artifact.endpoints) {
      if (!LOCAL_CLASSES.has(plan.offlineClass) || plan.program === undefined) continue;
      if (options.only !== undefined && !globMatch(options.only, plan.id)) continue;
      const mutation = plan.writes.length > 0;
      if (mutation && options.writes !== true) continue;
      summary.endpoints += 1;
      const cases = await requestsFor(plan, rows, reader, projections, claims, options.maxKeysPerEndpoint ?? 3, vectors.filter((vector) => vector.endpoint === plan.id));
      if (cases.skip !== undefined) {
        summary.skipped.push({ endpoint: plan.id, reason: cases.skip });
        continue;
      }
      for (const testCase of cases.requests) {
        const uuids = Array.from({ length: plan.uuidSlots }, () => randomUuid());
        let local: { status: number; body: JsonValue | null } = { status: 0, body: null };
        try {
          await store.transaction(async (tx) => {
            try {
              const result = await executor.execute(plan, {
                params: testCase.params, query: testCase.query, body: testCase.body, context: claims, path: testCase.path,
              }, { now: Date.now(), uuids }, tx);
              local = { status: result.status, body: result.body };
            } catch (error) {
              if (!(error instanceof AerisHttpError)) throw error;
              local = { status: error.status, body: null };
            }
            throw ROLLBACK;
          });
        } catch (error) {
          if (error !== ROLLBACK) throw error;
        }
        const server = await call(fetchImpl, options.backendUrl, plan.method, testCase.path, testCase.query, testCase.body, headers);
        const comparison = compareResults(plan, local, server, { generated: new Set(uuids.map((id) => id.toLowerCase())) });
        summary.cases += 1;
        const label = `${plan.method} ${testCase.path}${Object.keys(testCase.query).length ? `?${new URLSearchParams(testCase.query)}` : ''}`;
        summary.results.push({ endpoint: plan.id, request: label, local, server, differences: comparison.differences });
        if (comparison.equal) {
          summary.matches += 1;
          log(`  ok    ${label} -> ${server.status}`);
        } else {
          summary.mismatches += 1;
          log(`  DIFF  ${label}\n        ${comparison.differences.slice(0, 5).join('\n        ')}`);
        }
      }
    }
  } finally {
    await pool.end();
  }
  log(`\n${summary.endpoints} endpoints, ${summary.cases} requests: ${summary.matches} identical, ${summary.mismatches} different, ${summary.skipped.length} skipped.`);
  return summary;
}

interface Request {
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body?: JsonValue;
}

async function requestsFor(
  plan: EndpointPlan,
  rows: Record<string, Record<string, JsonValue>[]>,
  reader: ProjectionReader,
  projections: ReadonlyMap<string, Projection>,
  claims: Record<string, JsonValue>,
  maxKeys: number,
  vectors: readonly { request: { params: Record<string, string>; body?: JsonValue } }[],
): Promise<{ requests: Request[]; skip?: string }> {
  for (const [name, spec] of Object.entries(plan.input.query)) {
    if (spec.required) return { requests: [], skip: `required query parameter ${name}` };
  }
  const paramNames = Object.keys(plan.input.params);
  const build = (params: Record<string, string>, body?: JsonValue): Request => ({
    path: plan.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => encodeURIComponent(params[name] ?? '')),
    params,
    query: {},
    ...(body === undefined ? {} : { body }),
  });
  const body = plan.input.body === undefined ? undefined : vectors[0]?.request.body ?? {};
  if (paramNames.length === 0) return { requests: [build({}, body)] };
  if (paramNames.length > 1) {
    const fromVector = vectors[0]?.request.params;
    return fromVector === undefined ? { requests: [], skip: 'several path variables' } : { requests: [build(fromVector, body)] };
  }
  const name = paramNames[0]!;
  const type = plan.input.params[name]!;
  const entity = plan.reads[0];
  const projection = entity === undefined ? undefined : projections.get(entity);
  if (projection === undefined) return { requests: [], skip: 'no entity to draw keys from' };
  const keyType = projection.columns.find((column) => column.name === projection.key)!.type.type;
  if (type.type !== keyType) return { requests: [], skip: `path variable ${name} (${type.type}) is not the ${keyType} key of ${projection.table}` };
  const keys = (rows[projection.entity] ?? []).slice(0, maxKeys).map((row) => String(row[projection.key]));
  if (keyType === 'uuid') keys.push(randomUuid());
  try {
    keys.push(...(await reader.foreignKeys(projection, claims, 1)).map(String));
  } catch {
    // Rows outside the scope are optional.
  }
  return { requests: keys.map((key) => build({ [name]: key }, body)) };
}

async function call(
  fetchImpl: typeof fetch,
  base: string,
  method: string,
  path: string,
  query: Record<string, string>,
  body: JsonValue | undefined,
  headers: Record<string, string>,
): Promise<{ status: number; body: JsonValue | null }> {
  const search = new URLSearchParams(query).toString();
  const response = await fetchImpl(`${base.replace(/\/$/, '')}${path}${search ? `?${search}` : ''}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: JsonValue | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}
