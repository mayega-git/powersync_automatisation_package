import { createHash } from 'node:crypto';
import type { ErrorSpec, Evidence, EvidenceKind, Expr, FieldType, Filter } from '../../ir/types.js';
import { typeName, type FieldDecl, type JavaProject, type JType, type MethodDecl, type TypeDecl } from '../java/model.js';
import { field, named, stringValue, type SyntaxNode } from '../java/parser.js';
import type { CompilerConfig } from '../config.js';
import { asBool, attempt, branch, Diverged, emitIf, foldPureInstrs, mergeEmission, restoreObjects, simplifyCond, snapshotObjects } from './branching.js';
import { libraryInstance, libraryStatic, libraryStaticField } from './library.js';
import { CRUD_METHODS, fieldTypeOf, type EntityModel, type PersistenceModel, type RepositoryModel } from './persistence.js';
import { reactiveCall } from './reactive.js';
import {
  and,
  Block,
  cond,
  exprSize,
  describe,
  Env,
  ExternalEffect,
  FALSE,
  getf,
  isLit,
  lit,
  not,
  NULL,
  obj,
  op,
  or,
  pure,
  T,
  TRUE,
  Unsupported,
  VOID,
  vr,
  type BuilderSV,
  type Counters,
  type CriteriaCondition,
  type CriteriaSV,
  type PureSV,
  type Emission,
  type ExceptionSV,
  type FluxSV,
  type ListSV,
  type MonoSV,
  type ObjSV,
  type SV,
} from './sv.js';

export interface Scope {
  env: Env;
  self: SV | undefined;
  owner: TypeDecl;
  block: Block;
}

/** Maps a thrown exception to the HTTP error the backend's handlers produce. */
export interface ErrorMapper {
  map(exception: ExceptionSV): ErrorSpec;
}

/**
 * How a statement sequence completes: normally, by returning, or by returning
 * only when `test` holds (otherwise execution continues after the statement).
 */
type Completion = { kind: 'normal' } | { kind: 'return'; value: SV } | { kind: 'partial'; test: Expr; value: SV };

/** Mutable collections are objects with identity: lists keep `$items`, maps keep one field per literal key. */
export const MUTABLE_LIST = 'aeris.MutableList';
export const MUTABLE_MAP = 'aeris.MutableMap';
/** Insertion-ordered set of scalars (LinkedHashSet; HashSet iteration order is unspecified anyway). */
export const MUTABLE_SET = 'aeris.MutableSet';

const BEAN_ANNOTATIONS = new Set(['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration']);
const THROWABLE = new Set(['java.lang.Throwable', 'java.lang.Exception', 'java.lang.RuntimeException', 'Throwable', 'Exception', 'RuntimeException']);

/**
 * Symbolic interpreter for the subset of Java, Spring, Reactor and Lombok
 * that request handlers use. It executes handler code over symbolic values
 * and emits the equivalent AERIS program. Whatever it cannot model exactly
 * raises Unsupported: there is no approximation.
 */
export class Evaluator {
  readonly counters: Counters = { vars: 0, uuidSlots: 0 };
  readonly objects: ObjSV[] = [];
  readonly reads = new Set<string>();
  readonly writes = new Set<string>();
  readonly evidence: Evidence[] = [];
  readonly speculative: string[] = [];
  readonly entities = new Map<string, EntityModel>();
  private readonly evidenceKeys = new Set<string>();
  private readonly stack: string[] = [];
  private readonly constants = new Map<FieldDecl, SV>();

  constructor(
    readonly project: JavaProject,
    readonly persistence: PersistenceModel,
    readonly config: CompilerConfig,
    readonly errors: ErrorMapper,
  ) {}

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  record(kind: EvidenceKind, node: SyntaxNode, file: string, symbol: string): void {
    const key = `${kind}:${file}:${node.startIndex}:${node.endIndex}`;
    if (this.evidenceKeys.has(key)) return;
    this.evidenceKeys.add(key);
    this.evidence.push({
      kind,
      file,
      symbol,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      excerptHash: `sha256:${createHash('sha256').update(node.text).digest('hex')}`,
    });
  }

  fail(reason: string, node?: SyntaxNode, scope?: { owner: TypeDecl }): never {
    const where = node !== undefined && scope !== undefined ? ` (${scope.owner.file.path}:${node.startPosition.row + 1})` : '';
    throw new Unsupported(`${reason}${where}`, node);
  }

  // -------------------------------------------------------------------------
  // Objects
  // -------------------------------------------------------------------------

  newObject(cls: string, fields: Map<string, SV> = new Map(), base?: Expr, origin?: { entity: string }): ObjSV {
    const created = obj(cls, fields, base, origin);
    this.objects.push(created);
    return created;
  }

  /** Declared type of a property of a class (field or record component). */
  propertyType(cls: string, name: string): JType | undefined {
    if (cls === MUTABLE_LIST || cls === MUTABLE_SET) return name === '$items' ? T.list(T.object) : undefined;
    if (cls === MUTABLE_MAP) return T.object;
    const decl = this.project.type(cls);
    if (decl === undefined) return undefined;
    if (decl.kind === 'record') return decl.recordComponents.find((component) => component.name === name)?.type;
    return this.project.instanceFields(decl).find((candidate) => candidate.name === name)?.type;
  }

  /** Properties of a class in declaration order (fields, or record components). */
  properties(cls: string, target?: ObjSV): { name: string; jt: JType }[] {
    if (cls === MUTABLE_LIST || cls === MUTABLE_SET) return [{ name: '$items', jt: T.list(T.object) }];
    if (cls === MUTABLE_MAP) return [...(target?.fields.keys() ?? [])].map((name) => ({ name, jt: T.object }));
    const decl = this.project.type(cls);
    if (decl === undefined) return [];
    if (decl.kind === 'record') return decl.recordComponents.map((component) => ({ name: component.name, jt: component.type }));
    return this.project.instanceFields(decl).map((decl2) => ({ name: decl2.name, jt: decl2.type }));
  }

  readField(target: ObjSV, name: string): SV {
    const value = target.fields.get(name);
    if (value !== undefined) return value;
    if (target.cls === MUTABLE_MAP) return pure(NULL, T.object);
    if (target.cls === MUTABLE_LIST || target.cls === MUTABLE_SET) return { t: 'list', e: lit([]), elem: T.object, element: (item) => pure(item, T.object) };
    const jt = this.propertyType(target.cls, name);
    if (jt === undefined) throw new Unsupported(`${typeName({ name: target.cls, args: [], array: 0 })} has no property ${name}.`);
    if (target.base !== undefined) return this.view(getf(target.base, name), jt);
    return defaultValue(jt);
  }

  writeField(target: ObjSV, name: string, value: SV): void {
    if (this.propertyType(target.cls, name) === undefined) {
      throw new Unsupported(`${target.cls} has no property ${name}.`);
    }
    target.fields.set(name, value);
  }

  /** A pure expression of a declared type, viewed as an object when the type is a project class. */
  view(e: Expr, jt: JType): SV {
    const decl = this.project.type(jt.name);
    if (decl !== undefined && (decl.kind === 'class' || decl.kind === 'record') && jt.array === 0) {
      return obj(jt.name, new Map(), e);
    }
    if (isListType(jt)) {
      const elem = jt.args[0] ?? T.object;
      return { t: 'list', e, elem, element: (item) => this.view(item, elem) } satisfies ListSV;
    }
    return pure(e, jt);
  }

  /** Any list-like value as a ListSV (query results, List.of, mutable lists, list-typed columns). */
  asList(value: SV, node: SyntaxNode, scope: Scope): ListSV {
    if (value.t === 'list') return value;
    if (value.t === 'obj' && (value.cls === MUTABLE_LIST || value.cls === MUTABLE_SET)) {
      const items = this.readField(value, '$items');
      if (items.t === 'list') return items;
      if (items.t === 'pure') return { t: 'list', e: items.e, elem: T.object, element: (item) => pure(item, T.object) };
    }
    if (value.t === 'pure' && isListType(value.jt)) {
      const elem = value.jt.args[0] ?? T.object;
      return { t: 'list', e: value.e, elem, element: (item) => this.view(item, elem) };
    }
    this.fail(`${describe(value)} is not a list`, node, scope);
  }

  /** Encodes a value as an IR expression (objects become object literals). */
  encode(value: SV, depth = 0): Expr {
    if (depth > 16) throw new Unsupported('Object graph is too deep to encode.');
    switch (value.t) {
      case 'pure':
        return value.e;
      case 'obj': {
        if (value.base !== undefined && value.fields.size === 0) return value.base;
        if (value.cls === MUTABLE_LIST || value.cls === MUTABLE_SET) return this.encode(this.readField(value, '$items'), depth + 1);
        const fields: Record<string, Expr> = {};
        for (const property of this.properties(value.cls, value)) fields[property.name] = this.encode(this.readField(value, property.name), depth + 1);
        return { k: 'object', fields };
      }
      case 'list':
        return value.e;
      case 'void':
        return NULL;
      case 'optional':
        return cond(value.present, this.encode(value.value, depth + 1), NULL);
      default:
        throw new Unsupported(`Cannot represent ${describe(value)} as data.`);
    }
  }

  // -------------------------------------------------------------------------
  // Merging
  // -------------------------------------------------------------------------

  merge(test: Expr, a: SV, b: SV): SV {
    if (a === b) return a;
    if (isLit(test, true)) return a;
    if (isLit(test, false)) return b;
    if (a.t === 'pure' && b.t === 'pure') return pure(cond(test, a.e, b.e), a.jt.name === 'java.lang.Object' ? b.jt : a.jt);
    if (a.t === 'obj' && b.t === 'obj' && a.cls === b.cls) {
      if (a.base !== undefined && b.base !== undefined && a.fields.size === 0 && b.fields.size === 0) {
        return obj(a.cls, new Map(), cond(test, a.base, b.base), a.origin ?? b.origin);
      }
      const fields = new Map<string, SV>();
      for (const property of this.properties(a.cls)) {
        fields.set(property.name, this.merge(test, this.readField(a, property.name), this.readField(b, property.name)));
      }
      return this.newObject(a.cls, fields, undefined, a.origin ?? b.origin);
    }
    if ((a.t === 'obj' && b.t === 'pure' && isLit(b.e, null)) || (b.t === 'obj' && a.t === 'pure' && isLit(a.e, null))) {
      const object = (a.t === 'obj' ? a : b) as ObjSV;
      const encoded = this.encode(object);
      return obj(object.cls, new Map(), a.t === 'obj' ? cond(test, encoded, NULL) : cond(test, NULL, encoded));
    }
    if (a.t === 'list' && b.t === 'list') return { ...a, e: cond(test, a.e, b.e) };
    if (a.t === 'list' && b.t === 'pure') return { ...a, e: cond(test, a.e, b.e) };
    if ((a.t === 'obj' && a.cls === MUTABLE_LIST && b.t === 'list') || (b.t === 'obj' && b.cls === MUTABLE_LIST && a.t === 'list')) {
      const left = a.t === 'list' ? a : this.readField(a as ObjSV, '$items') as ListSV;
      const right = b.t === 'list' ? b : this.readField(b as ObjSV, '$items') as ListSV;
      return { ...left, e: cond(test, left.e, right.e) };
    }
    if (a.t === 'pure' && b.t === 'list') return { ...b, e: cond(test, a.e, b.e) };
    if (a.t === 'optional' && b.t === 'optional') {
      return { t: 'optional', value: this.merge(test, a.value, b.value), present: cond(test, a.present, b.present) };
    }
    if (a.t === 'mono' && b.t === 'mono') {
      return {
        t: 'mono',
        elem: a.elem,
        run: (block) => branch(block, test, (child) => a.run(child), (child) => b.run(child), (t2, x, y) => mergeEmission(t2, x, y, (t3, p, q) => this.merge(t3, p, q))),
      } satisfies MonoSV;
    }
    if (a.t === 'flux' && b.t === 'flux') {
      return {
        t: 'flux',
        elem: a.elem,
        run: (block) => branch(block, test, (child) => a.run(child), (child) => b.run(child), (t2, x, y) => ({ list: cond(t2, x.list, y.list), element: x.element })),
      } satisfies FluxSV;
    }
    if (a.t === 'response' && b.t === 'response' && a.status === b.status) {
      const body = a.body === undefined || b.body === undefined
        ? (a.body === b.body ? undefined : this.fail('Responses with and without a body cannot be merged.'))
        : this.merge(test, a.body, b.body);
      return { t: 'response', status: a.status, body };
    }
    if (a.t === 'void' && b.t === 'void') return a;
    if (a.t === b.t && (a.t === 'bean' || a.t === 'repo' || a.t === 'type' || a.t === 'logger')) {
      if (JSON.stringify(a) === JSON.stringify(b)) return a;
    }
    throw new Unsupported(`Cannot merge ${describe(a)} and ${describe(b)} across a condition.`);
  }

  /** Binds a large merged value to a variable so later merges reference it instead of copying it. */
  compact(value: SV, block: Block | undefined): SV {
    if (block === undefined || value.t !== 'pure' || exprSize(value.e) < 48) return value;
    return pure(block.bind(value.e, 'merged'), value.jt);
  }

  private mergeObjectStates(test: Expr, before: Map<ObjSV, Map<string, SV>>, left: Map<ObjSV, Map<string, SV>>, right: Map<ObjSV, Map<string, SV>>, block?: Block): void {
    for (const [target] of before) {
      const a = left.get(target) ?? new Map();
      const b = right.get(target) ?? new Map();
      const names = new Set([...a.keys(), ...b.keys()]);
      target.fields.clear();
      for (const name of names) {
        const va = a.get(name);
        const vb = b.get(name);
        if (va !== undefined && va === vb) {
          target.fields.set(name, va);
          continue;
        }
        const left2 = va ?? this.fallbackField(target, name);
        const right2 = vb ?? this.fallbackField(target, name);
        target.fields.set(name, this.compact(this.merge(test, left2, right2), block));
      }
    }
  }

