import type { Evidence, Expr, Instr, JsonValue } from '../../ir/types.js';
import type { JType, TypeDecl } from '../java/model.js';
import type { SyntaxNode } from '../java/parser.js';

/**
 * Raised anywhere the evaluator meets something it cannot model exactly.
 * The endpoint then stays UNSUPPORTED with this reason: AERIS fails closed.
 */
export class Unsupported extends Error {
  /** True when the reason is an external effect (the endpoint is then ONLINE_REQUIRED, not UNSUPPORTED). */
  external = false;

  constructor(readonly reason: string, readonly node?: SyntaxNode, readonly file?: string) {
    super(reason);
    this.name = 'Unsupported';
  }
}

export class ExternalEffect extends Unsupported {
  constructor(reason: string, node?: SyntaxNode) {
    super(reason, node);
    this.external = true;
    this.name = 'ExternalEffect';
  }
}

// ---------------------------------------------------------------------------
// Expression builders
// ---------------------------------------------------------------------------

export const lit = (v: JsonValue): Expr => ({ k: 'lit', v });
export const TRUE = lit(true);
export const FALSE = lit(false);
export const NULL = lit(null);
export const vr = (name: string): Expr => ({ k: 'var', name });
export const getf = (of: Expr, fieldName: string): Expr => ({ k: 'get', of, field: fieldName });
export const op = (name: Extract<Expr, { k: 'op' }>['op'], ...args: Expr[]): Expr => {
  // Constant folding keeps programs readable and conditions decidable at compile time.
  const [a, b] = args;
  if (a !== undefined && a.k === 'lit') {
    if (name === 'isNull') return lit(a.v === null);
    if (name === 'notNull') return lit(a.v !== null);
    if (name === 'not' && typeof a.v === 'boolean') return lit(!a.v);
    // Compile-time string constants ("prefix" + X.class.getName()); other operands keep Java's formatting at run time.
    if (name === 'concat' && args.length === 2 && b !== undefined && b.k === 'lit' && typeof a.v === 'string' && typeof b.v === 'string') return lit(a.v + b.v);
    if (b !== undefined && b.k === 'lit' && (name === 'eq' || name === 'ne') && (typeof a.v !== 'object' || a.v === null) && (typeof b.v !== 'object' || b.v === null)) {
      const equal = a.v === b.v;
      return lit(name === 'eq' ? equal : !equal);
    }
  }
  if (name === 'coalesce' && a !== undefined && a.k === 'lit' && a.v !== null) return a;
  // Literal lists (varargs, List.of): their size and constant-index elements are known.
  if (name === 'size' && a !== undefined && a.k === 'list') return lit(a.items.length);
  if (name === 'at' && a !== undefined && a.k === 'list' && b !== undefined && b.k === 'lit' && typeof b.v === 'number') {
    const item = a.items[b.v];
    if (item !== undefined) return item;
  }
  return { k: 'op', op: name, args };
};
const sizes = new WeakMap<object, number>();

/** Number of nodes of an expression (memoized). */
export function exprSize(expr: unknown): number {
  if (expr === null || typeof expr !== 'object') return 1;
  const cached = sizes.get(expr);
  if (cached !== undefined) return cached;
  let size = 1;
  for (const value of Object.values(expr as Record<string, unknown>)) {
    if (Array.isArray(value)) for (const item of value) size += exprSize(item);
    else if (value !== null && typeof value === 'object') size += exprSize(value);
    if (size > MAX_EXPRESSION_SIZE * 4) break;
  }
  sizes.set(expr, size);
  return size;
}

/** Above this, an expression is a sign of combinatorial growth: refuse rather than emit it. */
export const MAX_EXPRESSION_SIZE = 50_000;

export const cond = (test: Expr, then: Expr, otherwise: Expr): Expr => {
  if (isLit(test, true)) return then;
  if (isLit(test, false)) return otherwise;
  if (exprEqual(then, otherwise)) return then;
  const result: Expr = { k: 'cond', test, then, else: otherwise };
  if (exprSize(result) > MAX_EXPRESSION_SIZE) throw new Unsupported('The generated expression is too large (combinatorial branches).');
  return result;
};

export function isLit(expr: Expr, value?: JsonValue): boolean {
  return expr.k === 'lit' && (value === undefined || expr.v === value);
}

