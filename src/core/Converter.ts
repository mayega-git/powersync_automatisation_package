import type { HttpRequest } from './HttpRequest.js';
import type { OfflineMap, OperationMapping } from './OperationMapping.js';
import { PathMatchIndex, splitPath } from './PathMatchIndex.js';
import type { SqlParams } from './SqlTranslator.js';
import type { SqlValue } from './AccessLocalDatabase.js';

export interface ResolvedOperation {
  operation: OperationMapping;
  pathParams: Readonly<Record<string, string>>;
}

/** `new URL()` needs a base even to read a relative path. */
export const RELATIVE_BASE = 'http://local.invalid';

export class Converter {
  private constructor(private readonly index: PathMatchIndex) {}

  static fromOfflineMap(map: OfflineMap): Converter {
    return new Converter(PathMatchIndex.build(map.operations));
  }

  /** `undefined` when nothing matches, or when more than one operation would. */
  resolve(req: HttpRequest): ResolvedOperation | undefined {
    const { pathname } = new URL(req.url, RELATIVE_BASE);
    const segments = splitPath(pathname).map(decodeSegment);
    const result = this.index.match(req.method, segments);

    if (result.status !== 'Matched' || result.operation === undefined) {
      return undefined;
    }
    return { operation: result.operation, pathParams: result.pathParams };
  }

  /** Priority on a shared key: path > query string > body. */
  extractParams(
    req: HttpRequest,
    pathParams: Readonly<Record<string, string>>,
  ): SqlParams {
    const merged: SqlParams = {};

    if (isPlainObject(req.body)) {
      for (const [key, value] of Object.entries(req.body)) {
        if (isSqlValue(value)) merged[key] = value;
      }
    }

    const { searchParams } = new URL(req.url, RELATIVE_BASE);
    for (const key of new Set(searchParams.keys())) {
      merged[key] = searchParams.get(key)!;
    }

    for (const [key, value] of Object.entries(pathParams)) {
      merged[key] = value;
    }

    return merged;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSqlValue(value: unknown): value is SqlValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  );
}
