import type { Expr, Filter, Instr } from '../ir/types.js';
import { canonicalJson } from '../ir/canonical.js';

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

/**
 * A query restricted to the rows belonging to one row of `entity`: the
 * observable rows are those whose `field` equals that row's key. `pairs` are
 * the scope pairs proven for that parent row, so the proof only holds when
 * they cover the parent's own scope.
 */
export interface ParentCandidate {
  field: string;
  entity: string;
  pairs: Set<ScopePair>;
}

export interface QueryGuard {
  entity: string;
  /** Pairs every row the program can observe is known to satisfy. */
  pairs: Set<ScopePair>;
  /** Parent rows this query is restricted to, when it is. */
  parents: ParentCandidate[];
}

/**
 * For every QUERY in a program, the scope pairs that hold for what the program
 * can observe: the query's own filters, or for a single-row lookup, the test
 * of the first instruction that looks at the row (a 404 guard). A row looked
 * at before such a guard counts as unguarded.
 */
export function queryGuards(program: readonly Instr[], keys?: ReadonlyMap<string, string>): QueryGuard[] {
  const out: QueryGuard[] = [];
  // Single-row reads, so a later re-read of the same row by key inherits their proof.
  const rows = new Map<string, { entity: string; pairs: Set<ScopePair>; keyExpr?: Expr }>();
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
      const parents = parentCandidates(instr.entity, instr.where, rows, keys);
      const key = keys?.get(instr.entity);
      if (instr.mode === 'one') {
        const guard = firstUse(block.slice(index + 1), instr.out);
        if (guard !== undefined) for (const pair of impliedPairs(guard, instr.out)) pairs.add(pair);
        // `key = earlier.key` with `earlier` a single-row read of the same entity: the same row, already proven.
        const [filter] = instr.where;
        if (instr.where.length === 1 && filter !== undefined && key !== undefined && filter.field === key && filter.cmp === 'eq'
          && filter.value?.k === 'get' && filter.value.field === key && filter.value.of.k === 'var') {
          const earlier = rows.get(filter.value.of.name);
          if (earlier?.entity === instr.entity) for (const pair of earlier.pairs) pairs.add(pair);
        }
        const byKey = key === undefined ? undefined : instr.where.find((candidate) => candidate.field === key && candidate.cmp === 'eq' && candidate.value !== undefined);
        rows.set(instr.out, { entity: instr.entity, pairs, ...(byKey?.value === undefined ? {} : { keyExpr: byKey.value }) });
        // Read by its own key and nothing else: the proof may still come from
        // the parent the program resolves immediately afterwards.
        if (byKey !== undefined && instr.where.length === 1 && parents.length === 0 && guard !== undefined) {
          const before = parentBeforeRead(guard, instr.out, rows);
          if (before !== undefined && before.entity !== instr.entity) parents.push(before);
        }
        if (byKey !== undefined && instr.where.length === 1 && parents.length === 0) {
          const after = parentAfterRead(instr.entity, instr.out, block.slice(index + 1), keys,
            (where, guard, row) => {
              const proven = filterPairs(where);
              for (const pair of impliedPairs(guard, row)) proven.add(pair);
              return proven;
            });
          if (after !== undefined) parents.push(after);
        }
      }
      out.push({ entity: instr.entity, pairs, parents });
    });
  };
  visit(program);
  return out;
}

/**
 * Parents a query is restricted to: a filter `field = <parent row>.<parent key>`,
 * or `field = <the very expression an earlier single-row read of the parent used
 * as its key>` (the `GET /parents/{id}/children` shape, where both the parent
 * lookup and the children query use the same path variable).
 */
function parentCandidates(
  entity: string,
  where: readonly Filter[],
  rows: ReadonlyMap<string, { entity: string; pairs: Set<ScopePair>; keyExpr?: Expr }>,
  keys?: ReadonlyMap<string, string>,
): ParentCandidate[] {
  const out: ParentCandidate[] = [];
  for (const filter of where) {
    const value = filter.value;
    if (filter.cmp !== 'eq' || value === undefined) continue;
    if (value.k === 'get' && value.of.k === 'var') {
      const row = rows.get(value.of.name);
      if (row !== undefined && row.entity !== entity && keys?.get(row.entity) === value.field) {
        out.push({ field: filter.field, entity: row.entity, pairs: row.pairs });
        continue;
      }
    }
    const text = canonicalJson(value);
    for (const row of rows.values()) {
      if (row.entity === entity || row.keyExpr === undefined || canonicalJson(row.keyExpr) !== text) continue;
      out.push({ field: filter.field, entity: row.entity, pairs: row.pairs });
      break;
    }
  }
  return out;
}

