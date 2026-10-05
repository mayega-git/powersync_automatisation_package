import type { AerisArtifact, EndpointPlan, FieldType, JsonValue, Projection, TestVector } from '../ir/types.js';
import { AerisHttpError, Executor } from '../runtime/executor.js';
import { MemoryStore } from '../runtime/store/MemoryStore.js';

/** Deterministic identifiers so vectors are stable from one build to the next. */
function uuid(seed: number): string {
  return `aeae${seed.toString(16).padStart(4, '0')}-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function sample(type: FieldType, name: string, seed: number): JsonValue {
  if (type.list === true) return [sample({ ...type, list: false }, name, seed)];
  switch (type.type) {
    case 'uuid': return uuid(seed);
    case 'string': return type.maxLength === undefined ? `aeris-${name}` : `aeris-${name}`.slice(0, Math.max(1, type.maxLength));
    case 'integer': return 1;
    case 'decimal': return 12.5;
    case 'boolean': return true;
    case 'enum': return type.values?.[0] ?? null;
    case 'datetime': return '2026-01-15T10:30:00Z';
    case 'datetime-local': return '2026-01-15T10:30:00';
    case 'date': return '2026-01-15';
    case 'time': return '10:30:00';
    case 'json': return null;
  }
}

export interface VectorContext {
  /** Session claims used by the vectors (defaults to deterministic identifiers). */
  claims?: Record<string, JsonValue>;
}

/**
 * Builds test vectors for every locally executable endpoint: a fixture with a
 * row inside the session scope and one outside, a nominal request, a foreign
 * request and an empty-body request. Expected results come from the
 * executor; `aeris test --differential` replays them against the backend.
 */
export async function buildVectors(artifact: AerisArtifact, options: VectorContext = {}): Promise<TestVector[]> {
  const projections = new Map(artifact.projections.map((projection) => [projection.entity, projection]));
  const executor = new Executor({ projections, serverTimeZone: artifact.policies.serverTimeZone });
  const vectors: TestVector[] = [];
  let seed = 1;
  const claims: Record<string, JsonValue> = { ...options.claims };
  const claim = (name: string) => {
    if (claims[name] === undefined) claims[name] = uuid(0xc000 + seed++);
    return claims[name]!;
  };

  for (const plan of artifact.endpoints) {
    if (plan.program === undefined) continue;
    const context: Record<string, JsonValue> = {};
    for (const name of plan.auth.context) context[name] = claim(name);
    const fixture: Record<string, Record<string, JsonValue>[]> = {};
    const owned = new Map<string, Record<string, JsonValue>>();
    const foreign = new Map<string, Record<string, JsonValue>>();
    for (const entity of [...new Set([...plan.reads, ...plan.writes])]) {
      const projection = projections.get(entity)!;
      const mine = row(projection, context, seed++, false);
      const theirs = row(projection, context, seed++, true);
      fixture[entity] = projection.public ? [mine] : [mine, theirs];
      owned.set(entity, mine);
      foreign.set(entity, theirs);
    }
    const firstRead = plan.reads.map((entity) => owned.get(entity)).find((candidate) => candidate !== undefined);
    const firstForeign = plan.reads.map((entity) => foreign.get(entity)).find((candidate) => candidate !== undefined);
    const keyOf = (rowValue: Record<string, JsonValue> | undefined, entity: string | undefined) =>
      rowValue === undefined || entity === undefined ? undefined : rowValue[projections.get(entity)!.key];
    const params = (pick: Record<string, JsonValue> | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [name, type] of Object.entries(plan.input.params)) {
        const key = keyOf(pick, plan.reads[0]);
        out[name] = String(type.type === 'uuid' && typeof key === 'string' ? key : sample(type, name, seed++));
      }
      return out;
    };
    const body = plan.input.body === undefined ? undefined : bodyFor(plan, context, seed++, projections);
    const requests: { id: string; description: string; params: Record<string, string>; body?: JsonValue }[] = [
      { id: 'nominal', description: 'Request on data owned by the session', params: params(firstRead), ...(body === undefined ? {} : { body }) },
    ];
    if (Object.keys(plan.input.params).length > 0 && firstForeign !== undefined) {
      requests.push({ id: 'foreign', description: 'Request on data of another session (must not leak)', params: params(firstForeign), ...(body === undefined ? {} : { body }) });
    }
    if (plan.input.body !== undefined) requests.push({ id: 'empty-body', description: 'Request with an empty JSON body', params: params(firstRead), body: {} });

    for (const request of requests) {
      const vector: TestVector = {
        id: `${plan.id}#${request.id}`,
        endpoint: plan.id,
        description: request.description,
        fixture,
        context,
        request: { params: request.params, query: {}, ...(request.body === undefined ? {} : { body: request.body }) },
      };
      vector.expected = await expected(executor, plan, vector, projections);
      vectors.push(vector);
    }
  }
  return vectors;
}

function row(projection: Projection, context: Record<string, JsonValue>, seed: number, foreign: boolean): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const column of projection.columns) out[column.name] = sample(column.type, column.name, seed * 64 + Object.keys(out).length);
  for (const filter of projection.scope) {
    const claimName = filter.value?.k === 'ctx' ? filter.value.name : undefined;
    if (claimName !== undefined) out[filter.field] = foreign ? uuid(0xf000 + seed) : context[claimName] ?? null;
  }
  return out;
}

function bodyFor(plan: EndpointPlan, context: Record<string, JsonValue>, seed: number, projections?: ReadonlyMap<string, Projection>): JsonValue {
  const out: Record<string, JsonValue> = {};
  // Column limits of the written entities also bound the body's strings.
  const limits = new Map<string, number>();
  for (const entity of plan.writes) {
    for (const column of projections?.get(entity)?.columns ?? []) if (column.type.maxLength !== undefined) limits.set(column.name, column.type.maxLength);
  }
  for (const [name, fieldType] of Object.entries(plan.input.body!.fields)) {
    const type = limits.has(name) && fieldType.maxLength === undefined ? { ...fieldType, maxLength: limits.get(name)! } : fieldType;
    out[name] = context[name] !== undefined ? context[name]! : sample(type, name, seed * 64 + Object.keys(out).length);
  }
  return out;
}

async function expected(executor: Executor, plan: EndpointPlan, vector: TestVector, projections: ReadonlyMap<string, Projection>): Promise<TestVector['expected']> {
  const store = new MemoryStore();
  await store.open([...projections.values()]);
  await store.transaction(async (tx) => {
    for (const [entity, rows] of Object.entries(vector.fixture)) for (const item of rows) await tx.put(entity, { ...item });
  });
  try {
    const result = await store.transaction((tx) => executor.execute(plan, {
      params: vector.request.params,
      query: vector.request.query,
      body: vector.request.body,
      context: vector.context,
      path: plan.path,
    }, { now: Date.parse('2026-02-01T12:00:00Z'), uuids: Array.from({ length: plan.uuidSlots }, (_, index) => uuid(0xd000 + index)) }, tx));
    return { status: result.status, body: result.body };
  } catch (error) {
    if (error instanceof AerisHttpError) return { status: error.status, body: null };
    return { status: 500, body: null };
  }
}
