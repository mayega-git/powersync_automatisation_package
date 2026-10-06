import type { Expr, Instr } from '../../ir/types.js';
import { and, cond, exprEqual, FALSE, isLit, not, NULL, or, pure, TRUE, Unsupported, type Block, type Emission, type ObjSV, type SV } from './sv.js';

/** Thrown when evaluation reaches an unconditional exception: the path never completes. */
export class Diverged extends Error {
  constructor() {
    super('diverged');
    this.name = 'Diverged';
  }
}

/** Variables an instruction list defines at its top level (visible after it). */
export function definedNames(instrs: readonly Instr[]): Set<string> {
  const out = new Set<string>();
  for (const instr of instrs) {
    if (instr.op === 'QUERY' || instr.op === 'LET') out.add(instr.out);
    else if ((instr.op === 'INSERT' || instr.op === 'UPDATE') && instr.out !== undefined) out.add(instr.out);
    else if (instr.op === 'EACH') out.add(instr.out);
    else if (instr.op === 'TRY') {
      const left = definedNames(instr.body);
      const right = definedNames(instr.fallback);
      if (endsAbruptly(instr.body)) for (const name of right) out.add(name);
      else for (const name of right) if (left.has(name)) out.add(name);
    } else if (instr.op === 'IF') {
      // A branch that never completes does not constrain what is defined after the IF.
      const thenEnds = endsAbruptly(instr.then);
      const elseEnds = endsAbruptly(instr.else);
      const left = definedNames(instr.then);
      const right = definedNames(instr.else);
      if (thenEnds && !elseEnds) for (const name of right) out.add(name);
      else if (elseEnds && !thenEnds) for (const name of left) out.add(name);
      else for (const name of right) if (left.has(name)) out.add(name);
    }
  }
  return out;
}

function endsAbruptly(instrs: readonly Instr[]): boolean {
  const last = instrs.at(-1);
  if (last === undefined) return false;
  if (last.op === 'RETURN') return true;
  if (last.op === 'ASSERT' && isLit(last.test, false)) return true;
  if (last.op === 'IF') return endsAbruptly(last.then) && endsAbruptly(last.else);
  if (last.op === 'TRY') return endsAbruptly(last.fallback);
  return false;
}

/**
 * Emits IF(test, then, else) so that every variable defined in one branch is
 * also defined (as null) in the other. Values computed in a branch are only
 * ever read under the same condition (through `cond`), so the placeholders
 * are never observed, and the program stays valid for the IR validator.
 */
export function emitIf(block: Block, test: Expr, thenInstrs: Instr[], elseInstrs: Instr[]): void {
  if (isLit(test, true)) {
    for (const instr of thenInstrs) block.emit(instr);
    return;
  }
  if (isLit(test, false)) {
    for (const instr of elseInstrs) block.emit(instr);
    return;
  }
  if (thenInstrs.length === 0 && elseInstrs.length === 0) return;
  // IF(c) { throw } else {}  ==>  ASSERT(!c)
  const onlyThrow = (instrs: Instr[]) => instrs.length === 1 && instrs[0]!.op === 'ASSERT' && isLit(instrs[0]!.test, false);
  if (onlyThrow(thenInstrs) && elseInstrs.length === 0) {
    const thrown = thenInstrs[0] as Extract<Instr, { op: 'ASSERT' }>;
    block.emit({ op: 'ASSERT', test: not(test), error: thrown.error });
    return;
  }
  if (onlyThrow(elseInstrs) && thenInstrs.length === 0) {
    const thrown = elseInstrs[0] as Extract<Instr, { op: 'ASSERT' }>;
    block.emit({ op: 'ASSERT', test, error: thrown.error });
    return;
  }
  const inThen = definedNames(thenInstrs);
  const inElse = definedNames(elseInstrs);
  if (!endsAbruptly(elseInstrs)) for (const name of inThen) if (!inElse.has(name)) elseInstrs.push({ op: 'LET', out: name, expr: NULL });
  if (!endsAbruptly(thenInstrs)) for (const name of inElse) if (!inThen.has(name)) thenInstrs.push({ op: 'LET', out: name, expr: NULL });
  block.emit({ op: 'IF', test, then: thenInstrs, else: elseInstrs });
}

export type Outcome<T> = { ok: true; value: T } | { ok: false };

/** Runs `work` into a child block, catching divergence. */
export function attempt<T>(block: Block, work: (child: Block) => T): { outcome: Outcome<T>; instrs: Instr[] } {
  const child = block.child();
  try {
    return { outcome: { ok: true, value: work(child) }, instrs: child.instrs };
  } catch (error) {
    if (error instanceof Diverged) return { outcome: { ok: false }, instrs: child.instrs };
    throw error;
  }
}

/**
 * Two-way branch producing a merged value. A diverging side contributes
 * nothing; if both diverge, the divergence propagates.
 */