/**
 * A child read by its own key, whose parent is checked straight after:
 *
 *     child = findById(id)          // nothing proven yet
 *     assert child != null  -> E    // the 404 guard
 *     parent = findById(child.f)    // the parent decides who may see the child
 *     assert parent in scope -> E   // the very same error
 *
 * Sound because a device holds exactly the children of the parents it can see.
 * When the parent is out of scope the server reaches its own guard while the
 * device never finds the child at all, so the two guards must raise the *same*
 * error — otherwise the bodies differ and the answers diverge. Requiring that
 * is also what keeps the backend from telling a caller that a row it may not
 * see exists. Nothing may be written before the parent is proven, or the
 * server would have written it for a child the device refused outright.
 */
function parentAfterRead(
  entity: string,
  out: string,
  rest: readonly Instr[],
  keys: ReadonlyMap<string, string> | undefined,
  pairsOf: (where: readonly Filter[], guard: Expr, row: string) => Set<ScopePair>,
): ParentCandidate | undefined {
  const childGuard = firstAssert(rest, out);
  if (childGuard === undefined) return undefined;
  for (const [index, instr] of rest.entries()) {
    if (instr.op === 'INSERT' || instr.op === 'UPDATE' || instr.op === 'DELETE' || instr.op === 'QUEUE_INTENT') return undefined;
    if (instr.op !== 'QUERY' || instr.mode !== 'one' || instr.entity === entity) continue;
    const parentKey = keys?.get(instr.entity);
    const [filter, ...others] = instr.where;
    if (parentKey === undefined || others.length > 0 || filter === undefined || filter.field !== parentKey || filter.cmp !== 'eq') continue;
    const value = filter.value;
    if (value?.k !== 'get' || value.of.k !== 'var' || value.of.name !== out) continue;
    const parentGuard = firstAssert(rest.slice(index + 1), instr.out);
    if (parentGuard === undefined || canonicalJson(childGuard.error) !== canonicalJson(parentGuard.error)) return undefined;
    return { field: value.field, entity: instr.entity, pairs: pairsOf(instr.where, parentGuard.test, instr.out) };
  }
  return undefined;
}

/**
 * The other order, and the safer one: the parent is read and proven *before*
 * the child, and a single guard rejects both a missing child and one belonging
 * elsewhere — what `findChild(id).filter(c -> c.f == parent.key).switchIfEmpty(e)`
 * compiles to. Because one assertion covers both, the two can never raise
 * different errors, so nothing has to be compared.
 */
function parentBeforeRead(
  guard: Expr,
  row: string,
  rows: ReadonlyMap<string, { entity: string; pairs: Set<ScopePair>; keyExpr?: Expr }>,
): ParentCandidate | undefined {
  // The guard must also be what rejects an absent row, or the two paths part ways.
  if (!mentionsEmptiness(guard, row)) return undefined;
  for (const conjunct of conjuncts(guard)) {
    if (conjunct.k !== 'op' || conjunct.op !== 'eq') continue;
    const [a, b] = conjunct.args as [Expr, Expr];
    const fieldOf = (side: Expr) => (side.k === 'get' && side.of.k === 'var' && side.of.name === row ? side.field : undefined);
    const field = fieldOf(a) ?? fieldOf(b);
    const other = fieldOf(a) === undefined ? a : b;
    if (field === undefined) continue;
    const text = canonicalJson(other);
    for (const candidate of rows.values()) {
      if (candidate.keyExpr === undefined || canonicalJson(candidate.keyExpr) !== text) continue;
      return { field, entity: candidate.entity, pairs: candidate.pairs };
    }
  }
  return undefined;
}

/** Whether `test` is false when `row` is absent, so one guard covers both. */
function mentionsEmptiness(test: Expr, row: string): boolean {
  const seek = (expr: Expr): boolean => {
    if (expr.k === 'op') {
      if (expr.op === 'isNull' && expr.args[0]?.k === 'var' && expr.args[0].name === row) return true;
      return expr.args.some(seek);
    }
    if (expr.k === 'cond') return seek(expr.test) || seek(expr.then) || seek(expr.else);
    return false;
  };
  return seek(test);
}

/** The first instruction referencing `row`, when it is an ASSERT carrying its error. */
function firstAssert(rest: readonly Instr[], row: string): { test: Expr; error: unknown } | undefined {
  for (const instr of rest) {
    if (!mentions(instr, row)) continue;
    return instr.op === 'ASSERT' ? { test: instr.test, error: instr.error } : undefined;
  }
  return undefined;
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