export function exprEqual(a: Expr, b: Expr): boolean {
  if (a === b) return true;
  const size = exprSize(a);
  if (size !== exprSize(b) || size > 2_000) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function not(expr: Expr): Expr {
  if (expr.k === 'lit' && typeof expr.v === 'boolean') return lit(!expr.v);
  if (expr.k === 'op' && expr.op === 'not') return expr.args[0]!;
  if (expr.k === 'op' && expr.op === 'isNull') return op('notNull', expr.args[0]!);
  if (expr.k === 'op' && expr.op === 'notNull') return op('isNull', expr.args[0]!);
  return op('not', expr);
}

export function and(...args: Expr[]): Expr {
  const flat: Expr[] = [];
  for (const arg of args) {
    if (isLit(arg, true)) continue;
    if (isLit(arg, false)) return FALSE;
    if (arg.k === 'op' && arg.op === 'and') flat.push(...arg.args);
    else flat.push(arg);
  }
  if (flat.length === 0) return TRUE;
  if (flat.length === 1) return flat[0]!;
  return op('and', ...flat);
}

export function or(...args: Expr[]): Expr {
  const flat: Expr[] = [];
  for (const arg of args) {
    if (isLit(arg, false)) continue;
    if (isLit(arg, true)) return TRUE;
    if (arg.k === 'op' && arg.op === 'or') flat.push(...arg.args);
    else flat.push(arg);
  }
  if (flat.length === 0) return FALSE;
  if (flat.length === 1) return flat[0]!;
  return op('or', ...flat);
}

// ---------------------------------------------------------------------------
// Symbolic values
// ---------------------------------------------------------------------------

export const T = {
  object: { name: 'java.lang.Object', args: [], array: 0 } as JType,
  string: { name: 'java.lang.String', args: [], array: 0 } as JType,
  boolean: { name: 'boolean', args: [], array: 0 } as JType,
  int: { name: 'int', args: [], array: 0 } as JType,
  long: { name: 'long', args: [], array: 0 } as JType,
  uuid: { name: 'java.util.UUID', args: [], array: 0 } as JType,
  void: { name: 'void', args: [], array: 0 } as JType,
  list: (elem: JType): JType => ({ name: 'java.util.List', args: [elem], array: 0 }),
  mono: (elem: JType): JType => ({ name: 'reactor.core.publisher.Mono', args: [elem], array: 0 }),
  flux: (elem: JType): JType => ({ name: 'reactor.core.publisher.Flux', args: [elem], array: 0 }),
};

/** A value fully described by a pure IR expression. */
export interface PureSV {
  t: 'pure';
  e: Expr;
  jt: JType;
}

let objectIds = 0;

/**
 * A Java object with identity (entity, DTO, record). Fields not set
 * explicitly are read from `base` (a stored row) or take Java defaults.
 */
export interface ObjSV {
  t: 'obj';
  id: number;
  cls: string;
  fields: Map<string, SV>;
  base?: Expr;
  /** Set when the object was loaded from a projection. */
  origin?: { entity: string };
}

export interface BuilderSV {
  t: 'builder';
  cls: string;
  fields: Map<string, SV>;
}

/** What subscribing to a Mono produces: a value valid when `empty` is false. */
export interface Emission {
  value: SV;
  empty: Expr;
}

export interface MonoSV {
  t: 'mono';
  elem: JType;
  run: (block: Block) => Emission;
}

/** A Flux whose elements are a list expression (bounded, materialized locally). */
export interface FluxSV {
  t: 'flux';
  elem: JType;
  run: (block: Block) => { list: Expr; element: (item: Expr) => SV };
}

export interface OptionalSV {
  t: 'optional';
  value: SV;
  present: Expr;
}

/** A list of pure values (query results, List.of, collectList). */
export interface ListSV {
  t: 'list';
  e: Expr;
  elem: JType;
  /** How to view one element as an SV (e.g. an entity object over the row). */
  element: (item: Expr) => SV;
}

export interface LambdaSV {
  t: 'lambda';
  params: string[];
  body: SyntaxNode;
  env: Env;
  self: SV | undefined;
  owner: TypeDecl;
}

export interface MethodRefSV {
  t: 'mref';
  /** Bound receiver (expr::m) or undefined for Type::m. */
  receiver?: SV;
  type?: string;
  name: string;
  owner: TypeDecl;
}

/** An injected Spring bean (service, adapter, mapper). */
export interface BeanSV {
  t: 'bean';
  cls: TypeDecl;
  /** Variables captured by an anonymous class instance. */
  closure?: Env;
}

export interface RepoSV {
  t: 'repo';
  repo: string;
}

/** A class used as a static receiver (Type.method()). */
export interface TypeSV {
  t: 'type';
  fqn: string;
}

export interface ExceptionSV {
  t: 'exception';
  cls: string;
  message: Expr;
  /** Explicit HTTP status (ResponseStatusException). */
  status?: number;
}

export interface TupleSV {
  t: 'tuple';
  items: SV[];
}

export interface VoidSV {
  t: 'void';
}

/** A dependency that performs I/O outside the database (HTTP client, broker, mail). */
export interface ExternalSV {
  t: 'external';
  cls: string;
}

/** A logger: calls are side-effect free for the business outcome. */
export interface LoggerSV {
  t: 'logger';
}

/** A request-scoped object (ServerHttpRequest, Authentication...) that may be passed along but not read. */
export interface OpaqueSV {
  t: 'opaque';
  what: string;
  /** For the HTTP request: the request path as an expression. */
  path?: Expr;
}

/** R2dbcEntityTemplate. */
export interface TemplateSV {
  t: 'template';
}

export interface CriteriaCondition {
  column: string;
  cmp: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'isNull' | 'notNull' | 'in' | 'between';
  values: Expr[];
}

/** Spring Data Relational Criteria / Query under construction. */
export interface CriteriaSV {
  t: 'criteria';
  conditions: CriteriaCondition[];
  /** Column named by where()/and() awaiting its operator. */
  pending?: string;
  orderBy: { column: string; dir: 'asc' | 'desc' }[];
  limit?: number;
  isQuery: boolean;
}

/** java.util.Comparator built from comparing()/reversed()/thenComparing(). */
export interface ComparatorSV {
  t: 'comparator';
  keys: { fn: SV | undefined; desc: boolean; nulls: 'first' | 'last' | 'error'; caseInsensitive: boolean }[];
}

/** org.springframework.data.domain.Sort. */
export interface SortSV {
  t: 'sort';
  orders: { column: string; dir: 'asc' | 'desc' }[];
}

/** A TransactionalOperator: local programs are always atomic. */
export interface TxOperatorSV {
  t: 'txop';
}

/** ResponseEntity under construction or built. */
export interface ResponseSV {
  t: 'response';
  status: number;
  body: SV | undefined;
}

export type SV =
  | PureSV | ObjSV | BuilderSV | MonoSV | FluxSV | OptionalSV | ListSV | LambdaSV | MethodRefSV
  | BeanSV | RepoSV | TypeSV | ExceptionSV | TupleSV | VoidSV | ResponseSV | ExternalSV | LoggerSV | TxOperatorSV
  | OpaqueSV | TemplateSV | CriteriaSV | SortSV | ComparatorSV;

export const VOID: VoidSV = { t: 'void' };

export function pure(e: Expr, jt: JType): PureSV {
  return { t: 'pure', e, jt };
}

export function obj(cls: string, fields: Map<string, SV> = new Map(), base?: Expr, origin?: { entity: string }): ObjSV {
  objectIds += 1;
  return { t: 'obj', id: objectIds, cls, fields, ...(base === undefined ? {} : { base }), ...(origin === undefined ? {} : { origin }) };
}

export function monoOf(value: SV, elem: JType, empty: Expr = FALSE): MonoSV {
  return { t: 'mono', elem, run: () => ({ value, empty }) };
}

export function describe(sv: SV): string {
  switch (sv.t) {
    case 'pure': return `value of ${sv.jt.name}`;
    case 'obj': return `object ${sv.cls}`;
    case 'bean': return `bean ${sv.cls.fqn}`;
    case 'type': return `type ${sv.fqn}`;
    default: return sv.t;
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export class Env {
  private readonly vars = new Map<string, SV>();

  constructor(private readonly parent?: Env) {}

  get(name: string): SV | undefined {
    return this.vars.get(name) ?? this.parent?.get(name);
  }

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }

  define(name: string, value: SV): void {
    this.vars.set(name, value);
  }

  /** Assignment to an existing variable, in the scope that declared it. */
  assign(name: string, value: SV): boolean {
    if (this.vars.has(name)) {
      this.vars.set(name, value);
      return true;
    }
    return this.parent?.assign(name, value) ?? false;
  }

  child(): Env {
    return new Env(this);
  }

  /** A deep copy of the variable bindings (objects keep their identity). */
  fork(): Env {
    const copy = new Env(this.parent?.fork());
    for (const [name, value] of this.vars) copy.vars.set(name, value);
    return copy;
  }

  entries(): [string, SV][] {
    return [...(this.parent?.entries() ?? []), ...this.vars];
  }

  /** Replaces bindings with another fork's (after a branch merge). */
  replaceWith(other: Env): void {
    this.vars.clear();
    for (const [name, value] of other.vars) this.vars.set(name, value);
    if (this.parent !== undefined && other.parent !== undefined) this.parent.replaceWith(other.parent);
  }

  localNames(): string[] {
    return [...(this.parent?.localNames() ?? []), ...this.vars.keys()];
  }
}

// ---------------------------------------------------------------------------
// IR blocks
// ---------------------------------------------------------------------------

export interface Counters {
  vars: number;
  uuidSlots: number;
}

/** Instructions emitted at one nesting level of the program. */
export class Block {
  readonly instrs: Instr[] = [];

  constructor(readonly counters: Counters) {}

  emit(instr: Instr): void {
    this.instrs.push(instr);
  }

  fresh(prefix: string): string {
    this.counters.vars += 1;
    return `${prefix.replace(/[^A-Za-z0-9_]/g, '_')}_${this.counters.vars}`;
  }

  child(): Block {
    return new Block(this.counters);
  }

  /** LET-binds an expression unless it is already trivial. */
  bind(expr: Expr, prefix = 'v'): Expr {
    if (expr.k === 'var' || expr.k === 'lit' || expr.k === 'param' || expr.k === 'ctx' || expr.k === 'query') return expr;
    const name = this.fresh(prefix);
    this.emit({ op: 'LET', out: name, expr });
    return vr(name);
  }
}

export interface EvidenceSink {
  add(evidence: Evidence): void;
}
