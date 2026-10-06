import { createHash } from 'node:crypto';
import { canonicalJson } from '../ir/canonical.js';
import {
  AERIS_IR_FORMAT,
  AERIS_IR_VERSION,
  AERIS_RUNTIME_MIN_VERSION,
  LOCAL_CLASSES,
  type AdapterIdentity,
  type AerisArtifact,
  type ConflictStrategy,
  type EndpointPlan,
  type Expr,
  type Filter,
  type IdMapping,
  type Instr,
  type OfflineClass,
  type Projection,
  type SyncContract,
} from '../ir/types.js';
import { validateArtifact } from '../ir/validate.js';
import { globMatch, type CompilerConfig } from './config.js';
import { impliedPairs, insertedPairs, pairKey, queryGuards, type QueryGuard, type ScopePair } from './scope.js';
import type { EndpointDraft } from './spring/endpoints.js';
import type { EntityModel } from './spring/persistence.js';
import type { ColumnConstraints } from './schema-check.js';

const STRICTNESS: Readonly<Record<OfflineClass, number>> = {
  LOCAL_READ_SAFE: 0, LOCAL_WRITE_SAFE: 0, REPLAYABLE: 1, SPECULATIVE: 2, ONLINE_REQUIRED: 3, UNSUPPORTED: 4,
};

export interface AssembleInput {
  drafts: EndpointDraft[];
  config: CompilerConfig;
  adapter: AdapterIdentity;
  sourceRevision: string;
  sourceCommit?: string;
  diagnostics: string[];
  previous?: AerisArtifact;
  now?: Date;
  /** Entities whose mapping does not match the live database (from a schema check). */
  unavailableEntities?: ReadonlyMap<string, string>;
  /** Column constraints read from the live database (entity -> column -> constraints). */
  constraints?: ReadonlyMap<string, ReadonlyMap<string, ColumnConstraints>>;
}

interface EntityScope {
  public: boolean;
  /** property -> claim */
  filters: Map<string, string>;
  /** Scoped through a parent row instead of a claim of its own. */
  parent?: { field: string; entity: string };
  reason?: string;
}

