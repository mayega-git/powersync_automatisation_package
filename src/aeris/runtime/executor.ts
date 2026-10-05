import type {
  EndpointPlan,
  Expr,
  FieldType,
  Filter,
  Instr,
  JsonValue,
  Projection,
} from '../ir/types.js';
import { keyString, type ResolvedFilter, type StoredRow, type StoreTx } from './store/LocalStore.js';
import {
  AerisValueError,
  castValue,
  compareValues,
  decimalAdd,
  decimalMul,
  decimalDivide,
  decimalSetScale,
  decimalSub,
  formatNow,
  javaStrip,
  type RoundingMode,
  normalizeStored,
  valuesEqual,
} from './values.js';

/** A request as the runtime receives it, before any conversion. */
export interface ExecutionRequest {
  /** Raw path variables extracted by the router. */
  params: Readonly<Record<string, string>>;
  /** Raw query string values; absent parameters are missing keys. */
  query: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body, or undefined when the request has none. */
  body: JsonValue | undefined;
  /** Trusted session claims (never taken from the request itself). */
  context: Readonly<Record<string, JsonValue>>;
  /** Request path, used in error bodies. */
  path: string;
}

/** Non-deterministic inputs, captured once per operation and journaled with it. */
export interface Captured {
  now: number;
  uuids: readonly string[];
}

export interface Effect {
  entity: string;
  key: JsonValue;
  op: 'insert' | 'update' | 'delete';
  before: StoredRow | null;
  after: StoredRow | null;
}

export interface ExecutionResult {
  status: number;
  body: JsonValue | null;
  queued: boolean;
  effects: Effect[];
  events: { name: string; payload: JsonValue }[];
}

/** An error the backend would have returned; carries the HTTP status. */
export class AerisHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Exact error body when the artifact carries the backend's handler shape. */
    readonly body?: JsonValue,
  ) {
    super(message);
    this.name = 'AerisHttpError';
  }
}

/** The program cannot be executed (a bug or a tampered artifact), never a business outcome. */
export class AerisExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AerisExecutionError';
  }
}

const MAX_STEPS = 100_000;

export interface ExecutorOptions {
  projections: ReadonlyMap<string, Projection>;
  serverTimeZone: string;
}

/**
 * Deterministic interpreter of AERIS programs. Given the same projections,
 * request and captured values, it always produces the same result and the
 * same effects; it performs no I/O besides the store transaction it is given.
 */
export class Executor {
  constructor(private readonly options: ExecutorOptions) {}

  /** Evaluates a compiled authorization check on session claims (no data access). */
  check(plan: EndpointPlan, test: Expr, context: Readonly<Record<string, JsonValue>>): boolean {
    const request: ExecutionRequest = { params: {}, query: {}, body: undefined, context, path: plan.path };
    const frame = new Frame(this.options, plan, { params: {}, query: {}, body: undefined }, request, { now: Date.now(), uuids: [] }, undefined as unknown as StoreTx);
    const value = frame.eval(test);
    if (typeof value !== 'boolean') throw new AerisExecutionError(`Authorization check of ${plan.id} is not boolean.`);
    return value;
  }

  async execute(plan: EndpointPlan, request: ExecutionRequest, captured: Captured, tx: StoreTx): Promise<ExecutionResult> {
    if (plan.program === undefined) throw new AerisExecutionError(`${plan.id} has no program.`);
    if (captured.uuids.length < plan.uuidSlots) throw new AerisExecutionError(`${plan.id} needs ${plan.uuidSlots} captured identifiers.`);
    const frame = new Frame(this.options, plan, bindInput(plan, request), request, captured, tx);
    const outcome = await frame.block(plan.program);
    if (outcome === undefined) throw new AerisExecutionError(`${plan.id} ended without RETURN.`);
    return {
      status: outcome.status,
      body: outcome.body,
      queued: frame.queued,
      effects: frame.effects,
      events: frame.events,
    };
  }
}

interface BoundInput {
  params: Record<string, JsonValue>;
  query: Record<string, JsonValue>;
  body: JsonValue | undefined;
}

