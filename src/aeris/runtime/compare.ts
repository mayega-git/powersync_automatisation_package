import type { EndpointPlan, Instr, JsonValue } from '../ir/types.js';
import { canonicalJson } from '../ir/canonical.js';
import { isUuid } from './values.js';

export interface ComparisonResult {
  equal: boolean;
  differences: string[];
}

const TEMPORAL = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Compares a local result with the backend's for the same input. Values the
 * two sides generate independently (identifiers from captured uuid slots,
 * captured timestamps) are compared by shape only; everything else must be
 * equal. Lists compare as multisets unless the program orders them.
 */
export function compareResults(
  plan: EndpointPlan,
  local: { status: number; body: JsonValue | null },
  server: { status: number; body: JsonValue | null },
  options: { generated?: ReadonlySet<string>; errorBodies?: boolean } = {},
): ComparisonResult {
  const differences: string[] = [];
  if (local.status !== server.status) differences.push(`status: local ${local.status}, server ${server.status}`);
  const isError = local.status >= 400 || server.status >= 400;
  if (!isError || options.errorBodies === true) {
    const ordered = programOrders(plan.program ?? []);
    compareValue(local.body, server.body, '$', differences, {
      ordered,
      generated: options.generated ?? new Set(),
      fuzzyTime: usesClock(plan.program ?? []),
    });
  }
  return { equal: differences.length === 0, differences };
}

interface Options {
  ordered: boolean;
  generated: ReadonlySet<string>;
  fuzzyTime: boolean;
}

function compareValue(local: JsonValue | null | undefined, server: JsonValue | null | undefined, path: string, out: string[], options: Options): void {
  if (out.length > 50) return;
  const a = local ?? null;
  const b = server ?? null;
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return;
    if (isUuid(a) && isUuid(b) && (a.toLowerCase() === b.toLowerCase() || options.generated.has(a.toLowerCase()))) return;
    if (options.fuzzyTime && TEMPORAL.test(a) && TEMPORAL.test(b)) return;
    out.push(`${path}: local ${JSON.stringify(a)}, server ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: local has ${a.length} items, server ${b.length}`);
      return;
    }
    if (options.ordered) {
      a.forEach((item, index) => compareValue(item, b[index], `${path}[${index}]`, out, options));
      return;
    }
    const remaining = [...b];
    for (const [index, item] of a.entries()) {
      const match = remaining.findIndex((candidate) => {
        const probe: string[] = [];
        compareValue(item, candidate, '', probe, options);
        return probe.length === 0;
      });
      if (match === -1) out.push(`${path}[${index}]: no matching server item for ${canonicalJson(item)}`);
      else remaining.splice(match, 1);
    }
    return;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      compareValue((a as Record<string, JsonValue>)[key], (b as Record<string, JsonValue>)[key], `${path}.${key}`, out, options);
    }
    return;
  }
  if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b))) return;
  if (a !== b) out.push(`${path}: local ${JSON.stringify(a)}, server ${JSON.stringify(b)}`);
}

function programOrders(program: readonly Instr[]): boolean {
  return walk(program).some((instr) => instr.op === 'QUERY' && (instr.orderBy?.length ?? 0) > 0);
}

function usesClock(program: readonly Instr[]): boolean {
  return JSON.stringify(program).includes('"k":"now"');
}

export function walk(program: readonly Instr[]): Instr[] {
  const out: Instr[] = [];
  for (const instr of program) {
    out.push(instr);
    if (instr.op === 'IF') out.push(...walk(instr.then), ...walk(instr.else));
  }
  return out;
}
