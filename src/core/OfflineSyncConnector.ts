import type { AccessLocalDatabase } from './AccessLocalDatabase.js';
import type { ActivityLog } from './ActivityLog.js';
import { classify, ClassifiedError, type StatusClassifier } from './ClassifiedError.js';
import type { DeadLetterEntry, DeadLetterStore } from './DeadLetterStore.js';
import type { ErrorHandlerRegistry } from './ErrorHandlerRegistry.js';
import type { HttpClient, HttpClientRequest } from './HttpClient.js';
import type { Logger } from './Logger.js';
import type {
  PendingTransaction,
  PendingWrite,
  WriteMetadata,
} from './PendingWrite.js';
import { dequeue, readQueued, type QueuedRequest } from './PendingQueue.js';
import type { TokenProvider } from './TokenProvider.js';

/**
 * Marks a replayed request so a bridge that intercepts every outgoing fetch
 * (Service Worker or otherwise) lets it through instead of re-capturing it.
 */
export const REPLAY_HEADER = 'X-Offline-Sync-Replay';

export interface ConnectorCredentials {
  endpoint: string;
  token: string;
  expiresAt?: Date;
}

export interface OfflineSyncConnectorOptions {
  http: HttpClient;
  tokens: TokenProvider;
  deadLetters: DeadLetterStore;
  errors: ErrorHandlerRegistry;
  logger: Logger;
  /** Sync service address, used to open the channel. */
  syncEndpoint: string;
  /** Prefix of the business server's paths. */
  baseUrl?: string;
  /** Optional: the local database, to fetch the kept request. Without it, the metadata JSON is used instead. */
  db?: AccessLocalDatabase;
  /** Called when the session expired while the device was offline. The queue stays intact. */
  onReauthRequired?: () => void;
  /**
   * Called right after a write is definitively rejected and recorded in the
   * dead-letter store. Lets the host push the news to the user (or its own
   * UI, see `@ksm/offline-sync/ui`) instead of polling `pendingIssueCount()`.
   */
  onDeadLetter?: (entry: DeadLetterEntry) => void;
  /** Overrides how an HTTP status maps to a retry/reject/reauth decision. */
  classifyStatus?: StatusClassifier;
  /** Optional: records dead-letters and reauth events, for `@ksm/offline-sync/ui`'s activity feed. */
  activity?: ActivityLog;
}

export class OfflineSyncConnector {
  private readonly o: OfflineSyncConnectorOptions;

  /** True once a replay gets a reauth status; `uploadData` then stops trying the network. */
  private sessionExpired = false;

  constructor(options: OfflineSyncConnectorOptions) {
    this.o = options;
  }

  /** Call once the application knows a valid session exists again. */
  resumeAfterReconnect(): void {
    this.sessionExpired = false;
  }

  async fetchCredentials(): Promise<ConnectorCredentials | null> {
    const token = await this.o.tokens.getStreamToken();
    if (token === null) {
      this.o.logger.debug('no channel token, no connection opened');
      return null;
    }
    return { endpoint: this.o.syncEndpoint, token };
  }

  async uploadData(tx: PendingTransaction): Promise<void> {
    if (this.sessionExpired) {
      throw new ClassifiedError(
        'reauth',
        'session still expired, waiting for resumeAfterReconnect()',
      );
    }

    this.o.logger.info('deferred upload: transaction received', {
      writes: tx.writes.length,
    });

    const token = await this.o.tokens.getApplicativeToken();

    const sent = new Set<string>();

    for (const write of tx.writes) {
      const kept = await this.readFromQueue(write);

      if (kept !== undefined) {
        if (sent.has(kept.id)) continue;
        sent.add(kept.id);
        const shouldRetryLater = await this.deliver(
          write,
          {
            method: kept.method,
            path: kept.path,
            ...(kept.body !== undefined ? { body: kept.body } : {}),
            idempotencyKey: kept.id,
          },
          token,
        );
        if (shouldRetryLater) return;
        continue;
      }

      const metadata = readMetadata(write);

      if (metadata === undefined) {
        await this.discard(
          write,
          new ClassifiedError(
            'reject',
            'The write carries no usable metadata: there is no way to know ' +
              'which service to call.',
          ),
        );
        continue;
      }

      await this.deliver(write, metadata, token);
    }

    await tx.complete();

    if (this.o.db !== undefined && sent.size > 0) {
      await dequeue(this.o.db, [...sent]);
    }
  }