/** Converts raw request values to declared types, answering 400 like the backend's binder. */
function bindInput(plan: EndpointPlan, request: ExecutionRequest): BoundInput {
  const params: Record<string, JsonValue> = {};
  for (const [name, type] of Object.entries(plan.input.params)) {
    const raw = request.params[name];
    if (raw === undefined) throw new AerisHttpError(400, 'MISSING_PATH_VARIABLE', `Missing path variable ${name}.`);
    params[name] = convert(raw, type, `path variable ${name}`);
  }
  const query: Record<string, JsonValue> = {};
  for (const [name, spec] of Object.entries(plan.input.query)) {
    const raw = request.query[name];
    if (raw === undefined || raw === '') {
      if (spec.required) throw new AerisHttpError(400, 'MISSING_PARAMETER', `Required parameter ${name} is not present.`);
      query[name] = null;
    } else {
      query[name] = convert(raw, spec, `parameter ${name}`);
    }
  }
  let body: JsonValue | undefined;
  if (plan.input.body !== undefined) {
    if (request.body === undefined || request.body === null) {
      if (plan.input.body.required) throw new AerisHttpError(400, 'MISSING_BODY', 'Required request body is missing.');
      body = null;
    } else {
      if (typeof request.body !== 'object' || Array.isArray(request.body)) {
        throw new AerisHttpError(400, 'INVALID_BODY', 'The request body must be a JSON object.');
      }
      const fields: Record<string, JsonValue> = {};
      for (const [name, type] of Object.entries(plan.input.body.fields)) {
        fields[name] = convert((request.body as Record<string, JsonValue>)[name] ?? null, type, `field ${name}`);
      }
      body = fields;
    }
  }
  return { params, query, body };
}

function convert(raw: JsonValue, type: FieldType, label: string): JsonValue {
  if (raw === null) return null;
  try {
    if (type.list === true) {
      if (!Array.isArray(raw)) throw new AerisValueError('expected a list');
      return raw.map((item) => castValue(item, type.type, type.values));
    }
    return castValue(raw, type.type, type.values);
  } catch (error) {
    throw new AerisHttpError(400, 'INVALID_VALUE', `Invalid ${label}: ${(error as Error).message}`);
  }
}

class Frame {
  readonly effects: Effect[] = [];
  readonly events: { name: string; payload: JsonValue }[] = [];
  queued = false;
  private readonly vars = new Map<string, JsonValue>();
  private steps = 0;

  constructor(
    private readonly options: ExecutorOptions,
    private readonly plan: EndpointPlan,
    private readonly input: BoundInput,
    private readonly request: ExecutionRequest,
    private readonly captured: Captured,
    private readonly tx: StoreTx,
  ) {}

  async block(instructions: readonly Instr[]): Promise<{ status: number; body: JsonValue | null } | undefined> {
    for (const instr of instructions) {
      const outcome = await this.instr(instr);
      if (outcome !== undefined) return outcome;
    }
    return undefined;
  }

  private tick(): void {
    this.steps += 1;
    if (this.steps > MAX_STEPS) throw new AerisExecutionError(`${this.plan.id} exceeded the execution budget.`);
  }

