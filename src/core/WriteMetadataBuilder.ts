import { RELATIVE_BASE } from './Converter.js';
import type { HttpRequest } from './HttpRequest.js';
import type { OperationMapping } from './OperationMapping.js';
import type { WriteMetadata } from './PendingWrite.js';

/** What must be replayed to the server, taken from the intercepted request as-is. */
export function buildWriteMetadata(
  req: HttpRequest,
  operation: OperationMapping,
): WriteMetadata {
  const { pathname, search } = new URL(req.url, RELATIVE_BASE);

  return {
    method: req.method.toUpperCase(),
    path: pathname + search,
    operationId: operation.operationId,
    ...(req.body !== undefined ? { body: req.body } : {}),
  };
}

export function serialiseWriteMetadata(
  req: HttpRequest,
  operation: OperationMapping,
): string {
  return JSON.stringify(buildWriteMetadata(req, operation));
}
