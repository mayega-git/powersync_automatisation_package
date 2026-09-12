// Compatibility stub after the matching system was removed. The operations
// draft has no use anymore.

export interface DraftWriteResult {
  path: string;
  rows: any[];
  matched: number;
  bffFunctions: number;
  duplicateShapes: any[];
  unreadable: any[];
  written: boolean;
  reason?: string;
}

export function writeOperationsDraft(
  _cwd: string,
  _config: any,
  _options?: any,
): DraftWriteResult {
  return {
    path: 'offline-sync.operations.md',
    rows: [],
    matched: 0,
    bffFunctions: 0,
    duplicateShapes: [],
    unreadable: [],
    written: false,
  };
}