  private async instr(instr: Instr): Promise<{ status: number; body: JsonValue | null } | undefined> {
    this.tick();
    switch (instr.op) {
      case 'QUERY': {
        const projection = this.projection(instr.entity);
        const where = instr.where.map((filter) => this.resolveFilter(filter, projection));
        const rows = (await this.tx.find(instr.entity, where, {
          orderBy: instr.orderBy,
          limit: instr.mode === 'one' ? 2 : instr.limit,
        })).map((row) => this.normalizeRow(row, projection));
        switch (instr.mode) {
          case 'one':
            if (rows.length > 1) {
              throw new AerisHttpError(500, 'INCORRECT_RESULT_SIZE', `Query on ${instr.entity} returned more than one row.`);
            }
            this.vars.set(instr.out, rows[0] ?? null);
            break;
          case 'many':
            this.vars.set(instr.out, rows);
            break;
          case 'count':
            this.vars.set(instr.out, rows.length);
            break;
          case 'exists':
            this.vars.set(instr.out, rows.length > 0);
            break;
        }
        return undefined;
      }
      case 'LET':
        this.vars.set(instr.out, this.eval(instr.expr));
        return undefined;
      case 'ASSERT':
        if (!truthy(this.eval(instr.test))) {
          const message = this.eval(instr.error.message);
          const text = typeof message === 'string' ? message : JSON.stringify(message);
          const body = instr.error.body === undefined ? undefined : this.eval(instr.error.body, new Map([['$message', text]]));
          throw new AerisHttpError(instr.error.status, instr.error.code, text, body);
        }
        return undefined;
      case 'IF':
        return truthy(this.eval(instr.test)) ? this.block(instr.then) : this.block(instr.else);
      case 'INSERT': {
        const projection = this.projection(instr.entity);
        const row: StoredRow = {};
        for (const column of projection.columns) {
          const expr = instr.values[column.name];
          row[column.name] = expr === undefined ? null : this.storable(this.eval(expr), column.type, `${instr.entity}.${column.name}`);
        }
        const key = row[projection.key] ?? null;
        if (key === null) throw new AerisHttpError(500, 'NULL_KEY', `Cannot insert ${instr.entity} without a key.`);
        if (await this.tx.get(instr.entity, key) !== null) {
          throw new AerisHttpError(500, 'DUPLICATE_KEY', `A ${instr.entity} with this key already exists.`);
        }
        await this.tx.insert(instr.entity, row);
        this.effects.push({ entity: instr.entity, key, op: 'insert', before: null, after: row });
        if (instr.out !== undefined) this.vars.set(instr.out, row);
        return undefined;
      }
      case 'UPDATE': {
        const projection = this.projection(instr.entity);
        const key = this.eval(instr.key);
        if (key === null) throw new AerisHttpError(500, 'NULL_KEY', `Cannot update ${instr.entity} without a key.`);
        const before = await this.tx.get(instr.entity, key);
        if (before === null) {
          throw new AerisHttpError(500, 'ROW_NOT_FOUND', `${instr.entity} ${keyString(key)} does not exist.`);
        }
        const values: StoredRow = {};
        for (const [field, expr] of Object.entries(instr.values)) {
          const column = projection.columns.find((candidate) => candidate.name === field)!;
          values[field] = this.storable(this.eval(expr), column.type, `${instr.entity}.${field}`);
        }
        const after = await this.tx.update(instr.entity, key, values);
        if (after === null) throw new AerisExecutionError(`${instr.entity} vanished during the transaction.`);
        this.effects.push({ entity: instr.entity, key, op: 'update', before, after });
        if (instr.out !== undefined) this.vars.set(instr.out, this.normalizeRow(after, projection));
        return undefined;
      }
      case 'DELETE': {
        const key = this.eval(instr.key);
        if (key === null) return undefined;
        const before = await this.tx.get(instr.entity, key);
        if (before !== null) {
          await this.tx.delete(instr.entity, key);
          this.effects.push({ entity: instr.entity, key, op: 'delete', before, after: null });
        }
        return undefined;
      }
      case 'EMIT_LOCAL_EVENT':
        this.events.push({ name: instr.name, payload: this.eval(instr.payload) });
        return undefined;
      case 'QUEUE_INTENT':
        this.queued = true;
        return undefined;
      case 'RETURN':
        return { status: instr.status, body: instr.body === null ? null : this.eval(instr.body) };
      default:
        throw new AerisExecutionError(`Unknown instruction ${(instr as { op: string }).op}.`);
    }
  }

  private projection(entity: string): Projection {
    const projection = this.options.projections.get(entity);
    if (projection === undefined) throw new AerisExecutionError(`Unknown entity ${entity}.`);
    return projection;
  }

  private normalizeRow(row: StoredRow, projection: Projection): StoredRow {
    const out: StoredRow = {};
    for (const column of projection.columns) out[column.name] = normalizeStored(row[column.name], column.type);
    return out;
  }