/** Turns compiled drafts into a validated, minimal, versioned artifact. */
export function assemble(input: AssembleInput): AerisArtifact {
  const { drafts, config } = input;
  const entities = new Map<string, EntityModel>();
  for (const draft of drafts) for (const entity of draft.entities) entities.set(entity.fqn, entity);
  const candidates = drafts.filter((draft) => draft.program !== undefined && draft.external === undefined && draft.unsupported === undefined);
  const scopes = inferScopes(candidates, entities, config);

  const plans: EndpointPlan[] = [];
  for (const draftIn of drafts) {
    const broken = [...new Set([...draftIn.reads, ...draftIn.writes])].map((entity) => input.unavailableEntities?.get(entity)).find((problem) => problem !== undefined);
    const checked = serverCheckedWrites(draftIn, entities, input.constraints);
    const draft = checked.length === 0 ? draftIn : { ...draftIn, speculative: [...draftIn.speculative, `The database checks ${checked.join(', ')} (foreign key, unique or check constraints): only the server can validate these writes.`] };
    plans.push(broken === undefined ? classify(draft, scopes, entities, config) : classify({ ...draft, program: undefined, unsupported: broken }, scopes, entities, config));
  }

  // Projections only for entities a locally executable endpoint needs (data minimization).
  const projectionsByEntity = new Map<string, Projection>();
  for (const plan of plans) {
    if (!LOCAL_CLASSES.has(plan.offlineClass)) continue;
    for (const entity of [...plan.reads, ...plan.writes]) {
      if (projectionsByEntity.has(entity)) continue;
      projectionsByEntity.set(entity, projectionOf(entities.get(entity)!, scopes.get(entity)!, input.constraints?.get(entity)));
    }
  }
  const projections = [...projectionsByEntity.values()].sort((a, b) => a.entity.localeCompare(b.entity));
  const projectionVersion = `proj-${digest(projections).slice(0, 16)}`;

  // Demote endpoints whose program does not validate rather than failing the build.
  const shell = (endpoints: EndpointPlan[]): AerisArtifact => ({
    format: AERIS_IR_FORMAT,
    formatVersion: AERIS_IR_VERSION,
    artifactVersion: 1,
    runtimeMinVersion: AERIS_RUNTIME_MIN_VERSION,
    sourceRevision: input.sourceRevision,
    createdAt: (input.now ?? new Date()).toISOString(),
    adapter: input.adapter,
    projectionVersion,
    endpoints,
    projections,
    policies: {
      serverTimeZone: config.serverTimeZone,
      defaultFreshnessSeconds: config.freshness,
      onlineOnly: config.onlineOnly,
    },
    testVectors: [],
    diagnostics: [],
  });
  const checked = plans.map((plan) => {
    if (!LOCAL_CLASSES.has(plan.offlineClass)) return plan;
    try {
      validateArtifact(shell([plan]));
      return plan;
    } catch (error) {
      input.diagnostics.push(`${plan.id}: generated program rejected by the validator: ${(error as Error).message.split('\n').slice(1, 3).join(' ')}`);
      return demote(plan, 'UNSUPPORTED', 'The generated program did not pass IR validation.');
    }
  });

  const content = { endpoints: checked, projections };
  const contentDigest = digest(content);
  const previousDigest = input.previous === undefined ? undefined : digest({ endpoints: input.previous.endpoints, projections: input.previous.projections });
  const artifactVersion = config.artifactVersion
    ?? (input.previous === undefined ? 1 : previousDigest === contentDigest ? input.previous.artifactVersion : input.previous.artifactVersion + 1);

  const artifact: AerisArtifact = {
    ...shell(checked),
    artifactVersion,
    ...(input.sourceCommit === undefined ? {} : { sourceCommit: input.sourceCommit }),
    diagnostics: input.diagnostics,
  };
  validateArtifact(artifact);
  return artifact;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function demote(plan: EndpointPlan, offlineClass: OfflineClass, reason: string): EndpointPlan {
  const { program: _program, sync: _sync, ...rest } = plan;
  return { ...rest, offlineClass, reasons: [reason, ...plan.reasons], freshness: { maxAgeSeconds: 0 } };
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

function inferScopes(drafts: readonly EndpointDraft[], entities: ReadonlyMap<string, EntityModel>, config: CompilerConfig): Map<string, EntityScope> {
  const out = new Map<string, EntityScope>();
  const allGuards = drafts.flatMap((draft) => queryGuards(draft.program!, keysOf(entities)));
  for (const entity of entities.values()) {
    if (config.publicEntities.includes(entity.fqn) || config.publicEntities.includes(entity.decl.simple) || entity.decl.annotations.some((annotation) => annotation.name === 'AerisPublic')) {
      out.set(entity.fqn, { public: true, filters: new Map() });
      continue;
    }
    const candidates = new Set<ScopePair>();
    for (const member of entity.decl.kind === 'record' ? entity.decl.recordComponents : entity.decl.fields) {
      const scope = member.annotations.find((annotation) => annotation.name === 'AerisScope');
      const claimNode = scope?.args.get('value');
      const claim = claimNode === undefined ? undefined : /"([^"]+)"/.exec(claimNode.text)?.[1];
      if (claim !== undefined && entity.properties.has(member.name)) candidates.add(pairKey(member.name, claim));
    }
    for (const [claim, properties] of Object.entries(config.scopeClaims)) {
      for (const property of properties) {
        const model = entity.properties.get(property);
        if (model !== undefined && (model.type.type === 'uuid' || model.type.type === 'string') && !model.type.list) candidates.add(pairKey(property, claim));
      }
    }
    const guardSets = allGuards.filter((guard) => guard.entity === entity.fqn).map((guard) => guard.pairs);
    const inserted = new Set<ScopePair>();
    for (const draft of drafts) for (const pair of insertedPairs(draft.program!, entity.fqn)) inserted.add(pair);
    // Equalities with a session claim that the backend's own queries use are candidates too
    // (e.g. userId = session.userId): a device then holds only what those queries return for it.
    for (const set of guardSets) {
      for (const pair of set) {
        const property = entity.properties.get(pair.slice(0, pair.indexOf('=')));
        if (property !== undefined && (property.type.type === 'uuid' || property.type.type === 'string') && !property.type.list) candidates.add(pair);
      }
    }
    if (candidates.size === 0) {
      out.set(entity.fqn, { public: false, filters: new Map(), reason: `${entity.decl.simple} has no property carrying a session claim, and its reads are not all restricted to one row of a scoped entity (configure scopeClaims or publicEntities).` });
      continue;
    }
    let chosen: ScopePair[];
    if (guardSets.length === 0) {
      chosen = [...candidates].filter((pair) => inserted.has(pair));
      if (chosen.length === 0) chosen = [...candidates].slice(0, 1);
    } else {
      chosen = [...candidates].filter((pair) => guardSets.every((set) => set.has(pair)));
      if (chosen.length === 0) {
        // No pair is common to all queries: keep the most used one; the others will not be contained.
        const counts = [...candidates].map((pair) => ({ pair, count: guardSets.filter((set) => set.has(pair)).length }));
        counts.sort((a, b) => b.count - a.count);
        chosen = counts[0]!.count > 0 ? [counts[0]!.pair] : [];
      }
    }
    if (chosen.length === 0) {
      out.set(entity.fqn, { public: false, filters: new Map(), reason: `No query on ${entity.decl.simple} is restricted to the session, directly or through a parent row.` });
      continue;
    }
    out.set(entity.fqn, { public: false, filters: new Map(chosen.map((pair) => pair.split('=') as [string, string])) });
  }
  resolveParentScopes(out, allGuards, entities);
  return out;
}

