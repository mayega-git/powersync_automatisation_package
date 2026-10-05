import type { EndpointPlan, HttpMethod } from '../ir/types.js';

export interface RouteMatch {
  plan: EndpointPlan;
  params: Record<string, string>;
}

interface Node {
  literals: Map<string, Node>;
  param?: { name: string; node: Node };
  plans: Map<HttpMethod, EndpointPlan>;
  ambiguous?: Set<HttpMethod>;
}

function node(): Node {
  return { literals: new Map(), plans: new Map() };
}

/**
 * Compiled route table (a trie). Literal segments win over variables, as in
 * Spring's PathPattern specificity, and a trailing slash does not match
 * (Spring 6 default).
 */
export class EndpointRouter {
  private readonly root = node();
  /** Routes declared twice with the same shape: never matched, the request goes to the network. */
  readonly ambiguous: string[] = [];

  constructor(plans: readonly EndpointPlan[]) {
    for (const plan of plans) this.add(plan);
  }

  private add(plan: EndpointPlan): void {
    const segments = split(plan.path);
    if (segments === undefined) throw new Error(`Invalid route template ${plan.path}.`);
    let current = this.root;
    for (const segment of segments) {
      const variable = /^\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}$/.exec(segment);
      if (variable !== null) {
        // Variable names may differ between templates sharing this position;
        // match() re-derives them from the matched template.
        if (current.param === undefined) current.param = { name: variable[1]!, node: node() };
        current = current.param.node;
      } else {
        let next = current.literals.get(segment);
        if (next === undefined) {
          next = node();
          current.literals.set(segment, next);
        }
        current = next;
      }
    }
    const existing = current.plans.get(plan.method);
    if (existing === undefined) {
      current.plans.set(plan.method, plan);
      return;
    }
    this.ambiguous.push(plan.id, existing.id);
    current.ambiguous ??= new Set();
    current.ambiguous.add(plan.method);
  }

  match(method: string, path: string): RouteMatch | undefined {
    const segments = split(path);
    if (segments === undefined) return undefined;
    const found = this.walk(this.root, segments, 0, [], method.toUpperCase() as HttpMethod);
    if (found === undefined) return undefined;
    // Re-derive parameter names from the matched template itself.
    const names = split(found.plan.path)!
      .map((segment) => /^\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}$/.exec(segment)?.[1])
      .filter((name): name is string => name !== undefined);
    const params: Record<string, string> = {};
    names.forEach((name, index) => {
      params[name] = found.values[index]!;
    });
    return { plan: found.plan, params };
  }

  private walk(current: Node, segments: readonly string[], index: number, values: string[], method: HttpMethod):
    { plan: EndpointPlan; values: string[] } | undefined {
    if (index === segments.length) {
      if (current.ambiguous?.has(method)) return undefined;
      const plan = current.plans.get(method) ?? (method === 'HEAD' ? current.plans.get('GET') : undefined);
      return plan === undefined ? undefined : { plan, values };
    }
    const segment = segments[index]!;
    const literal = current.literals.get(segment);
    if (literal !== undefined) {
      const found = this.walk(literal, segments, index + 1, values, method);
      if (found !== undefined) return found;
    }
    if (current.param !== undefined && segment.length > 0) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return undefined;
      }
      return this.walk(current.param.node, segments, index + 1, [...values, decoded], method);
    }
    return undefined;
  }
}

function split(path: string): string[] | undefined {
  if (!path.startsWith('/')) return undefined;
  if (path === '/') return [];
  if (path.endsWith('/')) return undefined;
  return path.slice(1).split('/');
}