  private storable(value: JsonValue, type: FieldType, label: string): JsonValue {
    if (value === null) {
      if (!type.nullable) throw new AerisHttpError(500, 'NOT_NULL_VIOLATION', `${label} cannot be null.`);
      return null;
    }
    let stored: JsonValue;
    try {
      stored = type.list === true || type.type === 'json' ? value : castValue(value, type.type, type.values);
    } catch (error) {
      throw new AerisHttpError(500, 'TYPE_MISMATCH', `${label}: ${(error as Error).message}`);
    }
    // varchar(n): PostgreSQL counts characters (code points).
    if (type.maxLength !== undefined && typeof stored === 'string' && [...stored].length > type.maxLength) {
      throw new AerisHttpError(500, 'VALUE_TOO_LONG', `${label} is longer than ${type.maxLength} characters.`);
    }
    return stored;
  }

  private resolveFilter(filter: Filter, projection: Projection): ResolvedFilter {
    if (filter.value === undefined) return { field: filter.field, cmp: filter.cmp };
    let value = this.eval(filter.value);
    const column = projection.columns.find((candidate) => candidate.name === filter.field);
    if (column !== undefined && value !== null && column.type.type === 'uuid') {
      value = Array.isArray(value)
        ? value.map((item) => (typeof item === 'string' ? item.toLowerCase() : item))
        : typeof value === 'string' ? value.toLowerCase() : value;
    }
    return { field: filter.field, cmp: filter.cmp, value };
  }

