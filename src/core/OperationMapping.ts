/**
 * `offline`: write locally now, send later. `online`: must succeed right
 * away or fail; never queued (a replayed login hours later means nothing).
 */
export type Connectivity = 'offline' | 'online';

export interface OperationMapping {
  operationId: string;
  method: string;
  /** With its named holes: `/api/v1/blogs/{id}/comments`. */
  path: string;
  /** Optional: the real server path, if different from `path`. Not read by the module itself. */
  serverPath?: string;
  connectivity: Connectivity;
  /** Handler name, as registered in the requests file. */
  handle: string;
  /** Optional dedup window override for this operation. */
  dedupWindowMs?: number;
}

export interface OfflineMap {
  operations: readonly OperationMapping[];
}
