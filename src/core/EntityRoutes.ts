import type { OperationMapping } from './OperationMapping.js';
import { PathMatchIndex, splitPath } from './PathMatchIndex.js';

export class EntityRoutesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityRoutesError';
  }
}

/** A string is a prefix (rule 1); an array is a list of `METHOD /path/{hole}` lines (rule 2). */
export type EntityRule = string | readonly string[];

export type EntitiesDeclaration = Readonly<Record<string, EntityRule>>;

export interface DeclaredPath {
  kind: 'prefix' | 'path';
  path: string;
}

export interface ResolvedEntity {
  table: string;
  /** Named holes under rule 2 (`{blogId}`); the segment after the prefix is `id` under rule 1. */
  pathParams: Readonly<Record<string, string>>;
  rule: 1 | 2;
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

interface Prefix {
  table: string;
  segments: string[];
}

export class EntityRoutes {
  private constructor(
    private readonly index: PathMatchIndex,
    /** Longest first: the most specific prefix answers first. */
    private readonly prefixes: readonly Prefix[],
    private readonly tableByOperation: ReadonlyMap<string, string>,
  ) {}

  static build(declaration: EntitiesDeclaration): EntityRoutes {
    const operations: OperationMapping[] = [];
    const tableByOperation = new Map<string, string>();
    const prefixes: Prefix[] = [];
    const seenPrefixes = new Map<string, string>();

    for (const [table, rule] of Object.entries(declaration)) {
      if (typeof rule === 'string') {
        const path = normalizePath(table, rule);
        const existing = seenPrefixes.get(path);
        if (existing !== undefined) {
          throw new EntityRoutesError(
            `The prefix ${path} is declared twice: by ${existing} and by ` +
              `${table}. A request can't belong to two tables.`,
          );
        }
        seenPrefixes.set(path, table);
        prefixes.push({ table, segments: splitPath(path) });
        continue;
      }

      if (!Array.isArray(rule)) {
        throw new EntityRoutesError(
          `Table ${table} declares something other than a prefix or a list of ` +
            'requests. The only two accepted forms are "/api/..." and a list ' +
            'of "METHOD /api/...".',
        );
      }

      for (const line of rule) {
        const parsedRequests = parseDeclaredLine(table, line);
        for (const { method, path } of parsedRequests) {
          const key = `${method} ${path}`;
          const existing = tableByOperation.get(key);
          if (existing !== undefined) {
            throw new EntityRoutesError(
              `${key} is declared twice: by ${existing} and by ${table}. A ` +
                "request can't belong to two tables.",
            );
          }
          tableByOperation.set(key, table);
          operations.push({
            operationId: key,
            method,
            path,
            connectivity: 'offline',
            handle: key,
          });
        }
      }
    }

    for (const prefix of prefixes) {
      for (const [key, table] of tableByOperation) {
        if (table === prefix.table) continue;
        const path = key.slice(key.indexOf(' ') + 1);
        if (pathStartsWith(splitPath(path), prefix.segments)) {
          throw new EntityRoutesError(
            `The prefix of ${prefix.table} (/${prefix.segments.join('/')}) ` +
              `covers ${key}, which is declared under ${table}. Narrow the ` +
              'prefix, or put both under the same table.',
          );
        }
      }
    }

    prefixes.sort((a, b) => b.segments.length - a.segments.length);
    return new EntityRoutes(
      PathMatchIndex.build(operations),
      prefixes,
      tableByOperation,
    );
  }

  tables(): string[] {
    const names = new Set<string>(this.prefixes.map((p) => p.table));
    for (const table of this.tableByOperation.values()) names.add(table);
    return [...names].sort();
  }

  paths(): DeclaredPath[] {
    const list: DeclaredPath[] = this.prefixes.map((p) => ({
      kind: 'prefix' as const,
      path: `/${p.segments.join('/')}`,
    }));
    const seen = new Set<string>();
    for (const key of this.tableByOperation.keys()) {
      const path = key.slice(key.indexOf(' ') + 1);
      if (seen.has(path)) continue;
      seen.add(path);
      list.push({ kind: 'path', path });
    }
    return list;
  }

  resolve(method: string, pathname: string): ResolvedEntity | undefined {
    const normalizedMethod = method.toUpperCase();
    const segments = splitPath(pathname);

    const matched = this.index.match(normalizedMethod, segments);
    if (matched.status === 'Matched' && matched.operation !== undefined) {
      const table = this.tableByOperation.get(matched.operation.operationId);
      if (table !== undefined) {
        return { table, pathParams: matched.pathParams, rule: 2 };
      }
    }

    if (!METHODS.has(normalizedMethod)) return undefined;

    for (const prefix of this.prefixes) {
      if (!pathStartsWith(segments, prefix.segments)) continue;
      const rest = segments.slice(prefix.segments.length);

      if (rest.length === 0) {
        return { table: prefix.table, pathParams: {}, rule: 1 };
      }
      if (rest.length === 1) {
        return {
          table: prefix.table,
          pathParams: { id: decodeSegment(rest[0]!) },
          rule: 1,
        };
      }
      return undefined;
    }

    return undefined;
  }
}

function normalizePath(table: string, raw: string): string {
  const path = raw.trim();
  if (!path.startsWith('/')) {
    throw new EntityRoutesError(
      `The prefix declared by ${table} ("${raw}") doesn't start with "/". A ` +
        "prefix is a path, not a name.",
    );
  }
  if (splitPath(path).length === 0) {
    throw new EntityRoutesError(
      `The prefix declared by ${table} is "/": it would cover the whole ` +
        "application. Name the table's path.",
    );
  }
  return path;
}

function parseDeclaredLine(table: string, line: unknown): Array<{ method: string; path: string }> {
  if (typeof line !== 'string') {
    throw new EntityRoutesError(
      `A request declared under ${table} isn't text. Expected form: ` +
        '"POST /api/education/tags" or just "/api/education/tags".',
    );
  }
  const parts = line.trim().split(/\s+/);
  
  if (parts.length === 1) {
    const path = parts[0]!;
    if (!path.startsWith('/')) {
      throw new EntityRoutesError(`"${path}" (under ${table}) doesn't start with "/".`);
    }
    // Si la méthode est omise, on intercepte toutes les méthodes courantes
    return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map(method => ({ method, path }));
  }

  if (parts.length !== 2) {
    throw new EntityRoutesError(
      `"${line}" (under ${table}) isn't a request. Expected form: a method, a ` +
        'space, a path -- "POST /api/education/tags" or just "/api/education/tags".',
    );
  }
  const method = parts[0]!.toUpperCase();
  const path = parts[1]!;
  if (!METHODS.has(method)) {
    throw new EntityRoutesError(
      `"${parts[0]}" (under ${table}) isn't a composable HTTP method. Expected: ` +
        `${[...METHODS].join(', ')}.`,
    );
  }
  if (!path.startsWith('/')) {
    throw new EntityRoutesError(`"${path}" (under ${table}) doesn't start with "/".`);
  }
  return [{ method, path }];
}

function pathStartsWith(segments: readonly string[], prefix: readonly string[]): boolean {
  if (segments.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (segments[i] !== prefix[i]) return false;
  }
  return true;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
