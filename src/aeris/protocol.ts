import type { JsonValue } from './ir/types.js';

/**
 * Wire protocol between the browser runtime and the Sync Gateway
 * (architecture document, annex B). Cursors are opaque decimal strings so
 * they survive 64-bit server sequences.
 */

export type StoredRowWire = Record<string, JsonValue>;

export interface WireOperation {
  operationId: string;
  endpointId: string;
  method: string;
  /** Concrete path, local identifiers already replaced by server ones. */
  path: string;
  query: Readonly<Record<string, string>>;
  body: JsonValue | null;
  /** Cursor of the projection state the operation was executed against. */
  baseCursor: string | null;
  dependencies: readonly string[];
  /** Client-generated identifiers, by uuid slot; the receipt maps them to server ids. */
  localIds: readonly string[];
  /** Hash of the rows the local execution read, for conflict diagnostics. */
  preconditionHash: string;
  createdAt: string;
}

export interface ReconcileRequest {
  clientInstanceId: string;
  artifactVersion: number;
  operations: readonly WireOperation[];
}

export type ReceiptStatus = 'COMMITTED' | 'CONFLICT' | 'REJECTED' | 'RETRY';

export interface WireError {
  status: number;
  code: string;
  message: string;
}

export interface Receipt {
  operationId: string;
  status: ReceiptStatus;
  committedAt?: string;
  /** Server change-log position that includes this operation's effects. */
  serverCursor?: string;
  canonicalResponse?: { status: number; body: JsonValue | null };
  /** local id -> server id. */
  idMap?: Readonly<Record<string, string>>;
  error?: WireError;
  retryAfterMs?: number;
  /** True when the gateway answered from its idempotency registry. */
  replayed?: boolean;
}

export interface ReconcileResponse {
  receipts: readonly Receipt[];
}

export interface SnapshotEnvelope {
  projectionVersion: string;
  cursor: string;
  generatedAt: string;
  /** sha256 of the scope claims the snapshot was cut for. */
  scopeHash: string;
  entities: Readonly<Record<string, readonly StoredRowWire[]>>;
}

export interface Change {
  entity: string;
  op: 'upsert' | 'delete';
  key: JsonValue;
  row?: StoredRowWire;
}

export interface DeltaResponse {
  projectionVersion: string;
  cursor: string;
  changes: readonly Change[];
  hasMore: boolean;
  /** Set when the cursor is too old to serve a delta: the client must re-snapshot. */
  resnapshot?: boolean;
}

/** Header carrying the operation id on every replay and online mutation. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Response header telling the application where an answer came from. */
export const STATE_HEADER = 'X-AERIS-State';
export const OPERATION_HEADER = 'X-AERIS-Operation-Id';
