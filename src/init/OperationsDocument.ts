// Compatibility stub after the matching system was removed.
//
// `discover` and `check` stay in the CLI so as not to break projects that
// use them, but handler generation has no place in this project anymore
// (entites.yaml replaces the map). The functions exported here do nothing
// useful -- they satisfy imports without a compile error.

export const OPERATIONS_FILE_NAME = 'offline-sync.operations.md';

/** Always returns an empty list. */
export function loadOperations(
  _cwd: string,
  _path?: string,
): import('./types.js').OperationRow[] {
  return [];
}

/** Always returns an empty list. */
export function parseOperations(
  _source: string,
  _path?: string,
): import('./types.js').OperationRow[] {
  return [];
}
