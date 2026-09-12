import type { OperationMapping } from './OperationMapping.js';

export type MatchStatus = 'Matched' | 'Ambiguous' | 'NotFound';

export interface PathMatchResult {
  status: MatchStatus;
  /** Set only when `status === 'Matched'`. */
  operation?: OperationMapping;
  /** One entry if `Matched`, several if `Ambiguous`. */
  candidates: readonly OperationMapping[];
  pathParams: Readonly<Record<string, string>>;
}

/** Param names are per-operation: two operations can name the same hole differently. */
interface IndexedOperation {
  operation: OperationMapping;
  paramNames: string[];
}

interface Node {
  literals: Map<string, Node>;
  /** At most one variable segment per node: position structures the index, not the name. */
  param?: Node;
  operations: IndexedOperation[];
}

function emptyNode(): Node {
  return { literals: new Map(), operations: [] };
}

export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

interface Candidate {
  operation: OperationMapping;
  pathParams: Record<string, string>;
}

export class PathMatchIndex {
  /** One root per HTTP method. */
  private constructor(private readonly roots: Map<string, Node>) {}

  static build(operations: readonly OperationMapping[]): PathMatchIndex {
    const roots = new Map<string, Node>();

    for (const op of operations) {
      const method = op.method.toUpperCase();
      let node = roots.get(method);
      if (node === undefined) {
        node = emptyNode();
        roots.set(method, node);
      }

      const paramNames: string[] = [];

      for (const segment of splitPath(op.path)) {
        const name = paramName(segment);
        if (name !== undefined) {
          paramNames.push(name);
          if (node.param === undefined) {
            node.param = emptyNode();
          }
          node = node.param;
        } else {
          let next = node.literals.get(segment);
          if (next === undefined) {
            next = emptyNode();
            node.literals.set(segment, next);
          }
          node = next;
        }
      }

      node.operations.push({ operation: op, paramNames });
    }

    return new PathMatchIndex(roots);
  }

  match(method: string, segments: readonly string[]): PathMatchResult {
    const root = this.roots.get(method.toUpperCase());
    if (root === undefined) {
      return { status: 'NotFound', candidates: [], pathParams: {} };
    }

    const found = descend(root, segments, 0, []);

    if (found.length === 0) {
      return { status: 'NotFound', candidates: [], pathParams: {} };
    }
    if (found.length === 1) {
      const only = found[0]!;
      return {
        status: 'Matched',
        operation: only.operation,
        candidates: [only.operation],
        pathParams: only.pathParams,
      };
    }
    return {
      status: 'Ambiguous',
      candidates: found.map((c) => c.operation),
      pathParams: {},
    };
  }
}

function paramName(segment: string): string | undefined {
  if (segment.length > 2 && segment.startsWith('{') && segment.endsWith('}')) {
    return segment.slice(1, -1);
  }
  return undefined;
}

function descend(
  node: Node,
  segments: readonly string[],
  position: number,
  captured: readonly string[],
): Candidate[] {
  if (position === segments.length) {
    return node.operations.map(({ operation, paramNames }) => {
      const pathParams: Record<string, string> = {};
      paramNames.forEach((name, i) => {
        const value = captured[i];
        if (value !== undefined) pathParams[name] = value;
      });
      return { operation, pathParams };
    });
  }

  const segment = segments[position]!;

  const literal = node.literals.get(segment);
  if (literal !== undefined) {
    const viaLiteral = descend(literal, segments, position + 1, captured);
    if (viaLiteral.length > 0) {
      return viaLiteral;
    }
  }

  if (node.param !== undefined) {
    return descend(node.param, segments, position + 1, [...captured, segment]);
  }

  return [];
}