  /** Rethrows on a transient failure (leaves the transaction pending); returns `true` for a reauth. */
  private async deliver(
    write: PendingWrite,
    metadata: WriteMetadata,
    token: string | null,
  ): Promise<boolean> {
    const response = await this.o.http.send(
      this.constructHttpRequest(write, metadata, token),
    );

    if (response.status >= 200 && response.status < 300) {
      this.o.logger.info('write sent', {
        operationId: metadata.operationId,
        status: response.status,
      });
      return false;
    }

    const classified = classify(undefined, response, this.o.classifyStatus);

    if (classified.kind === 'reauth') {
      if (!this.sessionExpired) {
        this.sessionExpired = true;
        this.o.logger.error('session expired: nothing was sent, nothing lost', {
          operationId: metadata.operationId,
          path: metadata.path,
        });
        this.o.onReauthRequired?.();
        this.o.activity?.record('reauth-required', { operationId: metadata.operationId });
      }
      throw classified;
    }

    if (classified.kind === 'retry') {
      this.o.logger.warn('transient failure, the transaction will be retried', {
        operationId: metadata.operationId,
        status: response.status,
      });
      throw classified;
    }

    await this.discard(write, classified, metadata);
    return false;
  }

  /** `undefined` when there's no local database, or the metadata predates the queue. */
  private async readFromQueue(
    write: PendingWrite,
  ): Promise<QueuedRequest | undefined> {
    const db = this.o.db;
    if (db === undefined) return undefined;
    const id = write.metadata;
    if (id === undefined || id.length === 0) return undefined;
    if (id.trimStart().startsWith('{')) return undefined;
    return readQueued(db, id);
  }

  constructHttpRequest(
    write: PendingWrite,
    metadata: WriteMetadata,
    token: string | null,
  ): HttpClientRequest {
    const headers: Record<string, string> = { [REPLAY_HEADER]: '1' };
    if (token !== null) headers['Authorization'] = `Bearer ${token}`;

    const key = metadata.idempotencyKey ?? readIdempotencyKey(write);
    if (key !== undefined) {
      headers['Idempotency-Key'] = key;
    }

    const url =
      this.o.baseUrl === undefined
        ? metadata.path
        : new URL(metadata.path, this.o.baseUrl).toString();

    return {
      method: metadata.method,
      url,
      headers,
      ...(metadata.body !== undefined
        ? { body: metadata.body }
        : write.data !== undefined
          ? { body: write.data }
          : {}),
    };
  }

  private async discard(
    write: PendingWrite,
    error: ClassifiedError,
    metadata?: WriteMetadata,
  ): Promise<void> {
    const operationId = metadata?.operationId ?? write.table;

    await this.o.errors.apply({
      operationId,
      entryId: String(write.clientId),
      payload: JSON.stringify(write.data ?? null),
      error,
    });

    const entry: DeadLetterEntry = {
      id: String(write.clientId),
      operationId,
      payload: JSON.stringify(write.data ?? null),
      code: error.response?.status ?? 0,
      reason: error.reason,
      createdAt: Date.now(),
    };

    await this.o.deadLetters.record(entry);

    this.o.logger.error('write discarded, recorded in the dead-letter store', {
      operationId,
      reason: error.reason,
    });

    this.o.onDeadLetter?.(entry);
    this.o.activity?.record('dead-letter', { operationId, reason: error.reason });
  }
}

function readMetadata(write: PendingWrite): WriteMetadata | undefined {
  if (write.metadata === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(write.metadata);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as WriteMetadata).method === 'string' &&
      typeof (parsed as WriteMetadata).path === 'string'
    ) {
      return parsed as WriteMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Legacy path: an application that stamps its own key on the row, outside the queue. */
function readIdempotencyKey(write: PendingWrite): string | undefined {
  const value = write.data?.['idempotencyKey'];
  return typeof value === 'string' ? value : undefined;
}