/**
 * Entities carrying no session claim of their own, but whose every read is
 * restricted to one row of another entity (document lines, order items): they
 * are visible exactly when that row is. Repeated to a fixpoint so a scope
 * found for a child also serves as a parent for its own children.
 */
function resolveParentScopes(scopes: Map<string, EntityScope>, guards: readonly QueryGuard[], entities: ReadonlyMap<string, EntityModel>): void {
  const resolved = (scope: EntityScope) => scope.public || scope.filters.size > 0 || scope.parent !== undefined;
  const cyclic = (from: string, through: string): boolean => {
    for (let at: string | undefined = through; at !== undefined; at = scopes.get(at)?.parent?.entity) if (at === from) return true;
    return false;
  };
  for (let pass = 0; pass < scopes.size; pass += 1) {
    let progress = false;
    for (const [fqn, scope] of scopes) {
      if (resolved(scope)) continue;
      const own = guards.filter((guard) => guard.entity === fqn);
      if (own.length === 0) continue;
      // Only a parent every single read agrees on: one unrestricted read would
      // let the server return rows the device does not hold.
      const common = own.reduce<Set<string>>(
        (kept, guard) => new Set(guard.parents.filter((parent) => kept.has(`${parent.field}=${parent.entity}`)).map((parent) => `${parent.field}=${parent.entity}`)),
        new Set(own[0]!.parents.map((parent) => `${parent.field}=${parent.entity}`)),
      );
      const picked = [...common]
        .map((pair) => ({ field: pair.slice(0, pair.indexOf('=')), entity: pair.slice(pair.indexOf('=') + 1) }))
        .filter((parent) => {
          const target = scopes.get(parent.entity);
          return target !== undefined && !target.public && resolved(target) && !cyclic(fqn, parent.entity) && entities.get(fqn)?.properties.has(parent.field) === true;
        })
        .sort((a, b) => (a.entity === b.entity ? a.field.localeCompare(b.field) : a.entity.localeCompare(b.entity)))[0];
      if (picked === undefined) continue;
      scopes.set(fqn, { public: false, filters: new Map(), parent: picked });
      progress = true;
    }
    if (!progress) return;
  }
}

