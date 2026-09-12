import type { AccessLocalDatabase } from './AccessLocalDatabase.js';
import type { PendingTransaction } from './PendingWrite.js';

export interface ConnectorCredentials {
  endpoint: string;
  token: string;
  expiresAt?: Date;
}

export interface SyncConnectorPort {
  /** `null` means the user isn't signed in; no channel is opened. */
  fetchCredentials(): Promise<ConnectorCredentials | null>;

  /** Called by the engine. The parameter may be ignored by adapters that fetch it themselves. */
  uploadData(tx: PendingTransaction): Promise<void>;

  localDatabase(): Promise<AccessLocalDatabase>;

  /** Optional: clears the guard set after a session-expired response. */
  resumeAfterReconnect?(): void;
}
