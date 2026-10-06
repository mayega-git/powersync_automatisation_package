import type { Expr, Filter, Instr } from '../ir/types.js';

/** A (property, claim) pair: `row.property == session.claim`. */
export type ScopePair = string;

export function pairKey(field: string, claim: string): ScopePair {
  return `${field}=${claim}`;
}

/** Pushes negations inward and flattens conjunctions. */
function conjuncts(expr: Expr, negated = false): Expr[] {
  if (expr.k === 'op' && expr.op === 'not') return conjuncts(expr.args[0]!, !negated);
  if (expr.k === 'op' && expr.op === (negated ? 'or' : 'and')) return expr.args.flatMap((arg) => conjuncts(arg, negated));
  if (negated) {
    if (expr.k === 'op' && expr.op === 'isNull') return [{ k: 'op', op: 'notNull', args: expr.args }];
    if (expr.k === 'op' && expr.op === 'notNull') return [{ k: 'op', op: 'isNull', args: expr.args }];
    if (expr.k === 'op' && expr.op === 'ne') return [{ k: 'op', op: 'eq', args: expr.args }];
    return [{ k: 'op', op: 'not', args: [expr] }];
  }
  return [expr];
}

/** Scope pairs a boolean test guarantees for the row held in variable `row`. */
export function impliedPairs(test: Expr, row: string): Set<ScopePair> {
  const out = new Set<ScopePair>();
  for (const conjunct of conjuncts(test)) {
    if (conjunct.k !== 'op' || conjunct.op !== 'eq') continue;
    const [a, b] = conjunct.args as [Expr, Expr];
    const fieldOf = (side: Expr) => (side.k === 'get' && side.of.k === 'var' && side.of.name === row ? side.field : undefined);
    const claimOf = (side: Expr) => (side.k === 'ctx' ? side.name : undefined);
    const field = fieldOf(a) ?? fieldOf(b);
    const claim = claimOf(a) ?? claimOf(b);
    if (field !== undefined && claim !== undefined) out.add(pairKey(field, claim));
  }
  return out;
}

function filterPairs(filters: readonly Filter[]): Set<ScopePair> {
  const out = new Set<ScopePair>();
  for (const filter of filters) {
    if (filter.cmp === 'eq' && filter.value?.k === 'ctx') out.add(pairKey(filter.field, filter.value.name));
  }
  return out;
}

function mentions(value: unknown, variable: string): boolean {
  if (Array.isArray(value)) return value.some((item) => mentions(item, variable));
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.k === 'var' && record.name === variable) return true;
    return Object.values(record).some((item) => mentions(item, variable));
  }
  return false;
}

export interface QueryGuard {
  entity: string;
  /** Pairs every row the program can observe is known to satisfy. */
  pairs: Set<ScopePair>;
}

/**
 * For every QUERY in a program, the scope pairs that hold for what the program
 * can observe: the query's own filters, or for a single-row lookup, the test
 * of the first instruction that looks at the row (a 404 guard). A row looked
 * at before such a guard counts as unguarded.
 */
export function queryGuards(program: readonly Instr[]): QueryGuard[] {
  const out: QueryGuard[] = [];
  const visit = (block: readonly Instr[]) => {
    block.forEach((instr, index) => {
      if (instr.op === 'IF') {
        visit(instr.then);
        visit(instr.else);
        return;
      }
      if (instr.op === 'TRY') {
        visit(instr.body);
        visit(instr.fallback);
        return;
      }
      if (instr.op === 'EACH') {
        visit(instr.body);
        return;
      }
      if (instr.op !== 'QUERY') return;
      const pairs = filterPairs(instr.where);
      if (instr.mode === 'one') {
        const guard = firstUse(block.slice(index + 1), instr.out);
        if (guard !== undefined) for (const pair of impliedPairs(guard, instr.out)) pairs.add(pair);
      }
      out.push({ entity: instr.entity, pairs });
    });
  };
  visit(program);
  return out;
}

/** Test of the first instruction referencing `row`, when it is an ASSERT or IF condition. */
function firstUse(rest: readonly Instr[], row: string): Expr | undefined {
  for (const instr of rest) {
    if (!mentions(instr, row)) continue;
    if (instr.op === 'ASSERT') return instr.test;
    if (instr.op === 'IF') {
      if (mentions(instr.test, row)) return instr.test;
      // The row is first used inside a branch: guarded only if both branches guard it first.
      const left = firstUse(instr.then, row);
      const right = firstUse(instr.else, row);
      if (left === undefined || right === undefined) return undefined;
      const common = [...impliedPairs(left, row)].filter((pair) => impliedPairs(right, row).has(pair));
      return common.length === 0 ? undefined : left;
    }
    return undefined;
  }
  return undefined;
}

/** Claims an INSERT sets from the session for each property. */
export function insertedPairs(program: readonly Instr[], entity: string): Set<ScopePair> {
  const out = new Set<ScopePair>();
  const visit = (block: readonly Instr[]) => {
    for (const instr of block) {
      if (instr.op === 'IF') {
        visit(instr.then);
        visit(instr.else);
      } else if (instr.op === 'INSERT' && instr.entity === entity) {
        for (const [field, value] of Object.entries(instr.values)) {
          if (value.k === 'ctx') out.add(pairKey(field, value.name));
        }
      }
    }
  };
  visit(program);
  return out;
}