  eval(expr: Expr, scope?: Map<string, JsonValue>): JsonValue {
    this.tick();
    switch (expr.k) {
      case 'lit':
        return expr.v;
      case 'input': {
        let value: JsonValue | undefined = this.input.body;
        for (const part of expr.path) {
          if (value === null || value === undefined) return null;
          if (typeof value !== 'object' || Array.isArray(value)) return null;
          value = (value as Record<string, JsonValue>)[part];
        }
        return value ?? null;
      }
      case 'param':
        return this.input.params[expr.name] ?? null;
      case 'query':
        return this.input.query[expr.name] ?? null;
      case 'ctx': {
        const value = this.request.context[expr.name];
        return value === undefined ? null : value;
      }
      case 'var': {
        if (scope?.has(expr.name)) return scope.get(expr.name)!;
        if (!this.vars.has(expr.name)) throw new AerisExecutionError(`Variable ${expr.name} is not defined.`);
        return this.vars.get(expr.name)!;
      }
      case 'get': {
        const target = this.eval(expr.of, scope);
        if (target === null) {
          throw new AerisHttpError(500, 'NULL_DEREFERENCE', `Cannot read ${expr.field} of null.`);
        }
        if (typeof target !== 'object' || Array.isArray(target)) {
          throw new AerisExecutionError(`Cannot read ${expr.field} of a non-object value.`);
        }
        return (target as Record<string, JsonValue>)[expr.field] ?? null;
      }
      case 'now':
        return formatNow(this.captured.now, expr.type, this.options.serverTimeZone);
      case 'uuid': {
        const value = this.captured.uuids[expr.slot];
        if (value === undefined) throw new AerisExecutionError(`No captured identifier for slot ${expr.slot}.`);
        return value;
      }
      case 'cond':
        return truthy(this.eval(expr.test, scope)) ? this.eval(expr.then, scope) : this.eval(expr.else, scope);
      case 'op':
        return this.op(expr, scope);
      case 'object': {
        const out: Record<string, JsonValue> = {};
        for (const [name, value] of Object.entries(expr.fields)) out[name] = this.eval(value, scope);
        return out;
      }
      case 'list':
        return expr.items.map((item) => this.eval(item, scope));
      case 'map':
      case 'filter': {
        const source = this.eval(expr.of, scope);
        if (source === null) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'Cannot iterate over null.');
        if (!Array.isArray(source)) throw new AerisExecutionError('map/filter over a non-list value.');
        const inner = new Map(scope ?? []);
        const out: JsonValue[] = [];
        for (const item of source) {
          inner.set(expr.as, item);
          const value = this.eval(expr.body, inner);
          if (expr.k === 'map') out.push(value);
          else if (truthy(value)) out.push(item);
        }
        return out;
      }
      case 'fold': {
        const source = this.eval(expr.of, scope);
        if (source === null) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'Cannot iterate over null.');
        if (!Array.isArray(source)) throw new AerisExecutionError('fold over a non-list value.');
        const inner = new Map(scope ?? []);
        let acc = this.eval(expr.init, scope);
        for (const item of source) {
          inner.set(expr.as, item);
          inner.set(expr.acc, acc);
          acc = this.eval(expr.body, inner);
        }
        return acc;
      }
      case 'try': {
        try {
          return this.eval(expr.body, scope);
        } catch (error) {
          if (!(error instanceof AerisHttpError)) throw error;
          if (expr.catches === 'cast' && error.code !== 'INVALID_VALUE') throw error;
          return this.eval(expr.fallback, scope);
        }
      }
      case 'sort': {
        const source = this.eval(expr.of, scope);
        if (source === null) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'Cannot sort null.');
        if (!Array.isArray(source)) throw new AerisExecutionError('sort over a non-list value.');
        const inner = new Map(scope ?? []);
        const keyed = source.map((item, index) => {
          inner.set(expr.as, item);
          const keys = expr.keys.map((key) => {
            const value = this.eval(key.key, inner);
            if (value === null && key.nulls === 'error') throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'Comparator key is null.');
            return value;
          });
          return { item, index, keys };
        });
        keyed.sort((left, right) => {
          for (const [position, spec] of expr.keys.entries()) {
            const a = left.keys[position]!;
            const b = right.keys[position]!;
            let order: number;
            if (a === null || b === null) {
              order = a === b ? 0 : (a === null) === (spec.nulls === 'first') ? -1 : 1;
              if (order !== 0) return order;
              continue;
            }
            const compared = compareValues(a, b);
            if (compared === null) throw new AerisExecutionError('Incomparable sort keys.');
            order = spec.desc ? -compared : compared;
            if (order !== 0) return order;
          }
          return left.index - right.index;
        });
        return keyed.map((entry) => entry.item);
      }
      case 'cast': {
        const value = this.eval(expr.of, scope);
        try {
          return castValue(value, expr.to, expr.values);
        } catch (error) {
          throw new AerisHttpError(400, 'INVALID_VALUE', (error as Error).message);
        }
      }
      default:
        throw new AerisExecutionError(`Unknown expression ${(expr as { k: string }).k}.`);
    }
  }

  private op(expr: Extract<Expr, { k: 'op' }>, scope?: Map<string, JsonValue>): JsonValue {
    const args = expr.args;
    // Short-circuit operators evaluate lazily, like && and || in Java.
    if (expr.op === 'and') {
      for (const arg of args) if (!truthy(this.eval(arg, scope))) return false;
      return true;
    }
    if (expr.op === 'or') {
      for (const arg of args) if (truthy(this.eval(arg, scope))) return true;
      return false;
    }
    if (expr.op === 'coalesce') {
      for (const arg of args) {
        const value = this.eval(arg, scope);
        if (value !== null) return value;
      }
      return null;
    }
    const values = args.map((arg) => this.eval(arg, scope));
    const [a = null, b = null] = values;
    switch (expr.op) {
      case 'eq':
        return a === null || b === null ? a === b : valuesEqual(a, b);
      case 'ne':
        return !(a === null || b === null ? a === b : valuesEqual(a, b));
      case 'lt': case 'le': case 'gt': case 'ge': {
        const order = compareValues(nonNull(a), nonNull(b));
        if (order === null) throw new AerisExecutionError(`Cannot compare ${JSON.stringify(a)} and ${JSON.stringify(b)}.`);
        return expr.op === 'lt' ? order < 0 : expr.op === 'le' ? order <= 0 : expr.op === 'gt' ? order > 0 : order >= 0;
      }
      case 'not':
        return !truthy(a);
      case 'isNull':
        return a === null;
      case 'notNull':
        return a !== null;
      case 'add':
        return decimalAdd(num(a), num(b));
      case 'sub':
        return decimalSub(num(a), num(b));
      case 'mul':
        return decimalMul(num(a), num(b));
      case 'div': {
        const divisor = num(b);
        if (divisor === 0) throw new AerisHttpError(500, 'ARITHMETIC', 'Division by zero.');
        const dividend = num(a);
        if (!Number.isInteger(dividend) || !Number.isInteger(divisor)) {
          throw new AerisExecutionError('Decimal division is not supported by the IR.');
        }
        return Math.trunc(dividend / divisor);
      }
      case 'mod': {
        const divisor = num(b);
        if (divisor === 0) throw new AerisHttpError(500, 'ARITHMETIC', 'Division by zero.');
        return num(a) % divisor;
      }
      case 'neg':
        return -num(a);
      case 'abs':
        return Math.abs(num(a));
      case 'min':
        return Math.min(...values.map(num));
      case 'max':
        return Math.max(...values.map(num));
      case 'concat':
        return values.map(javaString).join('');
      case 'lower':
        return str(a).toLowerCase();
      case 'upper':
        return str(a).toUpperCase();
      case 'trim':
        return javaTrim(str(a));
      case 'length':
        return str(a).length;
      case 'isEmpty':
        return Array.isArray(a) ? a.length === 0 : str(a).length === 0;
      case 'isBlank':
        // Hibernate Validator @NotBlank: String.trim() strips code points <= U+0020.
        return a === null ? true : javaTrim(str(a)).length === 0;
      case 'startsWith':
        return str(a).startsWith(str(b));
      case 'endsWith':
        return str(a).endsWith(str(b));
      case 'contains':
        return Array.isArray(a) ? a.some((item) => item !== null && b !== null && valuesEqual(item, b)) : str(a).includes(str(b));
      case 'size':
        if (!Array.isArray(a)) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'size() of a non-list value.');
        return a.length;
      case 'append': {
        if (!Array.isArray(a)) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'add() on a non-list value.');
        return [...a, b];
      }
      case 'take': {
        if (!Array.isArray(a)) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'take() of a non-list value.');
        return a.slice(0, Math.max(0, num(b)));
      }
      case 'strip':
        return javaStrip(str(a));
      case 'setScale': {
        const mode = str(values[2] ?? null) as RoundingMode;
        try {
          return decimalSetScale(num(a), num(b), mode);
        } catch (error) {
          throw new AerisHttpError(500, 'ARITHMETIC', (error as Error).message);
        }
      }
      case 'divide': {
        const mode = str(values[3] ?? null) as RoundingMode;
        try {
          return decimalDivide(num(a), num(b), num(values[2] ?? null), mode);
        } catch (error) {
          throw new AerisHttpError(500, 'ARITHMETIC', (error as Error).message);
        }
      }
      case 'first':
        if (!Array.isArray(a)) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'first() of a non-list value.');
        return a[0] ?? null;
      case 'replace': {
        const target = str(b);
        const replacement = str(values[2] ?? null);
        const subject = str(a);
        // Java: an empty target inserts the replacement around every char.
        if (target.length === 0) return replacement + [...subject].join(replacement) + (subject.length > 0 ? replacement : '');
        return subject.split(target).join(replacement);
      }
      default:
        throw new AerisExecutionError(`Unknown operator ${expr.op}.`);
    }
  }
}

function truthy(value: JsonValue): boolean {
  if (typeof value !== 'boolean') {
    if (value === null) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'A condition evaluated to null.');
    throw new AerisExecutionError(`A condition evaluated to a non-boolean value ${JSON.stringify(value)}.`);
  }
  return value;
}

function nonNull(value: JsonValue): JsonValue {
  if (value === null) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'Comparison with null.');
  return value;
}

function num(value: JsonValue): number {
  if (value === null) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'Arithmetic on null.');
  if (typeof value !== 'number') throw new AerisExecutionError(`Arithmetic on a non-number ${JSON.stringify(value)}.`);
  return value;
}

function str(value: JsonValue): string {
  if (value === null) throw new AerisHttpError(500, 'NULL_DEREFERENCE', 'String operation on null.');
  if (typeof value !== 'string') throw new AerisExecutionError(`String operation on ${JSON.stringify(value)}.`);
  return value;
}

function javaTrim(text: string): string {
  return text.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
}

/** String.valueOf semantics for concatenation (collections as AbstractCollection.toString()). */
function javaString(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(javaString).join(', ')}]`;
  return JSON.stringify(value);
}
