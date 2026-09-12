import type { OfflineMap, OperationMapping } from './OperationMapping.js';

export class OfflineMapValidationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = 'OfflineMapValidationError';
    this.path = path;
  }
}

const REQUIRED: (keyof OperationMapping)[] = [
  'operationId',
  'method',
  'path',
  'handle',
];

export function validateOfflineMap(map: OfflineMap): OfflineMap {
  const seen = new Map<string, string>();

  for (const op of map.operations) {
    for (const field of REQUIRED) {
      const value = op[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new OfflineMapValidationError(
          `Operation "${op.operationId || '(no id)'}" is missing ${String(field)}. ` +
            `The four fields ${REQUIRED.join(', ')} are required: without them ` +
            "the module can't recognize it or know which handler to call.",
          op.path ?? '',
        );
      }
    }

    if (op.connectivity !== 'offline' && op.connectivity !== 'online') {
      throw new OfflineMapValidationError(
        `Operation "${op.operationId}" declares an unknown connectivity: ` +
          `"${String(op.connectivity)}". Only "offline" and "online" exist.`,
        op.path,
      );
    }

    const key = `${op.method.toUpperCase()} ${normalize(op.path)}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new OfflineMapValidationError(
        `Two operations compete for ${key}: "${previous}" and ` +
          `"${op.operationId}". The module refuses to start rather than ` +
          'choosing at random once the application is running.',
        op.path,
      );
    }
    seen.set(key, op.operationId);
  }

  return map;
}

/** `/blogs/{id}` and `/blogs/{blogId}` compete for the same slot: position is what matters. */
function normalize(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('{') && s.endsWith('}') && s.length > 2 ? '{}' : s))
    .join('/');
}