export function branch<T>(
  block: Block,
  test: Expr,
  onThen: (child: Block) => T,
  onElse: (child: Block) => T,
  merge: (test: Expr, a: T, b: T) => T,
): T {
  if (isLit(test, true)) return onThen(block);
  if (isLit(test, false)) return onElse(block);
  // Each side starts from the same object state; mutations are merged under the test afterwards.
  const states = block.counters.objects;
  const before = states?.snapshot();
  const left = attempt(block, onThen);
  const leftState = states?.snapshot();
  if (before !== undefined) states!.restore(before);
  const right = attempt(block, onElse);
  const rightState = states?.snapshot();
  emitIf(block, test, left.instrs, right.instrs);
  if (left.outcome.ok && right.outcome.ok) {
    if (states !== undefined) states.merge(test, before!, leftState!, rightState!, block);
    return merge(test, left.outcome.value, right.outcome.value);
  }
  if (left.outcome.ok) {
    if (states !== undefined) states.restore(leftState!);
    return left.outcome.value;
  }
  if (right.outcome.ok) return right.outcome.value;
  throw new Diverged();
}

/** Merges two emissions of the same Mono shape. */
export function mergeEmission(test: Expr, a: Emission, b: Emission, mergeValue: (test: Expr, a: SV, b: SV) => SV): Emission {
  const value = a.value.t === 'void' && isLit(a.empty, true) ? b.value
    : b.value.t === 'void' && isLit(b.empty, true) ? a.value
      : mergeValue(test, a.value, b.value);
  return { value, empty: simplifyCond(test, a.empty, b.empty) };
}

export function simplifyCond(test: Expr, a: Expr, b: Expr): Expr {
  if (exprEqual(a, b)) return a;
  if (isLit(a, true) && isLit(b, false)) return test;
  if (isLit(a, false) && isLit(b, true)) return not(test);
  if (isLit(a, false)) return and(not(test), b);
  if (isLit(b, false)) return and(test, a);
  if (isLit(a, true)) return or(test, b);
  if (isLit(b, true)) return or(not(test), a);
  return cond(test, a, b);
}

export function asBool(sv: SV, what: string): Expr {
  if (sv.t === 'pure') return sv.e;
  throw new Unsupported(`${what} is not a boolean expression.`);
}

export function snapshotObjects(objects: readonly ObjSV[]): Map<ObjSV, Map<string, SV>> {
  return new Map(objects.map((object) => [object, new Map(object.fields)]));
}

export function restoreObjects(snapshot: Map<ObjSV, Map<string, SV>>): void {
  for (const [object, fields] of snapshot) {
    object.fields.clear();
    for (const [name, value] of fields) object.fields.set(name, value);
  }
}

export const LIT_TRUE = TRUE;
export const LIT_FALSE = FALSE;
export { pure };

/**
 * The value of a per-element function as one expression: its pure bindings
 * (LETs, IFs choosing between them) are folded in; anything else is refused.
 */
export function pureValue(instrs: readonly Instr[], value: SV): SV | undefined {
  if (instrs.length === 0) return value;
  if (value.t !== 'pure') return undefined;
  try {
    return { ...value, e: foldPureInstrs(instrs, [value.e])[0]! };
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
}

/**
 * Folds instructions that only bind values (LETs, and IFs choosing between
 * LET values) into the given expressions, so they can be used where a single
 * expression is required (policy checks, filter predicates).
 */
export function foldPureInstrs(instrs: readonly Instr[], exprs: readonly Expr[]): Expr[] {
  const substitute = (node: unknown, bound: ReadonlyMap<string, Expr>): unknown => {
    if (Array.isArray(node)) return node.map((child) => substitute(child, bound));
    if (node === null || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    if (record.k === 'var' && typeof record.name === 'string' && bound.has(record.name)) return bound.get(record.name);
    if (record.k === 'lit') return node;
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, substitute(child, bound)]));
  };
  const run = (list: readonly Instr[], outer: ReadonlyMap<string, Expr>): Map<string, Expr> => {
    const bound = new Map(outer);
    for (const instr of list) {
      if (instr.op === 'LET') {
        bound.set(instr.out, substitute(instr.expr, bound) as Expr);
      } else if (instr.op === 'IF') {
        const test = substitute(instr.test, bound) as Expr;
        const left = run(instr.then, bound);
        const right = run(instr.else ?? [], bound);
        for (const name of new Set([...left.keys(), ...right.keys()])) {
          const a = left.get(name) ?? NULL;
          const b = right.get(name) ?? NULL;
          bound.set(name, a === b ? a : cond(test, a, b));
        }
      } else {
        throw new Unsupported(`The code has effects (${instr.op})`);
      }
    }
    return bound;
  };
  const bound = run(instrs, new Map());
  return exprs.map((expr) => substitute(expr, bound) as Expr);
}
