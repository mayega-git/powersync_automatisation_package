export type WriteKind = 'PUT' | 'PATCH' | 'DELETE';

export interface PendingWrite {
  id: string;
  clientId: number;
  table: string;
  op: WriteKind;
  data?: Record<string, unknown>;
  /** Set by Request.constructMetadata at write time; carries what uploadData alone can't infer. */
  metadata?: string;
  transactionId?: number;
}

/** `complete()` removes the writes from the queue. Not calling it means "replay later". */
export interface PendingTransaction {
  writes: readonly PendingWrite[];
  complete(): Promise<void>;
}

export interface WriteMetadata {
  method: string;
  path: string;
  operationId?: string;
  body?: unknown;
  /** The queue entry id, reused as an idempotency key: stable across retries and restarts. */
  idempotencyKey?: string;
}
