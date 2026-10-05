import {
  AERIS_IR_FORMAT,
  EXPR_OPS,
  LOCAL_CLASSES,
  OFFLINE_CLASSES,
  SCALAR_TYPES,
  type AerisArtifact,
  type EndpointPlan,
  type Expr,
  type FieldType,
  type Filter,
  type Instr,
  type Projection,
} from './types.js';

export class AerisValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid AERIS artifact:\n  - ${problems.slice(0, 20).join('\n  - ')}${problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : ''}`);
    this.name = 'AerisValidationError';
  }
}

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const OPS = new Set<string>(EXPR_OPS);
const SCALARS = new Set<string>(SCALAR_TYPES);
const CLASSES = new Set<string>(OFFLINE_CLASSES);
const FILTER_CMPS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'isNull', 'notNull', 'in']);
const QUERY_MODES = new Set(['one', 'many', 'count', 'exists']);
const CONFLICTS = new Set(['APPEND', 'SERVER_REVALIDATE', 'OPTIMISTIC_VERSION', 'REJECT_COMPENSATE']);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_DEPTH = 64;

/**
 * Structural and semantic validation. The runtime calls it on every artifact
 * it loads; the compiler calls it before signing. Anything this function
 * accepts can be executed without the executor meeting an unknown shape.
 */
export function validateArtifact(value: unknown): asserts value is AerisArtifact {
  const problems: string[] = [];
  const artifact = value as AerisArtifact;
  if (!isRecord(value)) throw new AerisValidationError(['artifact is not an object']);
  if (artifact.format !== AERIS_IR_FORMAT) problems.push(`format must be ${AERIS_IR_FORMAT}`);
  if (typeof artifact.formatVersion !== 'string' || !/^1\.\d+\.\d+$/.test(artifact.formatVersion)) {
    problems.push('formatVersion must be a 1.x semantic version');
  }
  if (!Number.isSafeInteger(artifact.artifactVersion) || artifact.artifactVersion < 1) {
    problems.push('artifactVersion must be a positive integer');
  }
  for (const key of ['runtimeMinVersion', 'sourceRevision', 'createdAt', 'projectionVersion'] as const) {
    if (typeof artifact[key] !== 'string' || artifact[key].length === 0) problems.push(`${key} must be a non-empty string`);
  }
  if (!isRecord(artifact.adapter)) problems.push('adapter is missing');
  if (!Array.isArray(artifact.endpoints)) problems.push('endpoints must be an array');
  if (!Array.isArray(artifact.projections)) problems.push('projections must be an array');
  if (!Array.isArray(artifact.testVectors)) problems.push('testVectors must be an array');
  if (!Array.isArray(artifact.diagnostics)) problems.push('diagnostics must be an array');
  if (!isRecord(artifact.policies) || typeof artifact.policies.serverTimeZone !== 'string') {
    problems.push('policies.serverTimeZone is required');
  }
  if (problems.length > 0) throw new AerisValidationError(problems);

  const projections = new Map<string, Projection>();
  for (const [index, projection] of artifact.projections.entries()) {
    validateProjection(projection, `projections[${index}]`, problems);
    if (projections.has(projection.entity)) problems.push(`projection ${projection.entity} is declared twice`);
    projections.set(projection.entity, projection);
  }

  const ids = new Set<string>();
  for (const [index, endpoint] of artifact.endpoints.entries()) {
    const where = `endpoints[${index}]`;
    if (!isRecord(endpoint)) {
      problems.push(`${where} is not an object`);
      continue;
    }
    if (ids.has(endpoint.id)) problems.push(`${where}: duplicate endpoint id ${endpoint.id}`);
    ids.add(endpoint.id);
    validateEndpoint(endpoint, where, projections, problems);
  }

  const vectorIds = new Set<string>();
  for (const [index, vector] of artifact.testVectors.entries()) {
    if (!isRecord(vector) || typeof vector.id !== 'string' || typeof vector.endpoint !== 'string') {
      problems.push(`testVectors[${index}] is malformed`);
      continue;
    }
    if (vectorIds.has(vector.id)) problems.push(`testVectors[${index}]: duplicate id ${vector.id}`);
    vectorIds.add(vector.id);
    if (!ids.has(vector.endpoint)) problems.push(`testVectors[${index}]: unknown endpoint ${vector.endpoint}`);
  }
  for (const endpoint of artifact.endpoints) {
    for (const ref of endpoint.testVectors ?? []) {
      if (!vectorIds.has(ref)) problems.push(`${endpoint.id}: unknown test vector ${ref}`);
    }
  }

  if (problems.length > 0) throw new AerisValidationError(problems);
}

function validateProjection(projection: Projection, where: string, problems: string[]): void {
  if (!isRecord(projection)) {
    problems.push(`${where} is not an object`);
    return;
  }
  if (!isIdentifierPath(projection.entity)) problems.push(`${where}.entity is invalid`);
  if (typeof projection.table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(projection.table)) {
    problems.push(`${where}.table is invalid`);
  }
  if (projection.schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(projection.schema)) {
    problems.push(`${where}.schema is invalid`);
  }
  if (!Array.isArray(projection.columns) || projection.columns.length === 0) {
    problems.push(`${where}.columns must be a non-empty array`);
    return;
  }
  const names = new Set<string>();
  for (const column of projection.columns) {
    if (!IDENTIFIER.test(column.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.column)) {
      problems.push(`${where}: invalid column ${String(column.name)}`);
    }
    if (names.has(column.name)) problems.push(`${where}: duplicate column ${column.name}`);
    names.add(column.name);
    validateFieldType(column.type, `${where}.${column.name}`, problems);
  }
  if (!names.has(projection.key)) problems.push(`${where}: key ${projection.key} is not a column`);
  if (projection.version !== undefined && !names.has(projection.version)) {
    problems.push(`${where}: version ${projection.version} is not a column`);
  }
  if (!Array.isArray(projection.scope)) problems.push(`${where}.scope must be an array`);
  else {
    if (projection.scope.length === 0 && projection.public !== true) {
      problems.push(`${where}: a projection without a scope must be declared public`);
    }
    for (const filter of projection.scope) {
      if (!names.has(filter.field)) problems.push(`${where}: scope field ${filter.field} is not a column`);
      if (filter.cmp !== 'eq' || filter.value?.k !== 'ctx') {
        problems.push(`${where}: a scope filter must be an equality with a context claim`);
      }
    }
  }
}

function validateFieldType(type: FieldType, where: string, problems: string[]): void {
  if (!isRecord(type) || !SCALARS.has(type.type) || typeof type.nullable !== 'boolean') {
    problems.push(`${where}: invalid field type`);
    return;
  }
  if (type.type === 'enum' && (!Array.isArray(type.values) || type.values.length === 0)) {
    problems.push(`${where}: enum type without values`);
  }
}

function validateEndpoint(
  endpoint: EndpointPlan,
  where: string,
  projections: ReadonlyMap<string, Projection>,
  problems: string[],
): void {
  if (!HTTP_METHODS.has(endpoint.method)) problems.push(`${where}: invalid method`);
  if (typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/')) problems.push(`${where}: invalid path`);
  if (endpoint.id !== `${endpoint.method} ${endpoint.path}`) problems.push(`${where}: id must be "METHOD path"`);
  if (!CLASSES.has(endpoint.offlineClass)) problems.push(`${where}: invalid offlineClass`);
  if (!Number.isSafeInteger(endpoint.uuidSlots) || endpoint.uuidSlots < 0) problems.push(`${where}: invalid uuidSlots`);
  if (!isRecord(endpoint.freshness) || !(endpoint.freshness.maxAgeSeconds >= 0)) problems.push(`${where}: invalid freshness`);
  if (!Array.isArray(endpoint.reasons) || !Array.isArray(endpoint.evidence) || !Array.isArray(endpoint.unresolved)) {
    problems.push(`${where}: reasons, evidence and unresolved must be arrays`);
    return;
  }
  for (const evidence of endpoint.evidence) {
    if (!isRecord(evidence) || typeof evidence.file !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.excerptHash) ||
      !Number.isSafeInteger(evidence.startLine) || evidence.endLine < evidence.startLine || evidence.startLine < 1) {
      problems.push(`${where}: malformed evidence`);
      break;
    }
  }

  const local = LOCAL_CLASSES.has(endpoint.offlineClass);
  if (!local) {
    if (endpoint.program !== undefined && endpoint.offlineClass === 'UNSUPPORTED') {
      problems.push(`${where}: an UNSUPPORTED endpoint cannot carry a program`);
    }
    return;
  }

  // A locally executable endpoint must be fully proven.
  if (endpoint.program === undefined) {
    problems.push(`${where}: ${endpoint.offlineClass} requires a program`);
    return;
  }
  if (endpoint.unresolved.length > 0) problems.push(`${where}: a local class cannot keep unresolved items`);
  if (endpoint.evidence.length === 0) problems.push(`${where}: a local class requires source evidence`);
  for (const entity of [...endpoint.reads, ...endpoint.writes]) {
    if (!projections.has(entity)) problems.push(`${where}: entity ${entity} has no projection`);
  }

  const mutates = endpoint.writes.length > 0;
  if (endpoint.offlineClass === 'LOCAL_READ_SAFE' && mutates) problems.push(`${where}: LOCAL_READ_SAFE cannot write`);
  if ((endpoint.offlineClass === 'REPLAYABLE' || endpoint.offlineClass === 'SPECULATIVE')) {
    if (endpoint.sync === undefined) problems.push(`${where}: ${endpoint.offlineClass} requires a sync contract`);
    else {
      if (!CONFLICTS.has(endpoint.sync.conflict)) problems.push(`${where}: invalid conflict strategy`);
      if (endpoint.sync.idempotency !== 'backend-key' && endpoint.sync.idempotency !== 'natural') {
        problems.push(`${where}: invalid idempotency`);
      }
      for (const mapping of endpoint.sync.idMap) {
        if (!(mapping.slot >= 0 && mapping.slot < endpoint.uuidSlots)) problems.push(`${where}: idMap slot out of range`);
        if (!projections.has(mapping.entity)) problems.push(`${where}: idMap entity ${mapping.entity} has no projection`);
      }
    }
  }

  const state: ProgramState = {
    where,
    problems,
    projections,
    uuidSlots: endpoint.uuidSlots,
    queued: false,
    writes: new Set(),
    params: new Set(Object.keys(endpoint.input?.params ?? {})),
    query: new Set(Object.keys(endpoint.input?.query ?? {})),
    contextClaims: new Set(endpoint.auth?.context ?? []),
  };
  const terminates = validateBlock(endpoint.program, new Set(), state, 0);
  if (!terminates) problems.push(`${where}: every execution path must end with RETURN`);
  for (const entity of state.writes) {
    if (!endpoint.writes.includes(entity)) problems.push(`${where}: program writes ${entity}, not declared in writes`);
  }
  if (state.writes.size > 0 && !state.queued) problems.push(`${where}: a program that writes must QUEUE_INTENT`);
  if (state.writes.size > 0 && endpoint.offlineClass === 'LOCAL_READ_SAFE') {
    problems.push(`${where}: LOCAL_READ_SAFE program writes`);
  }
}

interface ProgramState {
  where: string;
  problems: string[];
  projections: ReadonlyMap<string, Projection>;
  uuidSlots: number;
  queued: boolean;
  writes: Set<string>;
  params: ReadonlySet<string>;
  query: ReadonlySet<string>;
  contextClaims: ReadonlySet<string>;
}

/** Returns true when every path through the block ends with RETURN. */
function validateBlock(block: readonly Instr[], scope: Set<string>, state: ProgramState, depth: number): boolean {
  if (!Array.isArray(block)) {
    state.problems.push(`${state.where}: block is not an array`);
    return false;
  }
  if (depth > MAX_DEPTH) {
    state.problems.push(`${state.where}: program nesting is too deep`);
    return false;
  }
  for (const [index, instr] of block.entries()) {
    const terminal = validateInstr(instr, scope, state, depth);
    if (terminal) {
      const trailing = block.slice(index + 1);
      // Placeholders after a throw are harmless; anything else is dead code.
      if (trailing.some((next) => next.op !== 'LET')) state.problems.push(`${state.where}: unreachable instructions after the end of a path`);
      return true;
    }
  }
  return false;
}

function validateInstr(instr: Instr, scope: Set<string>, state: ProgramState, depth: number): boolean {
  const { problems, where } = state;
  if (!isRecord(instr)) {
    problems.push(`${where}: instruction is not an object`);
    return false;
  }
  switch (instr.op) {
    case 'QUERY': {
      const projection = entityOf(instr.entity, state);
      if (!QUERY_MODES.has(instr.mode)) problems.push(`${where}: invalid QUERY mode`);
      for (const filter of instr.where) validateFilter(filter, projection, scope, state, depth);
      for (const order of instr.orderBy ?? []) {
        if (projection !== undefined && !hasColumn(projection, order.field)) problems.push(`${where}: unknown order field ${order.field}`);
        if (order.dir !== 'asc' && order.dir !== 'desc') problems.push(`${where}: invalid order direction`);
      }
      if (instr.limit !== undefined && !(Number.isSafeInteger(instr.limit) && instr.limit > 0)) {
        problems.push(`${where}: invalid QUERY limit`);
      }
      define(instr.out, scope, state);
      return false;
    }
    case 'LET':
      validateExpr(instr.expr, scope, state, depth);
      define(instr.out, scope, state);
      return false;
    case 'ASSERT': {
      validateExpr(instr.test, scope, state, depth);
      validateExpr(instr.error?.message, scope, state, depth);
      if (instr.error?.body !== undefined) {
        const inner = new Set(scope);
        inner.add('$message');
        validateExpr(instr.error.body, inner, state, depth);
      }
      if (!(Number.isSafeInteger(instr.error?.status) && instr.error.status >= 400 && instr.error.status <= 599)) {
        problems.push(`${where}: ASSERT error status must be 4xx or 5xx`);
      }
      // ASSERT(false) always aborts (a Java throw): the path ends here.
      return instr.test.k === 'lit' && instr.test.v === false;
    }
    case 'IF': {
      validateExpr(instr.test, scope, state, depth);
      const thenScope = new Set(scope);
      const elseScope = new Set(scope);
      const thenEnds = validateBlock(instr.then, thenScope, state, depth + 1);
      const elseEnds = validateBlock(instr.else, elseScope, state, depth + 1);
      // A variable is defined after the IF when every non-returning branch defines it.
      const candidates = new Set([...thenScope, ...elseScope]);
      for (const name of candidates) {
        const inThen = thenEnds || thenScope.has(name);
        const inElse = elseEnds || elseScope.has(name);
        if (inThen && inElse) scope.add(name);
      }
      return thenEnds && elseEnds;
    }
    case 'INSERT':
    case 'UPDATE': {
      const projection = entityOf(instr.entity, state);
      state.writes.add(instr.entity);
      if (instr.op === 'UPDATE') validateExpr(instr.key, scope, state, depth);
      if (!isRecord(instr.values)) problems.push(`${where}: ${instr.op} values must be an object`);
      else {
        for (const [field, expr] of Object.entries(instr.values)) {
          if (projection !== undefined && !hasColumn(projection, field)) problems.push(`${where}: ${instr.op} unknown field ${instr.entity}.${field}`);
          validateExpr(expr, scope, state, depth);
        }
        if (instr.op === 'INSERT' && projection !== undefined && !(projection.key in instr.values)) {
          problems.push(`${where}: INSERT into ${instr.entity} must set its key`);
        }
      }
      if (instr.out !== undefined) define(instr.out, scope, state);
      return false;
    }
    case 'DELETE':
      entityOf(instr.entity, state);
      state.writes.add(instr.entity);
      validateExpr(instr.key, scope, state, depth);
      return false;
    case 'EMIT_LOCAL_EVENT':
      if (typeof instr.name !== 'string' || instr.name.length === 0) problems.push(`${where}: EMIT_LOCAL_EVENT requires a name`);
      validateExpr(instr.payload, scope, state, depth);
      return false;
    case 'QUEUE_INTENT':
      state.queued = true;
      return false;
    case 'RETURN':
      if (!(Number.isSafeInteger(instr.status) && instr.status >= 200 && instr.status <= 499)) {
        problems.push(`${where}: RETURN status must be 2xx-4xx`);
      }
      if (instr.body !== null) validateExpr(instr.body, scope, state, depth);
      return true;
    default:
      problems.push(`${where}: unknown instruction ${(instr as { op?: unknown }).op as string}`);
      return false;
  }
}

function validateFilter(
  filter: Filter,
  projection: Projection | undefined,
  scope: ReadonlySet<string>,
  state: ProgramState,
  depth: number,
): void {
  if (!isRecord(filter) || !FILTER_CMPS.has(filter.cmp)) {
    state.problems.push(`${state.where}: malformed filter`);
    return;
  }
  if (projection !== undefined && !hasColumn(projection, filter.field)) {
    state.problems.push(`${state.where}: unknown filter field ${projection.entity}.${filter.field}`);
  }
  const unary = filter.cmp === 'isNull' || filter.cmp === 'notNull';
  if (unary !== (filter.value === undefined)) state.problems.push(`${state.where}: filter ${filter.cmp} value mismatch`);
  if (filter.value !== undefined) validateExpr(filter.value, scope, state, depth);
}

function validateExpr(expr: Expr | undefined, scope: ReadonlySet<string>, state: ProgramState, depth: number): void {
  const { problems, where } = state;
  if (depth > MAX_DEPTH * 4) {
    problems.push(`${where}: expression nesting is too deep`);
    return;
  }
  if (!isRecord(expr)) {
    problems.push(`${where}: expression is not an object`);
    return;
  }
  const next = depth + 1;
  switch (expr.k) {
    case 'lit':
      if (!isJson(expr.v, 0)) problems.push(`${where}: literal is not JSON`);
      return;
    case 'input':
      if (!Array.isArray(expr.path) || !expr.path.every((part) => typeof part === 'string')) problems.push(`${where}: invalid input path`);
      return;
    case 'param':
      if (!state.params.has(expr.name)) problems.push(`${where}: unknown path parameter ${expr.name}`);
      return;
    case 'query':
      if (!state.query.has(expr.name)) problems.push(`${where}: unknown query parameter ${expr.name}`);
      return;
    case 'ctx':
      if (!state.contextClaims.has(expr.name)) problems.push(`${where}: context claim ${expr.name} not declared in auth.context`);
      return;
    case 'var':
      if (!scope.has(expr.name)) problems.push(`${where}: variable ${expr.name} used before definition`);
      return;
    case 'get':
      if (typeof expr.field !== 'string' || expr.field.length === 0) problems.push(`${where}: invalid field access`);
      validateExpr(expr.of, scope, state, next);
      return;
    case 'now':
      if (!['datetime', 'datetime-local', 'date'].includes(expr.type)) problems.push(`${where}: invalid now type`);
      return;
    case 'uuid':
      if (!(Number.isSafeInteger(expr.slot) && expr.slot >= 0 && expr.slot < state.uuidSlots)) problems.push(`${where}: uuid slot out of range`);
      return;
    case 'cond':
      validateExpr(expr.test, scope, state, next);
      validateExpr(expr.then, scope, state, next);
      validateExpr(expr.else, scope, state, next);
      return;
    case 'op':
      if (!OPS.has(expr.op)) problems.push(`${where}: unknown operator ${expr.op}`);
      if (!Array.isArray(expr.args)) problems.push(`${where}: operator arguments must be an array`);
      else for (const arg of expr.args) validateExpr(arg, scope, state, next);
      return;
    case 'object':
      if (!isRecord(expr.fields)) problems.push(`${where}: object fields must be a record`);
      else for (const value of Object.values(expr.fields)) validateExpr(value, scope, state, next);
      return;
    case 'list':
      if (!Array.isArray(expr.items)) problems.push(`${where}: list items must be an array`);
      else for (const item of expr.items) validateExpr(item, scope, state, next);
      return;
    case 'map':
    case 'filter': {
      validateExpr(expr.of, scope, state, next);
      if (!IDENTIFIER.test(expr.as)) problems.push(`${where}: invalid binding name`);
      const inner = new Set(scope);
      inner.add(expr.as);
      validateExpr(expr.body, inner, state, next);
      return;
    }
    case 'fold': {
      validateExpr(expr.of, scope, state, next);
      validateExpr(expr.init, scope, state, next);
      if (!IDENTIFIER.test(expr.as) || !IDENTIFIER.test(expr.acc) || expr.as === expr.acc) problems.push(`${where}: invalid fold bindings`);
      const inner = new Set(scope);
      inner.add(expr.as);
      inner.add(expr.acc);
      validateExpr(expr.body, inner, state, next);
      return;
    }
    case 'try':
      if (expr.catches !== 'cast' && expr.catches !== 'any') problems.push(`${where}: invalid try catches`);
      validateExpr(expr.body, scope, state, next);
      validateExpr(expr.fallback, scope, state, next);
      return;
    case 'sort': {
      validateExpr(expr.of, scope, state, next);
      if (!IDENTIFIER.test(expr.as)) problems.push(`${where}: invalid binding name`);
      if (!Array.isArray(expr.keys) || expr.keys.length === 0) problems.push(`${where}: sort needs at least one key`);
      const inner = new Set(scope);
      inner.add(expr.as);
      for (const key of expr.keys ?? []) {
        if (!['first', 'last', 'error'].includes(key.nulls) || typeof key.desc !== 'boolean') problems.push(`${where}: malformed sort key`);
        validateExpr(key.key, inner, state, next);
      }
      return;
    }
    case 'cast':
      if (!SCALARS.has(expr.to)) problems.push(`${where}: invalid cast type`);
      if (expr.to === 'enum' && (!Array.isArray(expr.values) || expr.values.length === 0)) problems.push(`${where}: enum cast without values`);
      validateExpr(expr.of, scope, state, next);
      return;
    default:
      problems.push(`${where}: unknown expression kind ${(expr as { k?: unknown }).k as string}`);
  }
}

function entityOf(entity: string, state: ProgramState): Projection | undefined {
  const projection = state.projections.get(entity);
  if (projection === undefined) state.problems.push(`${state.where}: unknown entity ${entity}`);
  return projection;
}

function define(name: string, scope: Set<string>, state: ProgramState): void {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    state.problems.push(`${state.where}: invalid variable name ${String(name)}`);
    return;
  }
  scope.add(name);
}

function hasColumn(projection: Projection, field: string): boolean {
  return projection.columns.some((column) => column.name === field);
}

function isIdentifierPath(value: unknown): boolean {
  return typeof value === 'string' && value.split('.').every((part) => IDENTIFIER.test(part));
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJson(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (isRecord(value)) return Object.values(value).every((item) => isJson(item, depth + 1));
  return false;
}