  private fallbackField(target: ObjSV, name: string): SV {
    const saved = target.fields.get(name);
    target.fields.delete(name);
    try {
      return this.readField(target, name);
    } finally {
      if (saved !== undefined) target.fields.set(name, saved);
    }
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  /** Evaluates a method or lambda body block; returns the returned value (VOID for void). */
  runBody(body: SyntaxNode, scope: Scope): SV {
    const completion = this.statements(statementsOf(body), 0, scope);
    // A conditional return at the end of a body: the other paths fall off the end (void methods).
    return completion.kind === 'normal' ? VOID : completion.value;
  }

  /**
   * Two-way control split. Each side runs on its own copy of the environment
   * and objects; the combined completion returns when a side returns, and
   * execution continues with the state of the side(s) that did not return.
   */
  private split(test: Expr, onThen: (scope: Scope) => Completion, onElse: (scope: Scope) => Completion, scope: Scope): Completion {
    if (isLit(test, true)) return onThen(scope);
    if (isLit(test, false)) return onElse(scope);
    const before = snapshotObjects(this.objects);
    const thenEnv = scope.env.fork();
    const left = attempt(scope.block, (block) => onThen({ ...scope, env: thenEnv, block }));
    const leftObjects = snapshotObjects(this.objects);
    restoreObjects(before);
    const elseEnv = scope.env.fork();
    const right = attempt(scope.block, (block) => onElse({ ...scope, env: elseEnv, block }));
    const rightObjects = snapshotObjects(this.objects);
    emitIf(scope.block, test, left.instrs, right.instrs);
    if (!left.outcome.ok && !right.outcome.ok) throw new Diverged();
    if (!left.outcome.ok) {
      restoreObjects(rightObjects);
      scope.env.replaceWith(elseEnv);
      return right.outcome.ok ? right.outcome.value : { kind: 'normal' };
    }
    if (!right.outcome.ok) {
      restoreObjects(leftObjects);
      scope.env.replaceWith(thenEnv);
      return left.outcome.value;
    }
    const a = left.outcome.value;
    const b = right.outcome.value;
    const returns = (completion: Completion): Expr => (completion.kind === 'normal' ? FALSE : completion.kind === 'return' ? TRUE : completion.test);
    const valueOf = (completion: Completion): SV | undefined => (completion.kind === 'normal' ? undefined : completion.value);
    const rtA = returns(a);
    const rtB = returns(b);
    const returnTest = simplifyCond(test, rtA, rtB);
    const va = valueOf(a);
    const vb = valueOf(b);
    const value = va === undefined ? vb : vb === undefined ? va : this.merge(test, va, vb);
    // The continuation only matters on paths that did not return.
    if (isLit(rtA, true)) {
      restoreObjects(rightObjects);
      scope.env.replaceWith(elseEnv);
    } else if (isLit(rtB, true)) {
      restoreObjects(leftObjects);
      scope.env.replaceWith(thenEnv);
    } else {
      this.mergeObjectStates(test, before, leftObjects, rightObjects, scope.block);
      this.mergeEnv(scope.env, test, thenEnv, elseEnv, scope.block);
    }
    if (isLit(returnTest, false)) return { kind: 'normal' };
    if (isLit(returnTest, true)) return { kind: 'return', value: value! };
    return { kind: 'partial', test: this.bindLarge(returnTest, scope), value: value! };
  }

  /** Return conditions are reused by every later statement: LET-bound only when large (small ones stay pure expressions). */
  private bindLarge(test: Expr, scope: Scope): Expr {
    return exprSize(test) > 64 ? scope.block.bind(test, 'returned') : test;
  }

  /** Runs the statements after a conditional return, only on the paths that did not return. */
  private continueAfter(partial: Extract<Completion, { kind: 'partial' }>, nodes: readonly SyntaxNode[], index: number, scope: Scope): Completion {
    const rest = nodes.slice(index + 1);
    if (rest.length === 0) return partial;
    const restRun = attempt(scope.block, (block) => this.statements(rest, 0, { ...scope, block }));
    emitIf(scope.block, partial.test, [], restRun.instrs);
    if (!restRun.outcome.ok) return { kind: 'return', value: partial.value };
    const next = restRun.outcome.value;
    if (next.kind === 'normal') return partial;
    if (next.kind === 'return') return { kind: 'return', value: this.merge(partial.test, partial.value, next.value) };
    return {
      kind: 'partial',
      test: this.bindLarge(or(partial.test, next.test), scope),
      value: this.merge(partial.test, partial.value, next.value),
    };
  }

  private statements(nodes: readonly SyntaxNode[], start: number, scope: Scope): Completion {
    for (let index = start; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      if ((node.type as string) === '__aeris_unroll__') {
        // Next unrolled iteration; variables defined in the body stay local to it.
        const parentEnv = scope.env;
        const outerScope = { ...scope, env: (parentEnv as unknown as { parent?: Env }).parent ?? parentEnv };
        return this.unrollStep((node as unknown as { position: number }).position, outerScope);
      }
      switch (node.type) {
        case 'local_variable_declaration': {
          const declared = this.project.parseType(field(node, 'type')!, scope.owner);
          for (const declarator of named(node).filter((child) => child.type === 'variable_declarator')) {
            const name = field(declarator, 'name')!.text;
            const valueNode = field(declarator, 'value');
            const value = valueNode === undefined ? defaultValue(declared) : this.expr(valueNode, scope);
            scope.env.define(name, retype(value, declared));
          }
          break;
        }
        case 'expression_statement':
          this.expr(named(node)[0]!, scope);
          break;
        case 'return_statement': {
          const valueNode = named(node)[0];
          return { kind: 'return', value: valueNode === undefined ? VOID : this.expr(valueNode, scope) };
        }
        case 'throw_statement': {
          const thrown = this.expr(named(node)[0]!, scope);
          this.throwException(thrown, scope.block, node, scope);
          break;
        }
        case 'if_statement': {
          const completion = this.ifStatement(node, scope);
          if (completion.kind === 'return') return completion;
          if (completion.kind === 'partial') return this.continueAfter(completion, nodes, index, scope);
          break;
        }
        case 'block': {
          const inner = this.statements(statementsOf(node), 0, { ...scope, env: scope.env.child() });
          if (inner.kind === 'return') return inner;
          if (inner.kind === 'partial') return this.continueAfter(inner, nodes, index, scope);
          break;
        }
        case 'switch_expression':
          this.expr(node, scope);
          break;
        case 'try_statement': {
          const completion = this.tryStatement(node, scope);
          if (completion.kind === 'return') return completion;
          if (completion.kind === 'partial') return this.continueAfter(completion, nodes, index, scope);
          break;
        }
        case 'enhanced_for_statement':
          return this.forEach(nodes, index, scope);
        case 'for_statement':
          return this.countedFor(nodes, index, scope);
        case 'assert_statement':
        case 'empty_statement':
        case 'line_comment':
        case 'block_comment':
          break;
        default:
          this.fail(`Statement ${node.type} is not supported`, node, scope);
      }
    }
    return { kind: 'normal' };
  }

  /**
   * for (T x : xs) { ... }:
   * - over a literal list (List.of, varargs): unrolled, any body allowed;
   * - `for (x : xs) if (test) return value;`: first matching element;
   * - otherwise the body must be pure and only update outer variables or
   *   mutable collections: it compiles to a fold.
   */
  private forEach(nodes: readonly SyntaxNode[], index: number, scope: Scope): Completion {
    const node = nodes[index]!;
    const name = field(node, 'name')!.text;
    const declared = this.project.parseType(field(node, 'type')!, scope.owner);
    const iterable = this.asList(this.expr(field(node, 'value')!, scope), node, scope);
    const body = field(node, 'body')!;
    if (/\b(break|continue)\b/.test(body.text)) this.fail('break/continue in loops are not supported', node, scope);
    const bodyStatements = body.type === 'block' ? statementsOf(body) : [body];

    if (iterable.e.k === 'list' && iterable.e.items.length <= 32) {
      // Bounded unrolling, through a continuation statement so returns inside the body keep working.
      this.unrollQueue.push({ items: iterable.e.items, name, declared, iterable, bodyStatements, rest: nodes.slice(index + 1) });
      try {
        return this.unrollStep(0, scope);
      } finally {
        this.unrollQueue.pop();
      }
    }

    // `for (x : xs) if (test(x)) return value(x);`
    if (bodyStatements.length === 1 && bodyStatements[0]!.type === 'if_statement' && field(bodyStatements[0]!, 'alternative') === undefined) {
      const ifNode = bodyStatements[0]!;
      const consequence = field(ifNode, 'consequence')!;
      const inner = consequence.type === 'block' ? statementsOf(consequence) : [consequence];
      if (inner.length === 1 && inner[0]!.type === 'return_statement' && named(inner[0]!)[0] !== undefined) {
        const as = scope.block.fresh('it');
        const env = scope.env.child();
        env.define(name, retype(iterable.element(vr(as)), declared));
        const probe = attempt(scope.block, (block) => asBool(this.expr(field(ifNode, 'condition')!, { ...scope, env, block }), 'loop condition'));
        if (probe.outcome.ok && probe.instrs.length === 0) {
          const matching = scope.block.bind({ k: 'filter', of: iterable.e, as, body: probe.outcome.value }, 'matching');
          const found = op('not', op('isEmpty', matching));
          const completion = this.split(found, (side) => {
            const firstEnv = side.env.child();
            firstEnv.define(name, retype(iterable.element(op('first', matching)), declared));
            return { kind: 'return', value: this.expr(named(inner[0]!)[0]!, { ...side, env: firstEnv }) };
          }, () => ({ kind: 'normal' }), scope);
          if (completion.kind === 'partial') return this.continueAfter(completion, nodes, index, scope);
          return completion.kind === 'return' ? completion : this.statements(nodes, index + 1, scope);
        }
      }
    }

    // A body that only returns (possibly conditionally, e.g. try { return f(x); } catch ...): the first element that returns.
    const match = this.firstReturning(iterable, (env, item) => env.define(name, retype(item, declared)), bodyStatements, scope);
    if (match !== undefined) {
      const matching = scope.block.bind({ k: 'filter', of: iterable.e, as: match.as, body: match.test }, 'matching');
      const found = op('not', op('isEmpty', matching));
      const completion = this.split(found, () => ({
        kind: 'return',
        value: { ...match.value, e: op('first', { k: 'map', of: matching, as: match.as, body: match.value.e }) },
      }), () => ({ kind: 'normal' }), scope);
      if (completion.kind === 'partial') return this.continueAfter(completion, nodes, index, scope);
      return completion.kind === 'return' ? completion : this.statements(nodes, index + 1, scope);
    }

    this.foldLoop(iterable, (env, item) => env.define(name, retype(item, declared)), (inner) => this.statements(bodyStatements, 0, inner), node, scope);
    return this.statements(nodes, index + 1, scope);
  }

  /**
   * A loop body without effects on outer state that returns for some
   * elements: returns, per element, whether it returns and with which value.
   */
  private firstReturning(iterable: ListSV, bind: (env: Env, item: SV) => void, body: readonly SyntaxNode[], scope: Scope): { as: string; test: Expr; value: Extract<SV, { t: 'pure' }> } | undefined {
    const before = snapshotObjects(this.objects);
    const outer = new Map(scope.env.localNames().map((key) => [key, scope.env.get(key)!]));
    const forked = scope.env.fork();
    const env = forked.child();
    const as = scope.block.fresh('it');
    bind(env, iterable.element(vr(as)));
    const run = attempt(scope.block, (block) => this.statements(body, 0, { ...scope, env, block }));
    let changedFields = false;
    for (const [target, fields] of before) {
      for (const [fieldName, value] of target.fields) if (fields.get(fieldName) !== value) changedFields = true;
    }
    restoreObjects(before);
    if (changedFields || [...outer.keys()].some((key) => forked.get(key) !== outer.get(key))) return undefined;
    if (!run.outcome.ok || run.outcome.value.kind === 'normal') return undefined;
    const completion = run.outcome.value;
    if (completion.value.t !== 'pure') return undefined;
    try {
      const [test, value] = foldPureInstrs(run.instrs, [completion.kind === 'return' ? TRUE : completion.test, completion.value.e]);
      return { as, test: test!, value: { ...completion.value, e: value! } };
    } catch (error) {
      if (error instanceof Unsupported) return undefined;
      throw error;
    }
  }

  /**
   * Compiles a side-effect-free loop over a symbolic list into a fold: a dry
   * run discovers which outer variables and object fields the body changes,
   * a second run expresses their next values over the accumulator.
   */
  foldLoop(iterable: ListSV, bind: (env: Env, item: SV) => void, body: (scope: Scope) => Completion | void, node: SyntaxNode, scope: Scope): void {
    const before = snapshotObjects(this.objects);
    const outer = new Map(scope.env.localNames().map((key) => [key, scope.env.get(key)!]));
    const dryEnv = scope.env.fork();
    const dry = dryEnv.child();
    bind(dry, iterable.element(vr('__aeris_probe__')));
    const dryRun = attempt(scope.block, (block) => body({ ...scope, env: dry, block }) ?? { kind: 'normal' as const });
    const changedVars = [...outer.keys()].filter((key) => dryEnv.get(key) !== outer.get(key));
    const changedFields: { target: ObjSV; field: string }[] = [];
    for (const [target, fields] of before) {
      for (const [fieldName, value] of target.fields) if (fields.get(fieldName) !== value) changedFields.push({ target, field: fieldName });
    }
    restoreObjects(before);
    if (!dryRun.outcome.ok || dryRun.outcome.value.kind !== 'normal' || dryRun.instrs.length > 0) {
      this.fail('Loop body has effects or early exits', node, scope);
    }
    if (changedVars.length === 0 && changedFields.length === 0) return;
    const as = scope.block.fresh('it');
    const acc = scope.block.fresh('acc');
    const slots = [
      ...changedVars.map((key) => ({ slot: `v_${key}`, read: () => scope.env.get(key)!, write: (value: SV) => scope.env.assign(key, value) })),
      ...changedFields.map(({ target, field: fieldName }) => ({
        slot: `o${target.id}_${fieldName.replace(/\$/g, '')}`,
        read: () => this.readField(target, fieldName),
        write: (value: SV) => target.fields.set(fieldName, value),
      })),
    ];
    const kinds = new Map(slots.map((slot) => [slot.slot, slot.read()]));
    const init: Expr = { k: 'object', fields: Object.fromEntries(slots.map((slot) => [slot.slot, this.encode(slot.read())])) };
    for (const slot of slots) slot.write(this.reView(kinds.get(slot.slot)!, getf(vr(acc), slot.slot)));
    const env = scope.env.child();
    bind(env, iterable.element(vr(as)));
    const wet = attempt(scope.block, (block) => body({ ...scope, env, block }) ?? { kind: 'normal' as const });
    if (!wet.outcome.ok || wet.outcome.value.kind !== 'normal' || wet.instrs.length > 0) this.fail('Loop body has effects or early exits', node, scope);
    const next: Expr = { k: 'object', fields: Object.fromEntries(slots.map((slot) => [slot.slot, this.encode(slot.read())])) };
    const folded = scope.block.bind({ k: 'fold', of: iterable.e, as, acc, init, body: next }, 'loop');
    for (const slot of slots) slot.write(this.reView(kinds.get(slot.slot)!, getf(folded, slot.slot)));
  }

  /**
   * for (int i = a; i < b; i++) { ... } with `i` never assigned in the body:
   * a loop over range(a, b), compiled like a for-each.
   */
  private countedFor(nodes: readonly SyntaxNode[], index: number, scope: Scope): Completion {
    const node = nodes[index]!;
    const init = field(node, 'init');
    const condition = field(node, 'condition');
    const update = field(node, 'update');
    const body = field(node, 'body');
    const declarator = init?.type === 'local_variable_declaration' ? named(init).find((child) => child.type === 'variable_declarator') : undefined;
    const name = declarator === undefined ? undefined : field(declarator, 'name')?.text;
    const startNode = declarator === undefined ? undefined : field(declarator, 'value');
    if (name === undefined || startNode === undefined || condition?.type !== 'binary_expression' || update === undefined || body === undefined) {
      this.fail('Only counted for loops (for (int i = a; i < b; i++)) are supported', node, scope);
    }
    const operator = field(condition, 'operator')?.type;
    if (field(condition, 'left')?.text !== name || (operator !== '<' && operator !== '<=')) this.fail('Unsupported for-loop condition', node, scope);
    const updateText = update.text.replace(/\s+/g, '');
    const stepMatch = new RegExp(`^${name}\\+=(\\d+)$`).exec(updateText);
    const step = updateText === `${name}++` || updateText === `++${name}` ? 1 : stepMatch !== null ? Number(stepMatch[1]) : undefined;
    if (step === undefined || step < 1) this.fail('Unsupported for-loop update', node, scope);
    if (new RegExp(`\\b${name}\\s*(=[^=]|\\+\\+|--|[+\\-*/]=)`).test(body.text)) this.fail('The loop counter is modified in the body', node, scope);
    const start = this.expr(startNode, scope);
    const bound = this.expr(field(condition, 'right')!, scope);
    if (start.t !== 'pure' || bound.t !== 'pure') this.fail('Non-scalar loop bounds', node, scope);
    const end = operator === '<=' ? op('add', bound.e, lit(1)) : bound.e;
    const range: ListSV = { t: 'list', e: step === 1 ? op('range', start.e, end) : op('range', start.e, end, lit(step)), elem: T.int, element: (item) => pure(item, T.int) };
    const literal = start.e.k === 'lit' && end.k === 'lit' && typeof start.e.v === 'number' && typeof end.v === 'number' && (end.v - start.e.v) / step <= 32;
    const rangeList: ListSV = literal
      ? (() => {
        const first = (start.e as { v: number }).v;
        const items: Expr[] = [];
        for (let value = first; value < (end as { v: number }).v; value += step) items.push(lit(value));
        return { ...range, e: { k: 'list' as const, items } };
      })()
      : range;
    // Reuse the for-each compilation with a synthetic iterable.
    return this.loopOver(nodes, index, scope, name, T.int, rangeList, body);
  }

  /** Shared body of for-each and counted loops. */
  private loopOver(nodes: readonly SyntaxNode[], index: number, scope: Scope, name: string, declared: JType, iterable: ListSV, body: SyntaxNode): Completion {
    if (/\b(break|continue)\b/.test(body.text)) this.fail('break/continue in loops are not supported', nodes[index], scope);
    const bodyStatements = body.type === 'block' ? statementsOf(body) : [body];
    if (iterable.e.k === 'list' && iterable.e.items.length <= 32) {
      this.unrollQueue.push({ items: iterable.e.items, name, declared, iterable, bodyStatements, rest: nodes.slice(index + 1) });
      try {
        return this.unrollStep(0, scope);
      } finally {
        this.unrollQueue.pop();
      }
    }
    this.foldLoop(iterable, (env, item) => env.define(name, retype(item, declared)), (inner) => this.statements(bodyStatements, 0, inner), nodes[index]!, scope);
    return this.statements(nodes, index + 1, scope);
  }

  /** Re-expresses a value of the same shape as `like` over a new expression. */
  reView(like: SV, e: Expr): SV {
    switch (like.t) {
      case 'pure': return pure(e, like.jt);
      case 'list': return { ...like, e };
      case 'obj': return like.cls === MUTABLE_LIST || like.cls === MUTABLE_MAP ? like : obj(like.cls, new Map(), e, like.origin);
      default: throw new Unsupported(`Loop-carried ${describe(like)} is not supported`);
    }
  }

  private unrollQueue: { items: readonly Expr[]; name: string; declared: JType; iterable: ListSV; bodyStatements: SyntaxNode[]; rest: SyntaxNode[] }[] = [];

  /** One unrolled iteration followed by the next (or the code after the loop). */
  private unrollStep(position: number, scope: Scope): Completion {
    const loop = this.unrollQueue.at(-1)!;
    if (position >= loop.items.length) {
      this.unrollQueue.pop();
      try {
        return this.statements(loop.rest, 0, scope);
      } finally {
        this.unrollQueue.push(loop);
      }
    }
    const env = scope.env.child();
    env.define(loop.name, retype(loop.iterable.element(loop.items[position]!), loop.declared));
    const continuation = { type: '__aeris_unroll__', position: position + 1 } as unknown as SyntaxNode;
    return this.statements([...loop.bodyStatements, continuation], 0, { ...scope, env });
  }

  /**
   * try { pure } catch (IllegalArgumentException | RuntimeException ...) { pure }:
   * both sides must be free of effects; assigned variables and returned values
   * become `try` expressions that fall back exactly when Java would catch.
   */
  private tryStatement(node: SyntaxNode, scope: Scope): Completion {
    if (field(node, 'resources') !== undefined || named(node).some((child) => child.type === 'resource_specification')) {
      this.fail('try-with-resources is not supported', node, scope);
    }
    if (named(node).some((child) => child.type === 'finally_clause')) this.fail('finally blocks are not supported', node, scope);
    const tryBlock = field(node, 'body')!;
    const clauses = named(node).filter((child) => child.type === 'catch_clause');
    if (clauses.length !== 1) this.fail('Only a single catch clause is supported', node, scope);
    const clause = clauses[0]!;
    const parameter = named(clause).find((child) => child.type === 'catch_formal_parameter')!;
    const types = named(named(parameter).find((child) => child.type === 'catch_type') ?? parameter)
      .filter((child) => child.type.endsWith('type_identifier') || child.type === 'scoped_type_identifier')
      .map((typeNode) => this.project.parseType(typeNode, scope.owner).name);
    // `catch (E e) { throw e; }` or `{ return Mono.error(e); }`: the same failure either way, the try/catch is transparent.
    const caughtName = (field(parameter, 'name') ?? named(parameter).filter((child) => child.type === 'identifier').at(-1))?.text;
    const handler = field(clause, 'body') ?? named(clause).at(-1)!;
    const handlerStatements = handler.type === 'block' ? statementsOf(handler) : [handler];
    const rethrow = caughtName !== undefined && handlerStatements.length === 1
      && new RegExp(`^(throw\\s+${caughtName}|return\\s+(reactor\\.core\\.publisher\\.)?(Mono|Flux)\\.error\\(\\s*${caughtName}\\s*\\))\\s*;$`).test(handlerStatements[0]!.text.trim());
    if (rethrow) return this.statements(statementsOf(tryBlock), 0, { ...scope, env: scope.env.child() });
    const castOnly = ['java.lang.IllegalArgumentException', 'java.lang.NumberFormatException', 'java.time.format.DateTimeParseException'];
    const catchesAll = types.some((type) => ['java.lang.Exception', 'java.lang.RuntimeException', 'java.lang.Throwable'].includes(type));
    if (!catchesAll && !types.every((type) => castOnly.includes(type))) this.fail(`catch (${types.map((type) => type.slice(type.lastIndexOf('.') + 1)).join(' | ')}) is not modeled`, node, scope);
    const catches = catchesAll ? 'any' as const : 'cast' as const;
    const run = (body: SyntaxNode): { completion: Completion; env: Env } => {
      const env = scope.env.fork();
      const probe = attempt(scope.block, (block) => this.statements(statementsOf(body), 0, { ...scope, env: env.child(), block }));
      if (!probe.outcome.ok || probe.instrs.length > 0) this.fail('try/catch around an operation with effects', node, scope);
      return { completion: probe.outcome.value, env };
    };
    const tried = run(tryBlock);
    const catchBody = field(clause, 'body') ?? named(clause).at(-1)!;
    // Common case: a pure catch completing like the try block -> one `try` expression, no branching.
    const caughtProbe = attempt(scope.block, (block) => {
      const env = scope.env.fork();
      const completion = this.statements(catchBody.type === 'block' ? statementsOf(catchBody) : [catchBody], 0, { ...scope, env: env.child(), block });
      return { completion, env };
    });
    if (caughtProbe.outcome.ok && caughtProbe.instrs.length === 0 && caughtProbe.outcome.value.completion.kind === tried.completion.kind) {
      const caught = caughtProbe.outcome.value;
      const combine = (a: SV, b: SV): SV => {
        if (a === b) return a;
        if (a.t === 'pure' && b.t === 'pure') return pure({ k: 'try', body: a.e, catches, fallback: b.e }, a.jt);
        this.fail('try/catch produces a non-scalar value', node, scope);
      };
      for (const name of scope.env.localNames()) {
        const a = tried.env.get(name);
        const b = caught.env.get(name);
        if (a !== undefined && b !== undefined && a !== b) scope.env.assign(name, combine(a, b));
      }
      if (tried.completion.kind === 'return' && caught.completion.kind === 'return') {
        return { kind: 'return', value: combine(tried.completion.value, caught.completion.value) };
      }
      return { kind: 'normal' };
    }
    // Otherwise the try block's outcome is captured by a sentinel and the control flow splits.
    const SENTINEL: Expr = lit({ $aeris: 'caught' });
    const guarded = (value: SV): PureSV => {
      if (value.t !== 'pure') this.fail('try/catch produces a non-scalar value', node, scope);
      return pure({ k: 'try', body: value.e, catches, fallback: SENTINEL }, value.jt);
    };
    const changed = scope.env.localNames().filter((name) => tried.env.get(name) !== undefined && tried.env.get(name) !== scope.env.get(name));
    const probeValues = [
      ...changed.map((name) => guarded(tried.env.get(name)!)),
      ...(tried.completion.kind === 'return' ? [guarded(tried.completion.value)] : []),
    ];
    if (probeValues.length === 0) {
      // Nothing observable in the try block: only whether it throws matters, which a pure block cannot.
      return { kind: 'normal' };
    }
    // With several assignments, Java keeps those made before the exception: not modeled.
    if (probeValues.length > 1) this.fail('try block with several observable results', node, scope);
    const bound = probeValues.map((value) => pure(scope.block.bind(value.e, 'tried'), value.jt));
    const caughtTest = op('eq', bound[0]!.e, SENTINEL);
    return this.split(caughtTest, (side) =>
      // Exception caught: the catch block decides.
      this.statements(catchBody.type === 'block' ? statementsOf(catchBody) : [catchBody], 0, { ...side, env: side.env.child() }),
    (side) => {
      changed.forEach((name, position) => side.env.assign(name, bound[position]!));
      return tried.completion.kind === 'return' ? { kind: 'return', value: bound.at(-1)! } : { kind: 'normal' };
    }, scope);
  }

  throwException(thrown: SV, block: Block, node: SyntaxNode, scope: Scope): never {
    if (thrown.t !== 'exception') this.fail(`Thrown value is not a modeled exception (${describe(thrown)})`, node, scope);
    block.emit({ op: 'ASSERT', test: FALSE, error: this.errors.map(thrown) });
    throw new Diverged();
  }

  /** if/else: both branches split the control flow; the caller continues after it. */
  private ifStatement(node: SyntaxNode, scope: Scope): Completion {
    const test = asBool(this.expr(field(node, 'condition')!, scope), 'if condition');
    const consequence = field(node, 'consequence')!;
    const alternative = field(node, 'alternative');
    const runSide = (stmt: SyntaxNode | undefined, sideScope: Scope): Completion => {
      if (stmt === undefined) return { kind: 'normal' };
      return this.statements(stmt.type === 'block' ? statementsOf(stmt) : [stmt], 0, { ...sideScope, env: sideScope.env.child() });
    };
    return this.split(test, (side) => runSide(consequence, side), (side) => runSide(alternative, side), scope);
  }

  private mergeEnv(env: Env, test: Expr, left: Env, right: Env, block?: Block): void {
    for (const name of env.localNames()) {
      const a = left.get(name);
      const b = right.get(name);
      if (a === undefined || b === undefined) continue;
      if (a !== b) env.assign(name, this.compact(this.merge(test, a, b), block));
    }
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  expr(node: SyntaxNode, scope: Scope): SV {
    switch (node.type) {
      case 'parenthesized_expression':
        return this.expr(named(node)[0]!, scope);
      case 'true':
        return pure(TRUE, T.boolean);
      case 'false':
        return pure(FALSE, T.boolean);
      case 'null_literal':
        return pure(NULL, T.object);
      case 'string_literal':
        return pure(lit(stringValue(node) ?? ''), T.string);
      case 'character_literal':
        return pure(lit(node.text.slice(1, -1)), T.string);
      case 'decimal_integer_literal':
      case 'hex_integer_literal':
      case 'octal_integer_literal':
      case 'binary_integer_literal': {
        const text = node.text.replace(/_/g, '');
        const isLong = /[lL]$/.test(text);
        const value = Number(text.replace(/[lL]$/, ''));
        if (!Number.isSafeInteger(value)) this.fail('Integer literal outside the safe range', node, scope);
        return pure(lit(value), isLong ? T.long : T.int);
      }
      case 'decimal_floating_point_literal':
        return pure(lit(Number(node.text.replace(/_/g, '').replace(/[dDfF]$/, ''))), { name: 'double', args: [], array: 0 });
      case 'identifier':
        return this.name(node.text, node, scope);
      case 'this':
        if (scope.self === undefined) this.fail('`this` outside an instance context', node, scope);
        return scope.self;
      case 'field_access':
        return this.fieldAccess(node, scope);
      case 'method_invocation':
        return this.invocation(node, scope);
      case 'object_creation_expression':
        return this.creation(node, scope);
      case 'binary_expression':
        return this.binary(node, scope);
      case 'unary_expression':
        return this.unary(node, scope);
      case 'ternary_expression': {
        const test = asBool(this.expr(field(node, 'condition')!, scope), 'ternary condition');
        return branch(
          scope.block,
          test,
          (block) => this.expr(field(node, 'consequence')!, { ...scope, block }),
          (block) => this.expr(field(node, 'alternative')!, { ...scope, block }),
          (t, a, b) => this.merge(t, a, b),
        );
      }
      case 'cast_expression': {
        const value = this.expr(field(node, 'value')!, scope);
        return retype(value, this.project.parseType(field(node, 'type')!, scope.owner));
      }
      case 'lambda_expression': {
        const params = field(node, 'parameters');
        const names = params === undefined ? [] : params.type === 'identifier'
          ? [params.text]
          : named(params).map((param) => (param.type === 'identifier' ? param.text : field(param, 'name')?.text ?? param.text));
        return { t: 'lambda', params: names, body: field(node, 'body')!, env: scope.env, self: scope.self, owner: scope.owner };
      }
      case 'method_reference':
        return this.methodReference(node, scope);
      case 'assignment_expression':
        return this.assignment(node, scope);
      case 'array_access': {
        const array = this.expr(field(node, 'array')!, scope);
        const index = this.expr(field(node, 'index')!, scope);
        if (array.t === 'tuple' && index.t === 'pure' && index.e.k === 'lit' && typeof index.e.v === 'number') {
          const item = array.items[index.e.v];
          if (item !== undefined) return item;
        }
        if (array.t === 'list' && index.t === 'pure') return array.element(op('at', array.e, index.e, lit('array')));
        if (array.t === 'pure' && array.jt.array > 0 && index.t === 'pure') {
          return this.view(op('at', array.e, index.e, lit('array')), { ...array.jt, array: array.jt.array - 1 });
        }
        this.fail('Array access is not supported', node, scope);
      }
      case 'array_creation_expression': {
        const initializer = named(node).find((child) => child.type === 'array_initializer');
        if (initializer === undefined) this.fail('Arrays without initializer are not supported', node, scope);
        const elementType = this.project.parseType(field(node, 'type')!, scope.owner);
        const items = named(initializer).map((item) => this.expr(item, scope));
        return { t: 'list', e: { k: 'list', items: items.map((item) => this.encode(item)) }, elem: elementType, element: (item) => this.view(item, elementType) };
      }
      case 'switch_expression':
        return this.switchExpression(node, scope);
      case 'instanceof_expression':
        return this.instanceOf(node, scope);
      case 'class_literal': {
        const typeNode = named(node)[0]!;
        return { t: 'type', fqn: this.project.parseType(typeNode, scope.owner).name };
      }
      default:
        this.fail(`Expression ${node.type} is not supported`, node, scope);
    }
  }

  /** `x instanceof T [binding]`, decided statically from the symbolic value's class. */
  private instanceOf(node: SyntaxNode, scope: Scope): SV {
    const value = this.expr(field(node, 'left')!, scope);
    const typeNode = field(node, 'right') ?? named(node).find((child) => child.type.endsWith('type') || child.type === 'type_identifier');
    if (typeNode === undefined) this.fail('instanceof without a type', node, scope);
    const target = this.project.parseType(typeNode, scope.owner).name;
    const binding = field(node, 'name') ?? named(node).find((child, index) => index > 1 && child.type === 'identifier');
    let cls: string | undefined;
    if (value.t === 'obj') cls = value.cls;
    else if (value.t === 'pure' && value.jt.name !== 'java.lang.Object' && !value.jt.unresolved) cls = value.jt.name;
    if (cls === undefined) this.fail(`instanceof on ${describe(value)}`, node, scope);
    const decl = this.project.type(cls);
    const assignable = cls === target || (decl !== undefined && this.project.supertypeNames(decl).has(target));
    if (!assignable && decl === undefined) this.fail(`instanceof on library type ${cls}`, node, scope);
    if (assignable && binding !== undefined) scope.env.define(binding.text, value);
    const nullable = value.t === 'pure' ? value.e : value.t === 'obj' && value.base !== undefined && value.fields.size === 0 ? value.base : undefined;
    return pure(assignable ? (nullable === undefined ? TRUE : op('notNull', nullable)) : FALSE, T.boolean);
  }

  /** Arrow-form switch over constants (enums, strings, integers). */
  private switchExpression(node: SyntaxNode, scope: Scope): SV {
    const subject = this.expr(field(node, 'condition')!, scope);
    if (subject.t !== 'pure') this.fail('switch over a non-scalar value', node, scope);
    const body = field(node, 'body')!;
    const rules = named(body).filter((child) => child.type === 'switch_rule');
    if (rules.length === 0) this.fail('Only arrow-form switch is supported', node, scope);
    const enumType = this.project.type(subject.jt.name);
    const cases: { test: Expr; run: (block: Block) => SV }[] = [];
    let fallback: ((block: Block) => SV) | undefined;
    for (const rule of rules) {
      const label = named(rule).find((child) => child.type === 'switch_label')!;
      const target = named(rule).filter((child) => child.type !== 'switch_label')[0]!;
      const run = (block: Block): SV => {
        const inner: Scope = { ...scope, block, env: scope.env.child() };
        if (target.type === 'expression_statement') return this.expr(named(target)[0]!, inner);
        if (target.type === 'throw_statement') {
          this.throwException(this.expr(named(target)[0]!, inner), block, target, inner);
        }
        if (target.type === 'block') {
          const yielded = statementsOf(target).find((statement) => statement.type === 'yield_statement');
          if (yielded === undefined) {
            this.statements(statementsOf(target), 0, inner);
            return VOID;
          }
          this.statements(statementsOf(target).filter((statement) => statement !== yielded), 0, inner);
          return this.expr(named(yielded)[0]!, inner);
        }
        return this.expr(target, inner);
      };
      const values = named(label).filter((child) => !child.type.endsWith('comment'));
      if (label.text.trim().startsWith('default') || values.length === 0) {
        fallback = run;
        continue;
      }
      const tests = values.map((valueNode) => {
        if (enumType?.kind === 'enum' && valueNode.type === 'identifier') return op('eq', subject.e, lit(valueNode.text));
        const constant = this.expr(valueNode, scope);
        if (constant.t !== 'pure' || constant.e.k !== 'lit') this.fail('switch label is not a constant', valueNode, scope);
        return op('eq', subject.e, constant.e);
      });
      cases.push({ test: tests.length === 1 ? tests[0]! : or(...tests), run });
    }
    const otherwise = fallback ?? ((block: Block): SV => {
      // A switch expression over an enum without default throws on unknown values (null -> NPE).
      block.emit({ op: 'ASSERT', test: FALSE, error: { status: 500, code: 'MATCH_EXCEPTION', message: lit('No switch case matched') } });
      throw new Diverged();
    });
    const chain = (index: number, block: Block): SV => {
      if (index >= cases.length) return otherwise(block);
      const current = cases[index]!;
      return branch(block, current.test, (child) => current.run(child), (child) => chain(index + 1, child), (t, a, b) => this.merge(t, a, b));
    };
    return chain(0, scope.block);
  }

  private name(name: string, node: SyntaxNode, scope: Scope): SV {
    const local = scope.env.get(name);
    if (local !== undefined) return local;
    if (scope.self !== undefined) {
      const member = this.member(scope.self, name, scope, node);
      if (member !== undefined) return member;
    }
    for (let type: TypeDecl | undefined = scope.owner; type !== undefined; type = type.outer) {
      const constant = this.staticMember(type, name, node);
      if (constant !== undefined) return constant;
    }
    const imported = scope.owner.imports.staticSingle.get(name);
    if (imported !== undefined) {
      const owner = this.project.type(imported.slice(0, imported.lastIndexOf('.')));
      if (owner !== undefined) {
        const constant = this.staticMember(owner, name, node);
        if (constant !== undefined) return constant;
      }
      const external = libraryStaticField(imported.slice(0, imported.lastIndexOf('.')), name);
      if (external !== undefined) return external;
    }
    if (name === 'log' && scope.owner.annotations.some((annotation) => ['Slf4j', 'Log4j2', 'Log', 'CommonsLog', 'XSlf4j'].includes(annotation.name))) {
      return { t: 'logger' };
    }
    const typeFqn = this.project.resolveTypeName(name, scope.owner) ?? knownType(name);
    if (typeFqn !== undefined) return { t: 'type', fqn: typeFqn };
    this.fail(`Unknown name ${name}`, node, scope);
  }

  /** Instance member of `self` by simple name (field), or undefined. */
  private member(self: SV, name: string, scope: Scope, node: SyntaxNode): SV | undefined {
    if (self.t === 'obj') {
      return this.propertyType(self.cls, name) === undefined ? undefined : this.readField(self, name);
    }
    if (self.t === 'bean') {
      const decl = this.project.instanceFields(self.cls).find((candidate) => candidate.name === name);
      return decl === undefined ? undefined : this.injected(decl, scope, node);
    }
    return undefined;
  }

  /** Resolves an injected dependency of a bean field. */
  injected(decl: FieldDecl, scope: Scope, node: SyntaxNode): SV {
    if (decl.initializer !== undefined && !decl.modifiers.has('static')) {
      const jt = decl.type;
      const special = this.injectedSpecial(jt);
      if (special !== undefined) return special;
      this.fail(`Bean field ${decl.owner.simple}.${decl.name} holds state`, node, scope);
    }
    return this.injectedType(decl.type, decl.annotations, `${decl.owner.simple}.${decl.name}`, scope, node);
  }

  private injectedSpecial(jt: JType): SV | undefined {
    if (this.config.externalEffects.some((prefix) => jt.name.startsWith(prefix))) return { t: 'external', cls: jt.name };
    if (jt.name === 'org.slf4j.Logger' || typeName(jt) === 'Logger') return { t: 'logger' };
    if (jt.name.endsWith('TransactionalOperator')) return { t: 'txop' };
    if (jt.name.endsWith('R2dbcEntityTemplate')) return { t: 'template' };
    if (typeName(jt) === 'ReactiveTransactionManager' || typeName(jt) === 'PlatformTransactionManager') return { t: 'opaque', what: typeName(jt) };
    return undefined;
  }

  /** The bean Spring injects for a declared type (repository, component, @Bean product). */
  injectedType(jt: JType, annotations: readonly { name: string; args: Map<string, SyntaxNode> }[], label: string, scope: Scope, node: SyntaxNode): SV {
    const repo = this.persistence.repository(jt.name);
    if (repo !== undefined) return { t: 'repo', repo: repo.fqn };
    const problem = this.persistence.problems.get(jt.name);
    if (problem !== undefined) this.fail(`Repository ${typeName(jt)}: ${problem}`, node, scope);
    const special = this.injectedSpecial(jt);
    if (special !== undefined) return special;
    const target = this.project.type(jt.name);
    if (target === undefined) this.fail(`Dependency ${label} of type ${jt.name} is outside the analyzed sources`, node, scope);
    if (target.kind === 'class' && !target.modifiers.has('abstract') && this.isActiveBean(target)) return { t: 'bean', cls: target };
    const candidates = this.project.implementations(target.fqn).filter((impl) => this.isActiveBean(impl));
    if (candidates.length === 1) return { t: 'bean', cls: candidates[0]! };
    const primary = candidates.filter((impl) => impl.annotations.some((annotation) => annotation.name === 'Primary'));
    if (primary.length === 1) return { t: 'bean', cls: primary[0]! };
    const qualifier = annotations.find((annotation) => annotation.name === 'Qualifier');
    const wanted = qualifier === undefined ? undefined : stringValue(qualifier.args.get('value')!);
    if (wanted !== undefined) {
      const named2 = candidates.filter((impl) => beanName(impl) === wanted);
      if (named2.length === 1) return { t: 'bean', cls: named2[0]! };
    }
    if (candidates.length === 0) {
      const produced = this.beanFactory(target, scope, node);
      if (produced !== undefined) return produced;
      if (target.kind === 'class' && !target.modifiers.has('abstract')) return { t: 'bean', cls: target };
    }
    this.fail(`Dependency ${target.simple} has ${candidates.length} active implementations`, node, scope);
  }

  private beanProducts = new Map<MethodDecl, SV>();

  /** A @Bean method of an active @Configuration class producing `target`. */
  private beanFactory(target: TypeDecl, scope: Scope, node: SyntaxNode): SV | undefined {
    const factories: MethodDecl[] = [];
    for (const type of this.project.types.values()) {
      if (!type.annotations.some((annotation) => annotation.name === 'Configuration' || annotation.name === 'Component') || !this.project.profileActive(type)) continue;
      for (const method of type.methods) {
        if (!method.annotations.some((annotation) => annotation.name === 'Bean')) continue;
        if (method.returnType.name !== target.fqn) continue;
        const profile = method.annotations.find((annotation) => annotation.name === 'Profile');
        if (profile !== undefined && !this.project.profileActive({ ...type, annotations: [profile] })) continue;
        factories.push(method);
      }
    }
    if (factories.length !== 1) return undefined;
    const factory = factories[0]!;
    const cached = this.beanProducts.get(factory);
    if (cached !== undefined) return cached;
    const args = factory.params.map((param) => this.injectedType(param.type, param.annotations, `${factory.owner.simple}.${factory.name}(${param.name})`, scope, node));
    const product = this.inline(factory, { t: 'bean', cls: factory.owner }, args, node, { ...scope, block: new Block(this.counters) });
    this.beanProducts.set(factory, product);
    return product;
  }

  private isActiveBean(type: TypeDecl): boolean {
    return type.annotations.some((annotation) => BEAN_ANNOTATIONS.has(annotation.name)) && this.project.profileActive(type);
  }

  /** Static constant, enum constant or static field of a project type. */
  staticMember(type: TypeDecl, name: string, node: SyntaxNode): SV | undefined {
    if (type.kind === 'enum' && type.enumConstants.includes(name)) return pure(lit(name), { name: type.fqn, args: [], array: 0 });
    const decl = this.project.staticField(type, name);
    if (decl === undefined) return undefined;
    const cached = this.constants.get(decl);
    if (cached !== undefined) return cached;
    if (!decl.modifiers.has('final') || decl.initializer === undefined) {
      throw new Unsupported(`Static field ${type.simple}.${name} is mutable state.`, node);
    }
    const value = this.expr(decl.initializer, { env: new Env(), self: undefined, owner: decl.owner, block: new Block(this.counters) });
    const literalList = value.t === 'list' && value.e.k === 'list' && value.e.items.every((item) => item.k === 'lit');
    const constant = (value.t === 'pure' && value.e.k === 'lit') || value.t === 'logger' || value.t === 'comparator' || value.t === 'type' || literalList;
    if (!constant) throw new Unsupported(`Static field ${type.simple}.${name} is not a constant.`, node);
    this.constants.set(decl, value);
    return value;
  }

  private fieldAccess(node: SyntaxNode, scope: Scope): SV {
    const objectNode = field(node, 'object')!;
    const name = field(node, 'field')!.text;
    if (objectNode.type === 'this') {
      if (scope.self === undefined) this.fail('`this` outside an instance context', node, scope);
      const member = this.member(scope.self, name, scope, node);
      if (member === undefined) this.fail(`Unknown member this.${name}`, node, scope);
      return member;
    }
    const target = this.receiver(objectNode, scope);
    if (target.t === 'type') {
      const decl = this.project.type(target.fqn);
      const constant = decl === undefined ? libraryStaticField(target.fqn, name) : this.staticMember(decl, name, node);
      if (constant !== undefined) return constant;
      const nested = this.project.type(`${target.fqn}.${name}`);
      if (nested !== undefined) return { t: 'type', fqn: nested.fqn };
      this.fail(`Unknown static member ${target.fqn}.${name}`, node, scope);
    }
    if (target.t === 'obj') return this.readField(target, name);
    // array.length (arrays are lists; a null array dereference fails like Java).
    if (name === 'length' && (target.t === 'list' || (target.t === 'pure' && target.jt.array > 0))) return pure(op('size', target.e), T.int);
    if (target.t === 'pure') {
      const decl = this.project.type(target.jt.name);
      if (decl?.kind === 'enum') {
        // A field of an enum value: select the constant's field by name.
        let result: SV | undefined;
        for (const constant of [...decl.enumConstants].reverse()) {
          const value = this.readField(this.enumConstant(decl, constant, node, scope), name);
          result = result === undefined ? value : this.merge(op('eq', target.e, lit(constant)), value, result);
        }
        if (result !== undefined) return result;
      }
    }
    this.fail(`Field access on ${describe(target)}`, node, scope);
  }

  /** Evaluates a receiver expression, which may also be a (qualified) type name. */
  receiver(node: SyntaxNode, scope: Scope): SV {
    if (node.type === 'identifier' || node.type === 'field_access' || node.type === 'scoped_identifier') {
      if (node.type === 'identifier' && scope.env.has(node.text)) return scope.env.get(node.text)!;
      const qualified = node.text.replace(/\s+/g, '');
      const instanceAccess = /^(this|super)\./.test(qualified);
      if (!instanceAccess && (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(qualified) || node.type === 'identifier')) {
        const asType = this.project.type(qualified) ?? (node.type === 'identifier' ? undefined : this.project.type(this.project.resolveTypeName(qualified, scope.owner) ?? ''));
        if (asType !== undefined && !(node.type === 'identifier' && (scope.self !== undefined && this.member(scope.self, node.text, scope, node) !== undefined))) {
          return { t: 'type', fqn: asType.fqn };
        }
        if (node.type !== 'identifier' && /^[a-z]/.test(qualified) && !scope.env.has(qualified.split('.')[0]!)) {
          return { t: 'type', fqn: qualified };
        }
      }
    }
    return this.expr(node, scope);
  }

  private assignment(node: SyntaxNode, scope: Scope): SV {
    const left = field(node, 'left')!;
    const operator = node.children.find((child) => child !== null && /^[+\-*/%&|^]?=$|^<<=$|^>>>?=$/.test(child.type))?.type ?? '=';
    let value = this.expr(field(node, 'right')!, scope);
    if (operator !== '=') {
      const current = this.expr(left, scope);
      value = this.arithmetic(operator.slice(0, -1), current, value, node, scope);
    }
    if (left.type === 'identifier') {
      if (scope.env.assign(left.text, value)) return value;
      if (scope.self?.t === 'obj' && this.propertyType(scope.self.cls, left.text) !== undefined) {
        this.writeField(scope.self, left.text, value);
        return value;
      }
      this.fail(`Assignment to ${left.text} is not supported`, node, scope);
    }
    if (left.type === 'field_access') {
      const target = field(left, 'object')!.type === 'this' ? scope.self : this.expr(field(left, 'object')!, scope);
      if (target?.t === 'obj') {
        this.writeField(target, field(left, 'field')!.text, value);
        return value;
      }
    }
    this.fail('Assignment target is not supported', node, scope);
  }

  private unary(node: SyntaxNode, scope: Scope): SV {
    const operator = field(node, 'operator')?.text ?? node.children[0]?.type;
    const operand = this.expr(field(node, 'operand')!, scope);
    if (operand.t !== 'pure') this.fail(`Unary ${operator} on ${describe(operand)}`, node, scope);
    switch (operator) {
      case '!':
        return pure(not(operand.e), T.boolean);
      case '-':
        return pure(isLit(operand.e) && typeof (operand.e as { v: unknown }).v === 'number' ? lit(-((operand.e as { v: number }).v)) : op('neg', operand.e), operand.jt);
      case '+':
        return operand;
      default:
        this.fail(`Unary operator ${operator} is not supported`, node, scope);
    }
  }

  private binary(node: SyntaxNode, scope: Scope): SV {
    const operator = field(node, 'operator')!.type;
    if (operator === '&&' || operator === '||') {
      const left = asBool(this.expr(field(node, 'left')!, scope), 'boolean operand');
      // Java evaluates the right operand lazily; keep side effects under the guard.
      const probe = attempt(scope.block, (block) => this.expr(field(node, 'right')!, { ...scope, block }));
      if (probe.outcome.ok && probe.instrs.length === 0) {
        const right = asBool(probe.outcome.value, 'boolean operand');
        return pure(operator === '&&' ? and(left, right) : or(left, right), T.boolean);
      }
      const guard = operator === '&&' ? left : not(left);
      const right = branch(scope.block, guard, (block) => this.expr(field(node, 'right')!, { ...scope, block }), () => pure(operator === '&&' ? FALSE : TRUE, T.boolean), (t, a, b) => this.merge(t, a, b));
      return pure(operator === '&&' ? and(left, asBool(right, 'operand')) : or(left, asBool(right, 'operand')), T.boolean);
    }
    const left = this.expr(field(node, 'left')!, scope);
    const right = this.expr(field(node, 'right')!, scope);
    if (operator === '==' || operator === '!=') {
      const equal = this.identity(left, right, node, scope);
      return pure(operator === '==' ? equal : not(equal), T.boolean);
    }
    if (operator === '&' || operator === '|') {
      if (left.t === 'pure' && right.t === 'pure' && isBooleanType(left.jt) && isBooleanType(right.jt)) {
        return pure(operator === '&' ? and(left.e, right.e) : or(left.e, right.e), T.boolean);
      }
      this.fail('Bitwise operators are not supported', node, scope);
    }
    if (['<', '<=', '>', '>='].includes(operator)) {
      if (left.t !== 'pure' || right.t !== 'pure') this.fail('Comparison of non-scalar values', node, scope);
      const name = ({ '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' } as const)[operator as '<'];
      return pure(op(name, left.e, right.e), T.boolean);
    }
    return this.arithmetic(operator, left, right, node, scope);
  }

  /** `==` semantics: null checks, enums, primitives; reference identity on objects is refused. */
  private identity(left: SV, right: SV, node: SyntaxNode, scope: Scope): Expr {
    const isNullLit = (sv: SV) => sv.t === 'pure' && isLit(sv.e, null);
    if (isNullLit(right)) return nullCheck(left, this);
    if (isNullLit(left)) return nullCheck(right, this);
    // Enum constants are singletons: == compares names.
    const enumName = (sv: SV): Expr | undefined => (sv.t === 'obj' && sv.fields.has('$name') ? (sv.fields.get('$name') as { e: Expr }).e
      : sv.t === 'pure' && this.project.type(sv.jt.name)?.kind === 'enum' ? sv.e : undefined);
    const leftEnum = enumName(left);
    const rightEnum = enumName(right);
    if (leftEnum !== undefined && rightEnum !== undefined) return op('eq', leftEnum, rightEnum);
    if (left.t === 'pure' && right.t === 'pure') {
      const comparable = (jt: JType) => isNumericOrBoolean(jt) || this.project.type(jt.name)?.kind === 'enum' || jt.name === 'java.lang.Object';
      if (comparable(left.jt) && comparable(right.jt)) return op('eq', left.e, right.e);
    }
    this.fail('Reference comparison (==) between objects is not modeled', node, scope);
  }

  private arithmetic(operator: string, leftIn: SV, rightIn: SV, node: SyntaxNode, scope: Scope): SV {
    // String concatenation renders collections like AbstractCollection.toString().
    const asText = (sv: SV): SV => (sv.t === 'list' ? pure(sv.e, T.list(T.object)) : sv.t === 'obj' && (sv.cls === MUTABLE_LIST || sv.cls === MUTABLE_SET) ? pure(this.asList(sv, node, scope).e, T.list(T.object)) : sv);
    const left = operator === '+' ? asText(leftIn) : leftIn;
    const right = operator === '+' ? asText(rightIn) : rightIn;
    if (left.t !== 'pure' || right.t !== 'pure') this.fail(`Operator ${operator} on non-scalar values`, node, scope);
    if (operator === '+' && (isListType(left.jt) || isListType(right.jt)) && !(left.jt.name === 'java.lang.String' || right.jt.name === 'java.lang.String')) {
      this.fail('Operator + on a collection', node, scope);
    }
    if (operator === '+' && (left.jt.name === 'java.lang.String' || right.jt.name === 'java.lang.String')) {
      return pure(op('concat', left.e, right.e), T.string);
    }
    const integral = isIntegral(left.jt) && isIntegral(right.jt);
    const resultType = integral ? (left.jt.name === 'long' || right.jt.name === 'long' || left.jt.name === 'java.lang.Long' ? T.long : T.int) : { name: 'double', args: [], array: 0 };
    switch (operator) {
      case '+': return pure(op('add', left.e, right.e), resultType);
      case '-': return pure(op('sub', left.e, right.e), resultType);
      case '*': return pure(op('mul', left.e, right.e), resultType);
      case '/':
        if (!integral) this.fail('Floating-point division is not modeled exactly', node, scope);
        return pure(op('div', left.e, right.e), resultType);
      case '%':
        if (!integral) this.fail('Floating-point remainder is not modeled', node, scope);
        return pure(op('mod', left.e, right.e), resultType);
      default:
        this.fail(`Operator ${operator} is not supported`, node, scope);
    }
  }

  private methodReference(node: SyntaxNode, scope: Scope): SV {
    const parts = node.children.filter((child): child is SyntaxNode => child !== null);
    const separator = parts.findIndex((child) => child.type === '::');
    const target = parts.slice(0, separator).find((child) => child.isNamed)!;
    const nameNode = parts.slice(separator + 1).find((child) => child.type === 'identifier' || child.type === 'new');
    const name = nameNode?.type === 'new' ? '<init>' : nameNode?.text ?? this.fail('Malformed method reference', node, scope);
    if (target.type === 'this') return { t: 'mref', receiver: scope.self, name, owner: scope.owner };
    if (target.type === 'super') this.fail('super:: references are not supported', node, scope);
    const receiver = target.type === 'type_identifier' || target.type === 'scoped_type_identifier' || target.type === 'generic_type'
      ? ({ t: 'type', fqn: this.project.parseType(target, scope.owner).name } as SV)
      : this.receiver(target, scope);
    if (receiver.t === 'type') return { t: 'mref', type: receiver.fqn, name, owner: scope.owner };
    return { t: 'mref', receiver, name, owner: scope.owner };
  }

  private enumInstances = new Map<string, ObjSV>();

  /** An enum constant as an object, its fields set by the enum constructor. */
  private enumConstant(decl: TypeDecl, constant: string, node: SyntaxNode, scope: Scope): ObjSV {
    const key = `${decl.fqn}.${constant}`;
    const cached = this.enumInstances.get(key);
    if (cached !== undefined) return cached;
    const body = field(decl.node, 'body');
    const constantNode = named(body).find((child) => child.type === 'enum_constant' && field(child, 'name')?.text === constant);
    if (constantNode === undefined) this.fail(`Enum constant ${key} not found`, node, scope);
    if (named(constantNode).some((child) => child.type === 'class_body')) this.fail(`Enum constant ${key} has a body`, node, scope);
    const args = named(field(constantNode, 'arguments')).map((arg) => this.expr(arg, { env: new Env(), self: undefined, owner: decl, block: scope.block }));
    const instance = obj(decl.fqn, new Map([['$name', pure(lit(constant), T.string) as SV]]));
    for (const decl2 of this.project.instanceFields(decl)) {
      if (decl2.initializer !== undefined) instance.fields.set(decl2.name, this.expr(decl2.initializer, { env: new Env(), self: instance, owner: decl, block: scope.block }));
    }
    const ctor = decl.constructors.find((candidate) => candidate.params.length === args.length);
    if (ctor?.body !== undefined) {
      const env = new Env();
      ctor.params.forEach((param, index) => env.define(param.name, retype(args[index]!, param.type)));
      this.statements(statementsOf(ctor.body), 0, { env, self: instance, owner: decl, block: scope.block });
    } else if (args.length > 0) {
      this.fail(`Enum ${decl.simple} constructor not found`, node, scope);
    }
    this.enumInstances.set(key, instance);
    return instance;
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private invocation(node: SyntaxNode, scope: Scope): SV {
    const name = field(node, 'name')!.text;
    const objectNode = field(node, 'object');
    const args = named(field(node, 'arguments')).filter((arg) => !arg.type.endsWith('comment')).map((arg) => this.expr(arg, scope));
    if (objectNode === undefined) {
      if (scope.self !== undefined && scope.self.t !== 'type') {
        const selfType = this.typeOfSelf(scope.self);
        if (selfType !== undefined && this.project.methodsOf(selfType, name).some((method) => method.params.length === args.length || method.varargs)) {
          return this.call(scope.self, name, args, node, scope);
        }
      }
      for (let type: TypeDecl | undefined = scope.owner; type !== undefined; type = type.outer) {
        const statics = this.project.methodsOf(type, name).filter((method) => method.modifiers.has('static'));
        if (statics.length > 0) return this.call({ t: 'type', fqn: type.fqn }, name, args, node, scope);
        if (type.kind === 'enum' && ((name === 'valueOf' && args.length === 1) || (name === 'values' && args.length === 0))) {
          return this.call({ t: 'type', fqn: type.fqn }, name, args, node, scope);
        }
      }
      const imported = scope.owner.imports.staticSingle.get(name);
      if (imported !== undefined) return this.call({ t: 'type', fqn: imported.slice(0, imported.lastIndexOf('.')) }, name, args, node, scope);
      this.fail(`Unresolved call ${name}()`, node, scope);
    }
    if (objectNode.type === 'super') this.fail('super calls are not supported', node, scope);
    const receiver = this.receiver(objectNode, scope);
    return this.call(receiver, name, args, node, scope);
  }

  private typeOfSelf(self: SV): TypeDecl | undefined {
    if (self.t === 'bean') return self.cls;
    if (self.t === 'obj') return this.project.type(self.cls);
    return undefined;
  }

  /** Dispatch on the receiver's symbolic kind; failures carry the call site. */
  call(receiver: SV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    try {
      return this.dispatch(receiver, name, args, node, scope);
    } catch (error) {
      if (error instanceof Unsupported && !/\([^()]*:\d+\)$/.test(error.reason)) {
        const located = new (error.external ? ExternalEffect : Unsupported)(`${error.reason} (${scope.owner.file.path}:${node.startPosition.row + 1})`, node);
        throw located;
      }
      throw error;
    }
  }

  private dispatch(receiver: SV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    switch (receiver.t) {
      case 'type':
        return this.staticCall(receiver.fqn, name, args, node, scope);
      case 'bean': {
        const method = this.resolve(receiver.cls, name, args, node, scope);
        return this.inline(method, method.modifiers.has('static') ? undefined : receiver, args, node, scope);
      }
      case 'repo':
        return this.repositoryCall(this.persistence.repository(receiver.repo)!, name, args, node, scope);
      case 'obj':
        return this.objectCall(receiver, name, args, node, scope);
      case 'builder':
        return this.builderCall(receiver, name, args, node, scope);
      case 'pure': {
        if (isListType(receiver.jt) && receiver.jt.array === 0) return this.dispatch(this.asList(receiver, node, scope), name, args, node, scope);
        const decl = this.project.type(receiver.jt.name);
        if (decl !== undefined && (decl.kind === 'class' || decl.kind === 'record')) {
          return this.objectCall(obj(decl.fqn, new Map(), receiver.e), name, args, node, scope);
        }
        if (decl?.kind === 'enum') return this.enumCall(receiver, decl, name, args, node, scope);
        return libraryInstance(this, receiver, name, args, node, scope);
      }
      case 'mono':
      case 'flux':
        return reactiveCall(this, receiver, name, args, node, scope);
      case 'optional':
      case 'list':
      case 'response':
      case 'tuple':
      case 'exception':
      case 'comparator':
        return libraryInstance(this, receiver, name, args, node, scope);
      case 'lambda':
      case 'mref':
        if (['apply', 'get', 'test', 'accept', 'call', 'run'].includes(name)) return this.apply(receiver, args, scope.block, node, scope);
        this.fail(`Functional interface method ${name}`, node, scope);
      case 'logger':
        return VOID;
      case 'txop':
        if (name === 'transactional' && args.length === 1) return args[0]!;
        this.fail(`TransactionalOperator.${name}`, node, scope);
      case 'external':
        throw new ExternalEffect(`Calls ${typeName({ name: receiver.cls, args: [], array: 0 })}.${name}(), an external effect`, node);
      case 'opaque':
        if (receiver.path !== undefined && args.length === 0) {
          if (['getPath', 'pathWithinApplication', 'getURI'].includes(name)) return receiver;
          if (['value', 'getRawPath', 'getPath', 'toString'].includes(name)) return pure(receiver.path, T.string);
        }
        this.fail(`The handler reads ${receiver.what} (${name}())`, node, scope);
      case 'template':
        return this.templateCall(name, args, node, scope);
      case 'criteria':
        return criteriaStep(receiver, name, args, node, this, scope);
      case 'sort':
        if (name === 'descending' && args.length === 0) return { t: 'sort', orders: receiver.orders.map((order) => ({ ...order, dir: 'desc' as const })) };
        if (name === 'ascending' && args.length === 0) return { t: 'sort', orders: receiver.orders.map((order) => ({ ...order, dir: 'asc' as const })) };
        if (name === 'and' && args.length === 1 && args[0]!.t === 'sort') return { t: 'sort', orders: [...receiver.orders, ...args[0].orders] };
        this.fail(`Sort.${name}() is not modeled`, node, scope);
      case 'void':
        this.fail(`Call ${name}() on a void value`, node, scope);
      default:
        this.fail(`Call ${name}() on ${describe(receiver)}`, node, scope);
    }
  }

  private enumCall(receiver: SV & { t: 'pure' }, decl: TypeDecl, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    if (name === 'name' && args.length === 0) return pure(receiver.e, T.string);
    if (name === 'toString' && args.length === 0 && !decl.methods.some((method) => method.name === 'toString' && !method.synthetic)) {
      return pure(receiver.e, T.string);
    }
    if (name === 'compareTo' || name === 'ordinal') this.fail(`Enum ${name}() depends on declaration order`, node, scope);
    if (name === 'equals' && args.length === 1 && args[0]!.t === 'pure') return pure(op('eq', receiver.e, args[0].e), T.boolean);
    const method = this.project.methodsOf(decl, name).find((candidate) => candidate.params.length === args.length && !candidate.synthetic && !candidate.modifiers.has('static'));
    if (method === undefined) this.fail(`Enum call ${decl.simple}.${name}()`, node, scope);
    // Evaluate the method for every constant, then select by the runtime value.
    let result: Expr = NULL;
    let resultType: JType = T.object;
    for (const constant of [...decl.enumConstants].reverse()) {
      const instance = this.enumConstant(decl, constant, node, scope);
      const probe = attempt(scope.block, (child) => this.inline(method, instance, args, node, { ...scope, block: child }));
      if (!probe.outcome.ok || probe.instrs.length > 0 || probe.outcome.value.t !== 'pure') {
        this.fail(`Enum method ${decl.simple}.${name}() is not a pure per-constant value`, node, scope);
      }
      resultType = probe.outcome.value.jt;
      result = cond(op('eq', receiver.e, lit(constant)), probe.outcome.value.e, result);
    }
    return pure(result, resultType);
  }

  /** Picks the method an invocation binds to, refusing ambiguous overloads. */
  resolve(type: TypeDecl, name: string, args: SV[], node: SyntaxNode, scope: Scope): MethodDecl {
    const all = this.project.methodsOf(type, name);
    const exact = all.filter((method) => method.params.length === args.length && !method.varargs);
    const variadic = all.filter((method) => method.varargs && args.length >= method.params.length - 1);
    const candidates = exact.length > 0 ? exact : variadic;
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) this.fail(`No method ${type.simple}.${name}/${args.length}`, node, scope);
    const typed = candidates.filter((method) => method.params.every((param, index) => compatible(param.type, args[index]!)));
    if (typed.length === 1) return typed[0]!;
    const own = typed.filter((method) => method.owner === type && method.body !== undefined);
    if (own.length === 1) return own[0]!;
    // Same signature inherited twice: a class implementation wins over interface declarations.
    const sameSignature = typed.every((method) => method.params.length === typed[0]!.params.length
      && method.params.every((param, index) => param.type.name === typed[0]!.params[index]!.type.name));
    const concrete = typed.filter((method) => method.body !== undefined && method.owner.kind === 'class');
    if (sameSignature && concrete.length === 1) return concrete[0]!;
    this.fail(`Ambiguous overload ${type.simple}.${name}/${args.length}`, node, scope);
  }

  /** Executes a declared method body with symbolic arguments. */
  inline(method: MethodDecl, self: SV | undefined, argsIn: SV[], node: SyntaxNode, scope: Scope): SV {
    let args = argsIn;
    if (method.synthetic !== undefined) return this.synthetic(method, self, args, node, scope);
    if (method.body === undefined) {
      if (self?.t === 'bean' && self.cls !== method.owner) {
        const impl = this.resolve(self.cls, method.name, args, node, scope);
        if (impl.body !== undefined) return this.inline(impl, self, args, node, scope);
      }
      this.fail(`Method ${method.owner.simple}.${method.name} has no analyzable body`, node, scope);
    }
    if (method.varargs) {
      // Pack trailing arguments into the varargs array, viewed as a list.
      const fixed = method.params.length - 1;
      const rest = args.slice(fixed);
      const packed = rest.length === 1 && rest[0]!.t === 'list' ? rest[0]! : {
        t: 'list' as const,
        e: { k: 'list' as const, items: rest.map((item) => this.encode(item)) },
        elem: { ...method.params[fixed]!.type, array: 0 },
        element: (item: Expr) => this.view(item, { ...method.params[fixed]!.type, array: 0 }),
      };
      args = [...args.slice(0, fixed), packed];
    }
    const key = `${method.owner.fqn}#${method.name}/${method.params.length}`;
    if (this.stack.includes(key)) this.fail(`Recursive call ${key}`, node, scope);
    if (this.stack.length >= this.config.maxInlineDepth) this.fail('Call chain is too deep', node, scope);
    this.record('call', method.node, method.owner.file.path, `${method.owner.simple}.${method.name}`);
    const env = self?.t === 'bean' && self.closure !== undefined ? self.closure.child() : new Env();
    method.params.forEach((param, index) => env.define(param.name, retype(args[index]!, param.type)));
    this.stack.push(key);
    try {
      return retype(this.runBody(method.body, { env, self, owner: method.owner, block: scope.block }), method.returnType);
    } finally {
      this.stack.pop();
    }
  }

  private synthetic(method: MethodDecl, self: SV | undefined, args: SV[], node: SyntaxNode, scope: Scope): SV {
    const synthetic = method.synthetic!;
    switch (synthetic.kind) {
      case 'getter':
      case 'accessor':
        if (self?.t !== 'obj') this.fail(`Getter ${method.name} on ${self === undefined ? 'nothing' : describe(self)}`, node, scope);
        return this.readField(self, synthetic.property);
      case 'setter':
        if (self?.t !== 'obj') this.fail(`Setter ${method.name} on ${self === undefined ? 'nothing' : describe(self)}`, node, scope);
        this.writeField(self, synthetic.property, retype(args[0]!, method.params[0]!.type));
        return VOID;
      case 'builder': {
        const builder: BuilderSV = { t: 'builder', cls: method.owner.fqn, fields: new Map() };
        for (const decl of this.project.instanceFields(method.owner)) {
          if (decl.initializer !== undefined && decl.annotations.some((annotation) => annotation.name === 'Default')) {
            builder.fields.set(decl.name, this.expr(decl.initializer, { env: new Env(), self: undefined, owner: decl.owner, block: scope.block }));
          }
        }
        return builder;
      }
      case 'toBuilder': {
        if (self?.t !== 'obj') this.fail('toBuilder() on a non-object', node, scope);
        const fields = new Map<string, SV>();
        for (const property of this.properties(self.cls)) fields.set(property.name, this.readField(self, property.name));
        return { t: 'builder', cls: self.cls, fields };
      }
      case 'enum-name':
        if (self?.t === 'pure') return pure(self.e, T.string);
        if (self?.t === 'obj' && self.fields.has('$name')) return self.fields.get('$name')!;
        this.fail('Enum name() on a non-enum value', node, scope);
      default:
        this.fail(`Synthetic member ${method.name}`, node, scope);
    }
  }

  private objectCall(target: ObjSV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    if (target.cls === MUTABLE_LIST) {
      const items = this.asList(target, node, scope);
      if (name === 'add' && args.length === 1) {
        target.fields.set('$items', { ...items, e: op('append', items.e, this.encode(args[0]!)) });
        return pure(TRUE, T.boolean);
      }
      return this.call(items, name, args, node, scope);
    }
    if (target.cls === MUTABLE_SET) {
      const items = this.asList(target, node, scope);
      if ((name === 'add' || name === 'remove') && args.length === 1) {
        const value = args[0]!;
        if (value.t !== 'pure') this.fail('Sets of objects rely on equals()/hashCode()', node, scope);
        const present = op('contains', items.e, value.e);
        const next = name === 'add'
          ? cond(present, items.e, op('append', items.e, value.e))
          : { k: 'filter' as const, of: items.e, as: '$x', body: op('ne', vr('$x'), value.e) };
        target.fields.set('$items', { ...items, e: next });
        return pure(name === 'add' ? not(present) : present, T.boolean);
      }
      if (name === 'addAll') this.fail('Set.addAll() is not modeled', node, scope);
      return this.call(items, name, args, node, scope);
    }
    if (target.cls === MUTABLE_MAP) {
      const key = (sv: SV | undefined): string => {
        if (sv?.t === 'pure' && sv.e.k === 'lit' && typeof sv.e.v === 'string') return sv.e.v;
        this.fail('Map key is not a string literal', node, scope);
      };
      switch (`${name}/${args.length}`) {
        case 'put/2': {
          const previous = this.readField(target, key(args[0]));
          target.fields.set(key(args[0]), args[1]!);
          return previous;
        }
        case 'putIfAbsent/2': {
          const name2 = key(args[0]);
          if (!target.fields.has(name2)) target.fields.set(name2, args[1]!);
          return this.readField(target, name2);
        }
        case 'get/1': return this.readField(target, key(args[0]));
        case 'containsKey/1': return pure(lit(target.fields.has(key(args[0]))), T.boolean);
        case 'isEmpty/0': return pure(lit(target.fields.size === 0), T.boolean);
        case 'size/0': return pure(lit(target.fields.size), T.int);
        default: this.fail(`Map.${name}/${args.length} is not modeled`, node, scope);
      }
    }
    const decl = this.project.type(target.cls);
    if (decl === undefined) this.fail(`Unknown class ${target.cls}`, node, scope);
    const candidates = this.project.methodsOf(decl, name)
      .filter((method) => method.params.length === args.length || (method.varargs && args.length >= method.params.length - 1));
    if (candidates.length > 0) {
      const method = this.resolve(decl, name, args, node, scope);
      return this.inline(method, method.modifiers.has('static') ? undefined : target, args, node, scope);
    }
    if (name === 'equals' && args.length === 1) this.fail(`${decl.simple}.equals() relies on identity or generated equality`, node, scope);
    // The configured Authentication is a verified session: Spring's inherited accessors are known.
    if (decl.fqn === this.config.context.authentication && args.length === 0) {
      if (name === 'isAuthenticated') return pure(TRUE, T.boolean);
      if (name === 'getAuthorities') {
        const granted: JType = { name: 'org.springframework.security.core.GrantedAuthority', args: [], array: 0 };
        return { t: 'list', e: op('coalesce', { k: 'ctx', name: this.config.context.authoritiesClaim ?? 'authorities' }, lit([])), elem: granted, element: (item) => pure(item, granted) };
      }
    }
    this.fail(`No method ${decl.simple}.${name}/${args.length}`, node, scope);
  }

  private builderCall(builder: BuilderSV, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    if (name === 'build' && args.length === 0) {
      const fields = new Map<string, SV>();
      for (const property of this.properties(builder.cls)) {
        fields.set(property.name, builder.fields.get(property.name) ?? defaultValue(property.jt));
      }
      const decl = this.project.type(builder.cls)!;
      const built = this.newObject(builder.cls, fields);
      if (decl.kind === 'record') {
        const compact = decl.constructors.find((ctor) => ctor.node.type === 'compact_constructor_declaration');
        if (compact !== undefined) return this.construct(decl, this.properties(decl.fqn).map((property) => fields.get(property.name)!), node, scope);
      }
      return built;
    }
    if (args.length === 1 && this.propertyType(builder.cls, name) !== undefined) {
      builder.fields.set(name, retype(args[0]!, this.propertyType(builder.cls, name)!));
      return builder;
    }
    this.fail(`Builder method ${name}`, node, scope);
  }

  /** Invokes a lambda or method reference with arguments. */
  apply(fn: SV, args: SV[], block: Block, node: SyntaxNode, scope: Scope): SV {
    if (fn.t === 'lambda') {
      const env = fn.env.child();
      if (fn.params.length !== args.length) this.fail(`Lambda expects ${fn.params.length} arguments, got ${args.length}`, node, scope);
      fn.params.forEach((param, index) => env.define(param, args[index]!));
      const inner: Scope = { env, self: fn.self, owner: fn.owner, block };
      return fn.body.type === 'block' ? this.runBody(fn.body, inner) : this.expr(fn.body, inner);
    }
    if (fn.t === 'mref') {
      const inner: Scope = { ...scope, block, owner: fn.owner };
      if (fn.receiver !== undefined) return this.call(fn.receiver, fn.name, args, node, inner);
      const type = fn.type!;
      if (fn.name === '<init>') return this.newInstance(type, args, node, inner);
      const decl = this.project.type(type);
      if (decl !== undefined) {
        const statics = this.project.methodsOf(decl, fn.name).filter((method) => method.modifiers.has('static') && method.params.length === args.length);
        if (statics.length > 0) return this.call({ t: 'type', fqn: type }, fn.name, args, node, inner);
      }
      if (args.length === 0) this.fail(`Unbound method reference ${type}::${fn.name} without receiver`, node, scope);
      const [firstIn, ...rest] = args;
      // Type::method fixes the receiver's static type, as javac does.
      const first = firstIn!.t === 'pure' && (firstIn!.jt.name === 'java.lang.Object' || firstIn!.jt.unresolved === true)
        ? { ...firstIn!, jt: { name: type, args: [], array: 0 } } as SV
        : firstIn!;
      if (decl === undefined) {
        const staticAttempt = libraryStaticTry(this, type, fn.name, args, node, inner);
        if (staticAttempt !== undefined) return staticAttempt;
      }
      return this.call(first!, fn.name, rest, node, inner);
    }
    if (fn.t === 'exception') return fn;
    this.fail(`${describe(fn)} is not a function`, node, scope);
  }

  // -------------------------------------------------------------------------
  // Object creation
  // -------------------------------------------------------------------------

  private creation(node: SyntaxNode, scope: Scope): SV {
    const jt = this.project.parseType(field(node, 'type')!, scope.owner);
    const anonymousBody = named(node).find((child) => child.type === 'class_body');
    if (anonymousBody !== undefined) {
      const base = this.project.type(jt.name);
      if (base === undefined || base.kind !== 'interface') this.fail('Anonymous subclasses of classes are not supported', node, scope);
      const decl = this.project.anonymousType(anonymousBody, jt, scope.owner);
      if (decl.fields.length > 0) this.fail('Anonymous class with state', node, scope);
      return { t: 'bean', cls: decl, closure: scope.env };
    }
    const args = named(field(node, 'arguments')).map((arg) => this.expr(arg, scope));
    return this.newInstance(jt.name, args, node, scope);
  }

  newInstance(fqn: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    const simpleName = fqn.slice(fqn.lastIndexOf('.') + 1);
    if (['ArrayList', 'LinkedList'].includes(simpleName) && (args.length === 0 || (args.length === 1 && args[0]!.t === 'pure' && isIntegral(args[0].jt)))) {
      return this.newObject(MUTABLE_LIST, new Map([['$items', { t: 'list', e: lit([]), elem: T.object, element: (item: Expr) => pure(item, T.object) } as SV]]));
    }
    if (['ArrayList', 'LinkedList'].includes(simpleName) && args.length === 1) {
      return this.newObject(MUTABLE_LIST, new Map([['$items', this.asList(args[0]!, node, scope) as SV]]));
    }
    if (['LinkedHashMap', 'HashMap', 'TreeMap'].includes(simpleName) && args.length === 0) return this.newObject(MUTABLE_MAP);
    if (['LinkedHashMap', 'HashMap'].includes(simpleName) && args.length === 1 && args[0]!.t === 'obj' && args[0].cls === MUTABLE_MAP) {
      return this.newObject(MUTABLE_MAP, new Map(args[0].fields));
    }
    if (['LinkedHashSet', 'HashSet'].includes(simpleName) && (args.length === 0 || (args.length === 1 && args[0]!.t === 'pure' && isIntegral(args[0].jt)))) {
      return this.newObject(MUTABLE_SET, new Map([['$items', { t: 'list', e: lit([]), elem: T.object, element: (item: Expr) => pure(item, T.object) } as SV]]));
    }
    if (['LinkedHashSet', 'HashSet'].includes(simpleName) && args.length === 1) {
      const source = this.asList(args[0]!, node, scope);
      if (fieldTypeOf(this.project, source.elem) === undefined) this.fail('Sets of objects rely on equals()/hashCode()', node, scope);
      // Duplicates collapse (first occurrence kept); HashSet admits null.
      return this.newObject(MUTABLE_SET, new Map([['$items', { ...source, e: op('distinct', source.e, TRUE) } as SV]]));
    }
    const decl = this.project.type(fqn);
    if (this.isException(fqn)) return this.exception(fqn, args, node, scope);
    if (decl === undefined) return libraryStatic(this, fqn, '<init>', args, node, scope);
    if (decl.kind === 'record' || decl.kind === 'class') return this.construct(decl, args, node, scope);
    this.fail(`Cannot instantiate ${decl.kind} ${decl.simple}`, node, scope);
  }

  isException(fqn: string): boolean {
    if (THROWABLE.has(fqn)) return true;
    if (/(^|\.)[A-Z]\w*(Exception|Error)$/.test(fqn) && this.project.type(fqn) === undefined) return true;
    const decl = this.project.type(fqn);
    if (decl === undefined) return false;
    return [...this.project.supertypeNames(decl)].some((name) => THROWABLE.has(name) || /(Exception|Error)$/.test(name) && this.project.type(name) === undefined);
  }

  /** new X(...) for an exception: captures its class, message and explicit status. */
  private exception(fqn: string, args: SV[], node: SyntaxNode, scope: Scope): ExceptionSV {
    const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
    if (simple === 'ResponseStatusException' || simple === 'ErrorResponseException') {
      const status = args[0];
      if (status?.t !== 'pure' || status.e.k !== 'lit' || typeof status.e.v !== 'number') this.fail('ResponseStatusException with a dynamic status', node, scope);
      const reason = args[1];
      return { t: 'exception', cls: fqn, status: status.e.v as number, message: reason?.t === 'pure' ? reason.e : NULL };
    }
    const decl = this.project.type(fqn);
    if (decl === undefined) {
      const first = args[0];
      return { t: 'exception', cls: fqn, message: first?.t === 'pure' ? first.e : NULL };
    }
    const ctor = decl.constructors.find((candidate) => candidate.params.length === args.length);
    if (ctor === undefined) this.fail(`No constructor ${decl.simple}/${args.length}`, node, scope);
    if (ctor.body === undefined) {
      const first = args[0];
      return { t: 'exception', cls: fqn, message: first?.t === 'pure' ? first.e : NULL };
    }
    // The message is whatever the constructor passes to super(...).
    const env = new Env();
    ctor.params.forEach((param, index) => env.define(param.name, args[index]!));
    const superCall = named(ctor.body).find((statement) => statement.type === 'explicit_constructor_invocation');
    if (superCall === undefined) return { t: 'exception', cls: fqn, message: NULL };
    const superArgs = named(field(superCall, 'arguments')).map((arg) => this.expr(arg, { env, self: undefined, owner: decl, block: scope.block }));
    const parent = decl.superclass?.name ?? 'java.lang.RuntimeException';
    if (field(superCall, 'constructor')?.text === 'this' || superCall.text.startsWith('this')) {
      const delegated = this.exception(fqn, superArgs, node, scope);
      return delegated;
    }
    const inherited = this.isException(parent) && this.project.type(parent) !== undefined
      ? this.exception(parent, superArgs, node, scope)
      : this.exception(parent, superArgs, node, scope);
    return { ...inherited, cls: fqn };
  }

  /** Runs a constructor (explicit, Lombok-generated, record canonical/compact). */
  construct(decl: TypeDecl, args: SV[], node: SyntaxNode, scope: Scope): ObjSV {
    if (decl.modifiers.has('abstract')) this.fail(`Cannot instantiate abstract ${decl.simple}`, node, scope);
    const target = this.newObject(decl.fqn);
    // Field initializers (superclass first) run before constructor bodies.
    for (const decl2 of this.project.instanceFields(decl)) {
      if (decl2.initializer !== undefined) {
        target.fields.set(decl2.name, this.expr(decl2.initializer, { env: new Env(), self: target, owner: decl2.owner, block: scope.block }));
      }
    }
    this.runConstructor(decl, target, args, node, scope);
    return target;
  }

  private runConstructor(decl: TypeDecl, target: ObjSV, args: SV[], node: SyntaxNode, scope: Scope): void {
    const candidates = decl.constructors.filter((candidate) => candidate.params.length === args.length);
    if (candidates.length === 0 && args.length === 0 && decl.constructors.length === 0) {
      this.implicitSuper(decl, target, node, scope);
      return;
    }
    const typed = candidates.filter((candidate) => candidate.params.every((param, index) => compatible(param.type, args[index]!)));
    const ctor = candidates.length === 1 ? candidates[0]! : typed.length === 1 ? typed[0]! : this.fail(`No unique constructor ${decl.simple}/${args.length}`, node, scope);
    if (ctor.synthetic?.kind === 'all-args-ctor') {
      ctor.params.forEach((param, index) => target.fields.set(param.name, retype(args[index]!, param.type)));
      if (args.length === 0) this.implicitSuper(decl, target, node, scope);
      return;
    }
    const body = ctor.body;
    if (body === undefined) this.fail(`Constructor ${decl.simple} has no body`, node, scope);
    const env = new Env();
    ctor.params.forEach((param, index) => env.define(param.name, retype(args[index]!, param.type)));
    const ctorScope: Scope = { env, self: target, owner: decl, block: scope.block };
    const statements = statementsOf(body);
    const delegation = statements[0]?.type === 'explicit_constructor_invocation' ? statements[0] : undefined;
    const key = `${decl.fqn}#<init>/${args.length}`;
    if (this.stack.includes(key)) this.fail(`Recursive constructor ${key}`, node, scope);
    this.stack.push(key);
    try {
      this.record('call', ctor.node, decl.file.path, `${decl.simple}.<init>`);
      if (delegation !== undefined) {
        const delegateArgs = named(field(delegation, 'arguments')).map((arg) => this.expr(arg, ctorScope));
        if (/^\s*this\b/.test(delegation.text)) this.runConstructor(decl, target, delegateArgs, node, scope);
        else {
          const parent = decl.superclass === undefined ? undefined : this.project.type(decl.superclass.name);
          if (parent !== undefined) this.runConstructor(parent, target, delegateArgs, node, scope);
          else if (delegateArgs.length > 0) this.fail(`Constructor of ${decl.simple} passes arguments to a library superclass`, node, scope);
        }
      } else {
        this.implicitSuper(decl, target, node, scope);
      }
      this.statements(statements.filter((statement) => statement !== delegation), 0, ctorScope);
    } finally {
      this.stack.pop();
    }
    if (ctor.node.type === 'compact_constructor_declaration') {
      // Compact constructors assign the (possibly reassigned) parameters at the end.
      for (const component of decl.recordComponents) target.fields.set(component.name, env.get(component.name)!);
    }
  }

  /** Implicit super() call: the parent's no-argument constructor body, when it has one. */
  private implicitSuper(decl: TypeDecl, target: ObjSV, node: SyntaxNode, scope: Scope): void {
    const parent = decl.superclass === undefined ? undefined : this.project.type(decl.superclass.name);
    if (parent === undefined) return;
    const noArg = parent.constructors.find((candidate) => candidate.params.length === 0);
    if (noArg === undefined && parent.constructors.length > 0) this.fail(`${parent.simple} has no no-argument constructor`, node, scope);
    this.runConstructor(parent, target, [], node, scope);
  }

  // -------------------------------------------------------------------------
  // Static calls and context sources
  // -------------------------------------------------------------------------

  private staticCall(fqn: string, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    // X.class.getName() / getSimpleName(): a class literal used as a value.
    if (args.length === 0 && name === 'getName') return pure(lit(binaryName(this.project, fqn)), T.string);
    if (args.length === 0 && name === 'getSimpleName') return pure(lit(fqn.slice(fqn.lastIndexOf('.') + 1)), T.string);
    const source = this.contextSource(fqn, name);
    if (source !== undefined) return source;
    if (this.config.externalEffects.some((prefix) => fqn.startsWith(prefix))) {
      throw new ExternalEffect(`Calls ${fqn}.${name}(), an external effect`, node);
    }
    const decl = this.project.type(fqn);
    if (decl === undefined) return libraryStatic(this, fqn, name, args, node, scope);
    if (decl.kind === 'enum' && name === 'values' && args.length === 0) {
      const jt: JType = { name: decl.fqn, args: [], array: 0 };
      return { t: 'list', e: { k: 'list', items: decl.enumConstants.map((constant) => lit(constant)) }, elem: jt, element: (item) => pure(item, jt) };
    }
    if (decl.kind === 'enum' && name === 'valueOf' && args.length === 1 && args[0]!.t === 'pure') {
      return pure({ k: 'cast', to: 'enum', of: (args[0] as { e: Expr }).e, values: decl.enumConstants }, { name: decl.fqn, args: [], array: 0 });
    }
    const method = this.resolve(decl, name, args, node, scope);
    if (!method.modifiers.has('static') && method.synthetic?.kind !== 'builder') this.fail(`Instance method ${decl.simple}.${name} called statically`, node, scope);
    return this.inline(method, undefined, args, node, scope);
  }

  private contextSource(fqn: string, name: string): SV | undefined {
    const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
    const source = this.config.context.sources.find((candidate) => candidate.method === `${simple}.${name}` || candidate.method === `${fqn}.${name}`);
    if (source === undefined) return undefined;
    if (source.kind === 'claim') {
      const claim = source.claim!;
      return { t: 'mono', elem: T.uuid, run: () => ({ value: pure({ k: 'ctx', name: claim }, T.uuid), empty: op('isNull', { k: 'ctx', name: claim }) }) };
    }
    const type = this.project.type(source.type!) ?? [...(this.project.bySimple.get(source.type!) ?? [])][0];
    if (type === undefined) throw new Unsupported(`Context type ${source.type} is not in the analyzed sources.`);
    const fields = new Map<string, SV>();
    for (const property of this.properties(type.fqn)) fields.set(property.name, pure({ k: 'ctx', name: property.name }, property.jt));
    const context = obj(type.fqn, fields);
    const jt: JType = { name: type.fqn, args: [], array: 0 };
    if (source.kind === 'required') return { t: 'mono', elem: jt, run: () => ({ value: context, empty: FALSE }) };
    return { t: 'mono', elem: jt, run: () => ({ value: { t: 'optional', value: context, present: TRUE }, empty: FALSE }) };
  }

  // -------------------------------------------------------------------------
  // Repositories
  // -------------------------------------------------------------------------

  private useEntity(entity: EntityModel, kind: 'read' | 'write'): void {
    this.entities.set(entity.fqn, entity);
    (kind === 'read' ? this.reads : this.writes).add(entity.fqn);
  }

  /** An object loaded from a projection row, after the entity's AfterConvert callbacks. */
  loaded(base: Expr, entity: EntityModel, scope: Scope, node: SyntaxNode): ObjSV {
    const loaded = this.newObject(entity.fqn, new Map(), base, { entity: entity.fqn });
    for (const name of entity.transients) {
      const decl = this.project.instanceFields(entity.decl).find((candidate) => candidate.name === name)!;
      loaded.fields.set(name, decl.initializer === undefined
        ? defaultValue(decl.type)
        : this.expr(decl.initializer, { env: new Env(), self: loaded, owner: decl.owner, block: scope.block }));
    }
    for (const callback of entity.afterConvert) {
      const owner: SV = { t: 'bean', cls: callback.owner };
      this.inline(callback, owner, [loaded, pure(lit(entity.table), T.string)], node, scope);
    }
    return loaded;
  }

  private repositoryCall(repo: RepositoryModel, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    const entity = repo.entity;
    const entityType: JType = { name: entity.fqn, args: [], array: 0 };
    this.record('database-read', repo.decl.node, repo.decl.file.path, `${repo.decl.simple}.${name}`);
    const key = (sv: SV, what: string): Expr => {
      if (sv.t !== 'pure') this.fail(`${what} must be a scalar identifier`, node, scope);
      return sv.e;
    };
    const declared = this.project.methodsOf(repo.decl, name).find((method) => method.params.length === args.length && method.owner.fqn.startsWith(repo.decl.pkg.split('.')[0]!));
    const builtin = declared === undefined || declared.owner.fqn.startsWith('org.springframework') ||
      (CRUD_METHODS.has(`${name}/${args.length}`) && !declared.annotations.some((annotation) => annotation.name === 'Query'));
    if (builtin) {
      switch (`${name}/${args.length}`) {
        case 'findById/1': {
          const id = key(args[0]!, 'findById argument');
          return {
            t: 'mono',
            elem: entityType,
            run: (block) => {
              this.useEntity(entity, 'read');
              if (!isLit(id) || isLit(id, null)) {
                block.emit({ op: 'ASSERT', test: op('notNull', id), error: this.errors.map({ t: 'exception', cls: 'java.lang.IllegalArgumentException', message: lit('The given id must not be null') }) });
              }
              const out = block.fresh(entity.decl.simple.toLowerCase());
              block.emit({ op: 'QUERY', out, entity: entity.fqn, mode: 'one', where: [{ field: entity.key, cmp: 'eq', value: id }] });
              return { value: this.loaded(vr(out), entity, { ...scope, block }, node), empty: op('isNull', vr(out)) };
            },
          };
        }
        case 'existsById/1': {
          const id = key(args[0]!, 'existsById argument');
          return {
            t: 'mono',
            elem: T.boolean,
            run: (block) => {
              this.useEntity(entity, 'read');
              const out = block.fresh('exists');
              block.emit({ op: 'QUERY', out, entity: entity.fqn, mode: 'exists', where: [{ field: entity.key, cmp: 'eq', value: id }] });
              return { value: pure(vr(out), T.boolean), empty: FALSE };
            },
          };
        }
        case 'findAll/0':
          return this.queryFlux(entity, [], [], undefined, node, scope);
        case 'count/0':
          return {
            t: 'mono',
            elem: T.long,
            run: (block) => {
              this.useEntity(entity, 'read');
              const out = block.fresh('count');
              block.emit({ op: 'QUERY', out, entity: entity.fqn, mode: 'count', where: [] });
              return { value: pure(vr(out), T.long), empty: FALSE };
            },
          };
        case 'save/1':
          return this.save(entity, args[0]!, node, scope);
        case 'deleteById/1': {
          const id = key(args[0]!, 'deleteById argument');
          return { t: 'mono', elem: T.void, run: (block) => {
            this.useEntity(entity, 'write');
            block.emit({ op: 'DELETE', entity: entity.fqn, key: id });
            this.record('database-write', repo.decl.node, repo.decl.file.path, `${repo.decl.simple}.deleteById`);
            return { value: VOID, empty: TRUE };
          } };
        }
        case 'delete/1': {
          const target = args[0]!;
          if (target.t !== 'obj') this.fail('delete() of a non-entity value', node, scope);
          return { t: 'mono', elem: T.void, run: (block) => {
            this.useEntity(entity, 'write');
            block.emit({ op: 'DELETE', entity: entity.fqn, key: this.encode(this.readField(target, entity.key)) });
            this.record('database-write', repo.decl.node, repo.decl.file.path, `${repo.decl.simple}.delete`);
            return { value: VOID, empty: TRUE };
          } };
        }
        default:
          if (declared === undefined) this.fail(`Repository method ${repo.decl.simple}.${name}/${args.length} is not modeled`, node, scope);
      }
    }
    const method = declared!;
    const shape = (() => {
      try {
        return this.persistence.queryShape(repo, method);
      } catch (error) {
        if (error instanceof Unsupported) this.fail(error.reason, node, scope);
        throw error;
      }
    })();
    if (shape === undefined) this.fail(`Repository method ${name} is not modeled`, node, scope);
    if (method.params.some((param) => ['Pageable', 'Sort', 'Limit', 'ScrollPosition'].includes(typeName(param.type)))) {
      this.fail(`Repository method ${name} takes paging or sorting arguments`, node, scope);
    }
    const filters: Filter[] = [];
    let position = 0;
    shape.criteria.forEach((criterion, index) => {
      const pick = (): Expr => {
        if (shape.bindings !== undefined) {
          const binding = shape.bindings[index];
          const paramIndex = typeof binding === 'number' ? binding : method.params.findIndex((param) =>
            param.name === binding || param.annotations.some((annotation) => annotation.name === 'Param' && stringValue(annotation.args.get('value')!) === binding));
          const value = args[paramIndex];
          if (value === undefined) this.fail(`@Query parameter ${String(binding)} is not bound`, node, scope);
          return this.encode(value);
        }
        const value = args[position];
        position += 1;
        if (value === undefined) this.fail(`Query ${name} has fewer arguments than criteria`, node, scope);
        return value.t === 'list' ? value.e : this.encode(value);
      };
      switch (criterion.cmp) {
        case 'isNull':
        case 'notNull':
          filters.push({ field: criterion.property, cmp: criterion.cmp });
          break;
        case 'true':
          filters.push({ field: criterion.property, cmp: 'eq', value: TRUE });
          break;
        case 'false':
          filters.push({ field: criterion.property, cmp: 'eq', value: FALSE });
          break;
        case 'between': {
          const low = pick();
          const high = pick();
          filters.push({ field: criterion.property, cmp: 'ge', value: low }, { field: criterion.property, cmp: 'le', value: high });
          break;
        }
        default:
          filters.push({ field: criterion.property, cmp: criterion.cmp, value: pick() });
      }
    });
    this.record('database-read', method.node, method.owner.file.path, `${repo.decl.simple}.${name}`);
    if (shape.mode === 'many') return this.queryFlux(entity, filters, shape.orderBy, shape.limit, node, scope);
    if (shape.mode === 'delete') {
      return {
        t: 'mono',
        elem: T.long,
        run: (block) => {
          this.useEntity(entity, 'read');
          this.useEntity(entity, 'write');
          this.record('database-write', method.node, method.owner.file.path, `${repo.decl.simple}.${name}`);
          const out = block.fresh('deleted');
          block.emit({ op: 'QUERY', out, entity: entity.fqn, mode: 'one', where: filters });
          emitIf(block, op('notNull', vr(out)), [{ op: 'DELETE', entity: entity.fqn, key: getf(vr(out), entity.key) }], []);
          return { value: pure(cond(op('notNull', vr(out)), lit(1), lit(0)), T.long), empty: FALSE };
        },
      };
    }
    const mode = shape.mode;
    return {
      t: 'mono',
      elem: mode === 'one' ? entityType : mode === 'count' ? T.long : T.boolean,
      run: (block) => {
        this.useEntity(entity, 'read');
        const out = block.fresh(mode === 'one' ? entity.decl.simple.toLowerCase() : mode);
        block.emit({
          op: 'QUERY', out, entity: entity.fqn, mode, where: filters,
          ...(shape.orderBy.length > 0 ? { orderBy: shape.orderBy } : {}),
          ...(shape.limit === undefined ? {} : { limit: shape.limit }),
        });
        if (mode === 'one') return { value: this.loaded(vr(out), entity, { ...scope, block }, node), empty: op('isNull', vr(out)) };
        return { value: pure(vr(out), mode === 'count' ? T.long : T.boolean), empty: FALSE };
      },
    };
  }

  private queryFlux(entity: EntityModel, where: Filter[], orderBy: { field: string; dir: 'asc' | 'desc' }[], limit: number | undefined, node: SyntaxNode, scope: Scope): FluxSV {
    const entityType: JType = { name: entity.fqn, args: [], array: 0 };
    return {
      t: 'flux',
      elem: entityType,
      run: (block) => {
        this.useEntity(entity, 'read');
        if (entity.afterConvert.length > 0 && entity.afterConvert.some((callback) => callback.body !== undefined && !isTransientOnlyCallback(callback, entity))) {
          this.fail(`AfterConvertCallback of ${entity.decl.simple} changes stored properties`, node, scope);
        }
        const out = block.fresh(`${entity.decl.simple.toLowerCase()}s`);
        block.emit({
          op: 'QUERY', out, entity: entity.fqn, mode: 'many', where,
          ...(orderBy.length > 0 ? { orderBy } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
        return { list: vr(out), element: (item: Expr) => obj(entity.fqn, new Map(), item, { entity: entity.fqn }) };
      },
    };
  }

  /** Spring Data save(): INSERT when the entity is new, UPDATE otherwise. */
  private save(entity: EntityModel, target: SV, node: SyntaxNode, scope: Scope): MonoSV {
    if (target.t !== 'obj' || target.cls !== entity.fqn) this.fail(`save() of ${describe(target)} instead of ${entity.decl.simple}`, node, scope);
    if (entity.version !== undefined) this.fail(`Optimistic locking (@Version on ${entity.decl.simple}) is not modeled`, node, scope);
    return {
      t: 'mono',
      elem: { name: entity.fqn, args: [], array: 0 },
      run: (block) => {
        this.useEntity(entity, 'write');
        this.record('database-write', entity.decl.node, entity.decl.file.path, `${entity.decl.simple}.save`);
        const isNew = this.isNew(entity, target, node, { ...scope, block });
        branch(block, isNew, (child) => this.insert(entity, target, child, node, scope), (child) => this.update(entity, target, child), () => undefined);
        return { value: target, empty: FALSE };
      },
    };
  }

  private isNew(entity: EntityModel, target: ObjSV, node: SyntaxNode, scope: Scope): Expr {
    if (entity.persistable) {
      const method = this.project.methodsOf(entity.decl, 'isNew').find((candidate) => candidate.params.length === 0 && candidate.body !== undefined);
      if (method === undefined) this.fail(`${entity.decl.simple} implements Persistable without an analyzable isNew()`, node, scope);
      return asBool(this.inline(method, target, [], node, scope), 'isNew()');
    }
    const id = this.readField(target, entity.key);
    if (id.t !== 'pure') this.fail('Entity id is not a scalar', node, scope);
    const property = entity.properties.get(entity.key)!;
    return property.jt.array === 0 && ['int', 'long', 'short'].includes(property.jt.name) ? op('eq', id.e, lit(0)) : op('isNull', id.e);
  }

  private insert(entity: EntityModel, target: ObjSV, block: Block, node: SyntaxNode, scope: Scope): void {
    const values: Record<string, Expr> = {};
    const keyValue = this.readField(target, entity.key);
    if (keyValue.t === 'pure' && isLit(keyValue.e, null)) {
      const property = entity.properties.get(entity.key)!;
      if (property.type.type !== 'uuid') this.fail(`${entity.decl.simple} relies on a database-generated ${property.type.type} key`, node, scope);
      const slot = this.counters.uuidSlots;
      this.counters.uuidSlots += 1;
      target.fields.set(entity.key, pure({ k: 'uuid', slot }, property.jt));
    }
    for (const property of entity.properties.values()) {
      if (entity.auditing.created.includes(property.name) || entity.auditing.modified.includes(property.name)) {
        this.fail('Spring Data auditing annotations are not modeled', node, scope);
      }
      const value = this.readField(target, property.name);
      values[property.name] = this.storable(value, property, node, scope);
    }
    const out = block.fresh(`${entity.decl.simple.toLowerCase()}_saved`);
    block.emit({ op: 'INSERT', entity: entity.fqn, values, out });
  }

  private update(entity: EntityModel, target: ObjSV, block: Block): void {
    const values: Record<string, Expr> = {};
    for (const property of entity.properties.values()) {
      if (property.name === entity.key) continue;
      values[property.name] = this.storable(this.readField(target, property.name), property, undefined, undefined);
    }
    const out = block.fresh(`${entity.decl.simple.toLowerCase()}_saved`);
    block.emit({ op: 'UPDATE', entity: entity.fqn, key: this.encode(this.readField(target, entity.key)), values, out });
  }

  private storable(value: SV, property: { name: string; type: FieldType }, node: SyntaxNode | undefined, scope: Scope | undefined): Expr {
    if (value.t !== 'pure') {
      throw new Unsupported(`Property ${property.name} holds ${describe(value)}, not a column value${node && scope ? ` (${scope.owner.file.path}:${node.startPosition.row + 1})` : ''}.`);
    }
    return value.e;
  }

  // -------------------------------------------------------------------------
  // R2dbcEntityTemplate
  // -------------------------------------------------------------------------

  private entityOfClass(sv: SV | undefined, node: SyntaxNode, scope: Scope): EntityModel {
    if (sv?.t !== 'type') this.fail('Entity class argument is not a class literal', node, scope);
    const decl = this.project.type(sv.fqn);
    if (decl === undefined) this.fail(`Entity class ${sv.fqn} is not in the sources`, node, scope);
    try {
      return this.persistence.entity(decl);
    } catch (error) {
      if (error instanceof Unsupported) this.fail(error.reason, node, scope);
      throw error;
    }
  }

  private entityOfObject(sv: SV | undefined, node: SyntaxNode, scope: Scope): { entity: EntityModel; target: ObjSV } {
    if (sv?.t !== 'obj') this.fail('Template write of a non-entity value', node, scope);
    const decl = this.project.type(sv.cls)!;
    try {
      return { entity: this.persistence.entity(decl), target: sv };
    } catch (error) {
      if (error instanceof Unsupported) this.fail(error.reason, node, scope);
      throw error;
    }
  }

  /** Criteria columns are property names or column names. */
  private criteriaFilters(entity: EntityModel, criteria: SV | undefined, node: SyntaxNode, scope: Scope): { where: Filter[]; orderBy: { field: string; dir: 'asc' | 'desc' }[]; limit?: number } {
    if (criteria === undefined) return { where: [], orderBy: [] };
    if (criteria.t !== 'criteria') this.fail('Template query is not a Criteria/Query', node, scope);
    if (criteria.pending !== undefined) this.fail(`Criteria on ${criteria.pending} has no operator`, node, scope);
    const property = (column: string) => {
      const found = [...entity.properties.values()].find((candidate) => candidate.name === column || candidate.column.toLowerCase() === column.toLowerCase());
      if (found === undefined) this.fail(`Criteria column ${column} is not mapped on ${entity.decl.simple}`, node, scope);
      return found.name;
    };
    const where: Filter[] = [];
    for (const condition of criteria.conditions) {
      const field2 = property(condition.column);
      if (condition.cmp === 'isNull' || condition.cmp === 'notNull') where.push({ field: field2, cmp: condition.cmp });
      else if (condition.cmp === 'between') where.push({ field: field2, cmp: 'ge', value: condition.values[0]! }, { field: field2, cmp: 'le', value: condition.values[1]! });
      else where.push({ field: field2, cmp: condition.cmp, value: condition.values[0]! });
    }
    return { where, orderBy: criteria.orderBy.map((order) => ({ field: property(order.column), dir: order.dir })), ...(criteria.limit === undefined ? {} : { limit: criteria.limit }) };
  }

  private templateCall(name: string, args: SV[], node: SyntaxNode, scope: Scope): SV {
    switch (`${name}/${args.length}`) {
      case 'select/2':
      case 'selectOne/2':
      case 'count/2':
      case 'exists/2': {
        const entity = this.entityOfClass(args[1], node, scope);
        const query = this.criteriaFilters(entity, args[0], node, scope);
        if (name === 'select') return this.queryFlux(entity, query.where, query.orderBy, query.limit, node, scope);
        const mode = name === 'selectOne' ? 'one' : name === 'count' ? 'count' : 'exists';
        return {
          t: 'mono',
          elem: mode === 'one' ? { name: entity.fqn, args: [], array: 0 } : mode === 'count' ? T.long : T.boolean,
          run: (block) => {
            this.useEntity(entity, 'read');
            const out = block.fresh(mode === 'one' ? entity.decl.simple.toLowerCase() : mode);
            block.emit({ op: 'QUERY', out, entity: entity.fqn, mode, where: query.where, ...(query.orderBy.length > 0 ? { orderBy: query.orderBy } : {}), ...(query.limit === undefined ? {} : { limit: query.limit }) });
            if (mode === 'one') return { value: this.loaded(vr(out), entity, { ...scope, block }, node), empty: op('isNull', vr(out)) };
            return { value: pure(vr(out), mode === 'count' ? T.long : T.boolean), empty: FALSE };
          },
        };
      }
      case 'insert/1': {
        const { entity, target } = this.entityOfObject(args[0], node, scope);
        return { t: 'mono', elem: { name: entity.fqn, args: [], array: 0 }, run: (block) => {
          this.useEntity(entity, 'write');
          this.record('database-write', entity.decl.node, entity.decl.file.path, `${entity.decl.simple}.insert`);
          this.insert(entity, target, block, node, scope);
          return { value: target, empty: FALSE };
        } };
      }
      case 'update/1': {
        const { entity, target } = this.entityOfObject(args[0], node, scope);
        if (entity.version !== undefined) this.fail(`Optimistic locking on ${entity.decl.simple} is not modeled`, node, scope);
        return { t: 'mono', elem: { name: entity.fqn, args: [], array: 0 }, run: (block) => {
          this.useEntity(entity, 'write');
          this.record('database-write', entity.decl.node, entity.decl.file.path, `${entity.decl.simple}.update`);
          this.update(entity, target, block);
          return { value: target, empty: FALSE };
        } };
      }
      case 'delete/1': {
        const { entity, target } = this.entityOfObject(args[0], node, scope);
        return { t: 'mono', elem: { name: entity.fqn, args: [], array: 0 }, run: (block) => {
          this.useEntity(entity, 'write');
          block.emit({ op: 'DELETE', entity: entity.fqn, key: this.encode(this.readField(target, entity.key)) });
          return { value: target, empty: FALSE };
        } };
      }
      default:
        this.fail(`R2dbcEntityTemplate.${name}/${args.length} is not modeled`, node, scope);
    }
  }

  /** Emits the error for a failed Mono/Flux (Mono.error) into `block`. */
  fault(exception: SV, block: Block, node: SyntaxNode, scope: Scope): never {
    return this.throwException(exception, block, node, scope);
  }

  /** Runs a Mono, used by the endpoint finalizer. */
  subscribe(mono: MonoSV, block: Block): Emission {
    return mono.run(block);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function statementsOf(body: SyntaxNode): SyntaxNode[] {
  const nodes = body.type === 'block' || body.type === 'constructor_body' ? named(body) : [body];
  return nodes.filter((node) => !node.type.endsWith('comment'));
}

export function defaultValue(jt: JType): SV {
  if (jt.array === 0) {
    switch (jt.name) {
      case 'boolean': return pure(FALSE, jt);
      case 'int': case 'long': case 'short': case 'byte': case 'double': case 'float': return pure(lit(0), jt);
      case 'char': return pure(lit('\u0000'), jt);
    }
  }
  return pure(NULL, jt);
}

/** Narrows a value's static type to a declaration (variables, parameters, casts). */
export function retype(value: SV, declared: JType): SV {
  if (value.t === 'pure' && !declared.unresolved && declared.name !== 'var' && declared.name !== 'java.lang.Object') {
    return { ...value, jt: declared };
  }
  if (value.t === 'mono' && typeName(declared) === 'Mono' && declared.args[0] !== undefined && !declared.args[0].unresolved) {
    return { ...value, elem: declared.args[0] };
  }
  if (value.t === 'flux' && typeName(declared) === 'Flux' && declared.args[0] !== undefined && !declared.args[0].unresolved) {
    return { ...value, elem: declared.args[0] };
  }
  // Collections built with a diamond (new LinkedHashSet<>()) learn their element type from the declaration.
  const element = declared.args[0];
  if (value.t === 'list' && value.elem.name === 'java.lang.Object' && element !== undefined && !element.unresolved && element.name !== 'java.lang.Object'
    && ['List', 'Set', 'Collection', 'Iterable', 'ArrayList', 'LinkedHashSet', 'HashSet', 'LinkedList'].includes(typeName(declared))) {
    const view = value.element;
    return { ...value, elem: element, element: (item) => retype(view(item), element) };
  }
  return value;
}

function nullCheck(value: SV, ev: Evaluator): Expr {
  switch (value.t) {
    case 'pure': return op('isNull', value.e);
    case 'obj': return value.base !== undefined && value.fields.size === 0 ? op('isNull', value.base) : FALSE;
    case 'list': return op('isNull', value.e);
    default:
      if (value.t === 'optional' || value.t === 'mono' || value.t === 'flux' || value.t === 'builder') return FALSE;
      void ev;
      return FALSE;
  }
}

function isBooleanType(jt: JType): boolean {
  return jt.name === 'boolean' || jt.name === 'java.lang.Boolean';
}

function isIntegral(jt: JType): boolean {
  return ['int', 'long', 'short', 'byte', 'java.lang.Integer', 'java.lang.Long', 'java.lang.Short', 'java.lang.Byte'].includes(jt.name);
}

function isNumericOrBoolean(jt: JType): boolean {
  return isIntegral(jt) || isBooleanType(jt) || ['double', 'float', 'char'].includes(jt.name);
}

function isListType(jt: JType): boolean {
  return ['java.util.List', 'java.util.Collection', 'java.lang.Iterable', 'java.util.ArrayList', 'java.util.Set', 'java.util.LinkedList'].includes(jt.name);
}

function compatible(param: JType, arg: SV): boolean {
  if (arg.t === 'pure') {
    if (arg.jt.name === 'java.lang.Object' || param.unresolved) return true;
    if (param.name === arg.jt.name) return true;
    const boxes: Record<string, string> = { int: 'java.lang.Integer', long: 'java.lang.Long', boolean: 'java.lang.Boolean', double: 'java.lang.Double' };
    return boxes[param.name] === arg.jt.name || boxes[arg.jt.name] === param.name;
  }
  if (arg.t === 'obj') return param.name === arg.cls || param.unresolved === true;
  return true;
}

function beanName(type: TypeDecl): string {
  const annotation = type.annotations.find((candidate) => BEAN_ANNOTATIONS.has(candidate.name));
  const explicit = annotation?.args.get('value');
  if (explicit !== undefined) return stringValue(explicit) ?? '';
  return type.simple.charAt(0).toLowerCase() + type.simple.slice(1);
}

function knownType(name: string): string | undefined {
  const known: Record<string, string> = {
    Mono: 'reactor.core.publisher.Mono', Flux: 'reactor.core.publisher.Flux', UUID: 'java.util.UUID',
    Objects: 'java.util.Objects', Optional: 'java.util.Optional', List: 'java.util.List', Collections: 'java.util.Collections',
    LocalDateTime: 'java.time.LocalDateTime', LocalDate: 'java.time.LocalDate', Instant: 'java.time.Instant', OffsetDateTime: 'java.time.OffsetDateTime',
    BigDecimal: 'java.math.BigDecimal', HttpStatus: 'org.springframework.http.HttpStatus', ResponseEntity: 'org.springframework.http.ResponseEntity',
    String: 'java.lang.String', Integer: 'java.lang.Integer', Long: 'java.lang.Long', Boolean: 'java.lang.Boolean', Math: 'java.lang.Math',
    Collectors: 'java.util.stream.Collectors', Arrays: 'java.util.Arrays',
  };
  return known[name];
}

/** True when an AfterConvertCallback only sets transient fields (safe for list elements). */
/** Class.getName(): nested types use '$'. */
function binaryName(project: JavaProject, fqn: string): string {
  const decl = project.type(fqn);
  if (decl?.outer === undefined) return fqn;
  return `${binaryName(project, decl.outer.fqn)}$${decl.simple}`;
}

function isTransientOnlyCallback(callback: MethodDecl, entity: EntityModel): boolean {
  const text = callback.body?.text ?? '';
  const setters = [...text.matchAll(/\.set([A-Z]\w*)\(/g)].map((match) => match[1]!.charAt(0).toLowerCase() + match[1]!.slice(1));
  return setters.every((name) => entity.transients.has(name) || entity.transients.has(`is${name.charAt(0).toUpperCase()}${name.slice(1)}`));
}

function libraryStaticTry(ev: Evaluator, fqn: string, name: string, args: SV[], node: SyntaxNode, scope: Scope): SV | undefined {
  try {
    return libraryStatic(ev, fqn, name, args, node, scope);
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
}

const CRITERIA_OPERATORS: Readonly<Record<string, CriteriaCondition['cmp']>> = {
  is: 'eq', not: 'ne', lessThan: 'lt', lessThanOrEquals: 'le', greaterThan: 'gt', greaterThanOrEquals: 'ge',
  isNull: 'isNull', isNotNull: 'notNull', in: 'in', between: 'between',
};

/** One step of `where("a").is(x).and("b").isNull()...` and Query.sort()/limit(). */
function criteriaStep(criteria: CriteriaSV, name: string, args: SV[], node: SyntaxNode, ev: Evaluator, scope: Scope): SV {
  const value = (index: number): Expr => {
    const arg = args[index];
    if (arg === undefined) ev.fail(`Criteria.${name}() is missing an argument`, node, scope);
    if (arg.t === 'list') return arg.e;
    if (arg.t !== 'pure') ev.fail(`Criteria.${name}() argument is not a value`, node, scope);
    return arg.e;
  };
  if (criteria.pending !== undefined) {
    const column = criteria.pending;
    const rest = { ...criteria, pending: undefined };
    if (name === 'isTrue' || name === 'isFalse') {
      return { ...rest, conditions: [...criteria.conditions, { column, cmp: 'eq', values: [lit(name === 'isTrue')] }] };
    }
    const cmp = CRITERIA_OPERATORS[name];
    if (cmp === undefined) ev.fail(`Criteria operator ${name}() is not modeled`, node, scope);
    if (cmp === 'in' && args.length !== 1) ev.fail('Criteria.in() with several arguments is not modeled', node, scope);
    const values = cmp === 'isNull' || cmp === 'notNull' ? [] : cmp === 'between' ? [value(0), value(1)] : [value(0)];
    return { ...rest, conditions: [...criteria.conditions, { column, cmp, values }] };
  }
  if (name === 'and' && args.length === 1) {
    const arg = args[0]!;
    if (arg.t === 'pure' && arg.e.k === 'lit' && typeof arg.e.v === 'string') return { ...criteria, pending: arg.e.v };
    if (arg.t === 'criteria' && arg.pending === undefined) return { ...criteria, conditions: [...criteria.conditions, ...arg.conditions] };
  }
  if (name === 'sort' && args.length === 1 && args[0]!.t === 'sort') return { ...criteria, orderBy: [...criteria.orderBy, ...args[0].orders] };
  if (name === 'limit' && args.length === 1 && args[0]!.t === 'pure' && args[0].e.k === 'lit' && typeof args[0].e.v === 'number') {
    return { ...criteria, limit: args[0].e.v };
  }
  ev.fail(`Criteria/Query.${name}() is not modeled`, node, scope);
}

export { mergeEmission };