function projectionOf(entity: EntityModel, scope: EntityScope, constraints?: ReadonlyMap<string, ColumnConstraints>): Projection {
  const scopeFilters: Filter[] = [...scope.filters].map(([field, claim]) => ({ field, cmp: 'eq', value: { k: 'ctx', name: claim } }));
  return {
    entity: entity.fqn,
    ...(entity.schema === undefined ? {} : { schema: entity.schema }),
    table: entity.table,
    key: entity.key,
    columns: [...entity.properties.values()].map((property) => {
      const constraint = constraints?.get(property.column);
      const type = {
        ...property.type,
        ...(constraint?.notNull === true ? { nullable: false } : {}),
        ...(constraint?.maxLength !== undefined && (property.type.type === 'string' || property.type.type === 'enum') && property.type.list !== true ? { maxLength: constraint.maxLength } : {}),
      };
      return { name: property.name, column: property.column, type };
    }),
    scope: scopeFilters,
    public: scope.public,
    ...(scope.parent === undefined ? {} : { parent: scope.parent }),
    ...(entity.version === undefined ? {} : { version: entity.version }),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classify(draftIn: EndpointDraft, scopes: ReadonlyMap<string, EntityScope>, entities: ReadonlyMap<string, EntityModel>, config: CompilerConfig): EndpointPlan {
  const gates = config.requestGates.filter((gate) => gate.paths.some((pattern) => globMatch(pattern, draftIn.path))).map((gate) => gate.policy);
  const draft = gates.length === 0 ? draftIn : { ...draftIn, auth: { ...draftIn.auth, policies: [...(draftIn.auth.policies ?? []), ...gates] } };
  const base = {
    id: draft.id,
    method: draft.method,
    path: draft.path,
    handler: draft.handler,
    input: draft.input,
    output: draft.output,
    auth: draft.auth,
    reads: [...new Set(draft.reads)].sort(),
    writes: [...new Set(draft.writes)].sort(),
    uuidSlots: draft.uuidSlots,
    ...(draft.runtimeErrors === undefined ? {} : { runtimeErrors: draft.runtimeErrors }),
    ...(draft.opaqueFailures === undefined ? {} : { opaqueFailures: draft.opaqueFailures }),
    evidence: draft.evidence,
    testVectors: [],
  };
  const offline = (offlineClass: OfflineClass, reasons: string[], unresolved: string[] = []): EndpointPlan => ({
    ...base,
    offlineClass,
    reasons,
    unresolved,
    freshness: { maxAgeSeconds: 0 },
  });
  if (draft.external !== undefined) return offline('ONLINE_REQUIRED', [draft.external]);
  if (draft.unsupported !== undefined || draft.program === undefined) {
    const reason = draft.unsupported ?? 'No program was produced.';
    return offline('UNSUPPORTED', [reason], [reason]);
  }
  if (config.onlineOnly.some((pattern) => globMatch(pattern, draft.id) || globMatch(pattern, draft.path))) {
    return offline('ONLINE_REQUIRED', ['Declared online-only in the AERIS configuration.']);
  }
  if (draft.declared?.offlineClass === 'ONLINE_REQUIRED') return offline('ONLINE_REQUIRED', [draft.declared.reason]);
  const program = draft.program;

  for (const entity of new Set([...draft.reads, ...draft.writes])) {
    const scope = scopes.get(entity);
    if (scope === undefined || (!scope.public && scope.filters.size === 0 && scope.parent === undefined)) {
      return offline('ONLINE_REQUIRED', [scope?.reason ?? `${entities.get(entity)?.decl.simple ?? entity} cannot be projected without leaking other sessions' data.`]);
    }
  }
  for (const guard of queryGuards(program, keysOf(entities))) {
    const unmet = unrestricted(guard, scopes, entities);
    if (unmet !== undefined) return offline('ONLINE_REQUIRED', [unmet]);
  }
  const scopeClaims = new Set([...draft.reads, ...draft.writes].flatMap((entity) => [...claimsOf(entity, scopes)]));
  const auth = { ...draft.auth, context: [...new Set([...draft.auth.context, ...scopeClaims])].sort() };

  let offlineClass: OfflineClass;
  const reasons: string[] = [];
  let sync: SyncContract | undefined;
  if (draft.writes.length === 0) {
    offlineClass = 'LOCAL_READ_SAFE';
    reasons.push('Read-only: every query is restricted to the session projection.');
  } else {
    const covered = config.idempotency !== undefined &&
      config.idempotency.methods.includes(draft.method) &&
      config.idempotency.paths.some((pattern) => globMatch(pattern, draft.path));
    let idempotency: SyncContract['idempotency'];
    if (covered) idempotency = 'backend-key';
    else if (draft.method === 'PUT' || draft.method === 'DELETE') idempotency = 'natural';
    else {
      return offline('ONLINE_REQUIRED', [`${draft.method} has no backend idempotency guarantee: a lost response could apply it twice (configure idempotency).`]);
    }
    const readsShared = containsQuery(program);
    const speculative = draft.speculative.length > 0 || readsShared;
    offlineClass = speculative ? 'SPECULATIVE' : 'REPLAYABLE';
    const conflict: ConflictStrategy = readsShared ? 'SERVER_REVALIDATE' : 'APPEND';
    if (readsShared) reasons.push('The result depends on data other sessions can change: the server revalidates on replay.');
    reasons.push(...draft.speculative);
    if (!speculative) reasons.push('Writes without reading shared state: replayed once through the idempotency key.');
    sync = { idempotencyHeader: config.idempotency?.header ?? 'Idempotency-Key', idempotency, conflict, idMap: idMappings(program) };
  }

  const override = config.overrides[draft.id] ?? draft.declared?.offlineClass;
  if (override !== undefined) {
    const source = config.overrides[draft.id] !== undefined ? 'configuration override' : draft.declared!.reason;
    if (override === 'LOCAL_WRITE_SAFE' && offlineClass === 'REPLAYABLE') offlineClass = 'LOCAL_WRITE_SAFE';
    else if (STRICTNESS[override] > STRICTNESS[offlineClass]) {
      if (!LOCAL_CLASSES.has(override)) return offline(override, [`Restricted by ${source} (computed ${offlineClass}).`]);
      // Still local, only stricter: keep the proven program and its sync contract.
      reasons.unshift(`Restricted by ${source} (computed ${offlineClass}).`);
      offlineClass = override;
      if (sync === undefined) return offline('ONLINE_REQUIRED', [`${source} requires a write class for a read-only endpoint.`]);
    }
  }
  return {
    ...base,
    auth,
    program,
    offlineClass,
    reasons,
    unresolved: [],
    freshness: { maxAgeSeconds: config.freshness[offlineClass] },
    ...(sync === undefined ? {} : { sync }),
  };
}

/** Columns written by a program that carry constraints only the database can verify. */
function serverCheckedWrites(draft: EndpointDraft, entities: ReadonlyMap<string, EntityModel>, constraints?: ReadonlyMap<string, ReadonlyMap<string, ColumnConstraints>>): string[] {
  if (constraints === undefined || draft.program === undefined) return [];
  const out = new Set<string>();
  const visit = (block: readonly Instr[]) => {
    for (const instr of block) {
      if (instr.op === 'IF') {
        visit(instr.then);
        visit(instr.else);
      } else if (instr.op === 'INSERT' || instr.op === 'UPDATE') {
        const entity = entities.get(instr.entity);
        const table = constraints.get(instr.entity);
        if (entity === undefined || table === undefined) continue;
        for (const field of Object.keys(instr.values)) {
          const column = entity.properties.get(field)?.column;
          if (column === undefined) continue;
          const checks = table.get(column)?.serverChecked ?? [];
          // Unchanged values on UPDATE (the row's own value) cannot break a constraint.
          const value = instr.values[field]!;
          const unchanged = instr.op === 'UPDATE' && value.k === 'get' && value.field === field;
          if (checks.length > 0 && !unchanged && !(field === entity.key && instr.op === 'INSERT' && checks.every((check) => check === 'UNIQUE'))) out.add(`${entity.table}.${column}`);
        }
      }
    }
  };
  visit(draft.program);
  return [...out].sort();
}

const keyMaps = new WeakMap<ReadonlyMap<string, EntityModel>, Map<string, string>>();

/** Key property of each entity (memoized per entity map). */
/**
 * Why a query's server result can include rows the device does not hold, or
 * `undefined` when it cannot. A claim-scoped entity needs the equality the
 * projection uses; a parent-scoped one needs the query to be restricted to a
 * parent row that is itself in scope — a row obtained by another query of this
 * same program, checked in turn.
 */
function unrestricted(guard: QueryGuard, scopes: ReadonlyMap<string, EntityScope>, entities: ReadonlyMap<string, EntityModel>): string | undefined {
  const name = (entity: string) => entities.get(entity)?.decl.simple ?? entity;
  const scope = scopes.get(guard.entity)!;
  if (scope.public) return undefined;
  for (const [field, claim] of scope.filters) {
    if (!guard.pairs.has(pairKey(field, claim))) {
      return `A read of ${name(guard.entity)} is not restricted to ${field} = session.${claim}: its server result can include rows a device does not hold.`;
    }
  }
  if (scope.parent === undefined) return undefined;
  const { field, entity: parent } = scope.parent;
  const candidates = guard.parents.filter((candidate) => candidate.field === field && candidate.entity === parent);
  if (candidates.length === 0) {
    return `A read of ${name(guard.entity)} is not restricted to one ${name(parent)} through ${field}: its server result can include rows a device does not hold.`;
  }
  const parentScope = scopes.get(parent)!;
  for (const [parentField, claim] of parentScope.filters) {
    if (!candidates.some((candidate) => candidate.pairs.has(pairKey(parentField, claim)))) {
      return `A read of ${name(guard.entity)} goes through a ${name(parent)} that is not restricted to ${parentField} = session.${claim}.`;
    }
  }
  return undefined;
}

/** Session claims a projection depends on, following parent scopes up to their claims. */
function claimsOf(entity: string, scopes: ReadonlyMap<string, EntityScope>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (let at: string | undefined = entity; at !== undefined && !seen.has(at);) {
    seen.add(at);
    const scope = scopes.get(at);
    if (scope === undefined) break;
    for (const claim of scope.filters.values()) out.add(claim);
    at = scope.parent?.entity;
  }
  return out;
}

function keysOf(entities: ReadonlyMap<string, EntityModel>): Map<string, string> {
  let keys = keyMaps.get(entities);
  if (keys === undefined) {
    keys = new Map([...entities.values()].map((entity) => [entity.fqn, entity.key]));
    keyMaps.set(entities, keys);
  }
  return keys;
}

function containsQuery(program: readonly Instr[]): boolean {
  return program.some((instr) => instr.op === 'QUERY'
    || (instr.op === 'IF' && (containsQuery(instr.then) || containsQuery(instr.else)))
    || (instr.op === 'TRY' && (containsQuery(instr.body) || containsQuery(instr.fallback)))
    || (instr.op === 'EACH' && containsQuery(instr.body)));
}

/** Client-generated keys of inserted rows, located in the response so receipts can remap them. */
function idMappings(program: readonly Instr[]): IdMapping[] {
  const slots = new Map<number, string>();
  const returns: Expr[] = [];
  const visit = (block: readonly Instr[]) => {
    for (const instr of block) {
      if (instr.op === 'IF') {
        visit(instr.then);
        visit(instr.else);
      } else if (instr.op === 'INSERT') {
        for (const value of Object.values(instr.values)) {
          if (value.k === 'uuid' && !slots.has(value.slot)) slots.set(value.slot, instr.entity);
        }
      } else if (instr.op === 'RETURN' && instr.body !== null) {
        returns.push(instr.body);
      }
    }
  };
  visit(program);
  const out: IdMapping[] = [];
  for (const [slot, entity] of slots) {
    for (const body of returns) {
      const path = findSlot(body, slot, []);
      if (path !== undefined) {
        out.push({ slot, responsePath: path, entity });
        break;
      }
    }
  }
  return out;
}

function findSlot(expr: Expr, slot: number, path: string[]): string[] | undefined {
  if (expr.k === 'uuid' && expr.slot === slot) return path;
  if (expr.k === 'object') {
    for (const [name, value] of Object.entries(expr.fields)) {
      const found = findSlot(value, slot, [...path, name]);
      if (found !== undefined) return found;
    }
  }
  if (expr.k === 'cond') return findSlot(expr.then, slot, path) ?? findSlot(expr.else, slot, path);
  return undefined;
}

export { impliedPairs };
