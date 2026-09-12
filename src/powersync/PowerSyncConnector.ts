import type { AccessLocalDatabase } from '../core/AccessLocalDatabase.js';
import type { ConnectorCredentials } from '../core/SyncConnectorPort.js';
import type { OfflineSyncConnector } from '../core/OfflineSyncConnector.js';
import type {
  PendingTransaction,
  PendingWrite,
  WriteKind,
} from '../core/PendingWrite.js';
import {
  PowerSyncLocalDatabase,
  type PowerSyncWriteTarget,
} from './PowerSyncLocalDatabase.js';

export interface PowerSyncCrudEntry {
  clientId: number;
  id: string;
  op: string;
  table: string;
  opData?: Record<string, unknown>;
  metadata?: string;
  transactionId?: number;
}

export interface PowerSyncCrudTransaction {
  crud: readonly PowerSyncCrudEntry[];
  complete: (writeCheckpoint?: string) => Promise<void>;
  transactionId?: number;
}

export interface PowerSyncCrudSource extends PowerSyncWriteTarget {
  getNextCrudTransaction(): Promise<PowerSyncCrudTransaction | null>;
}

export interface PowerSyncConnectorOptions {
  db: PowerSyncCrudSource;
  connector: OfflineSyncConnector;
}

export class PowerSyncConnector {
  private readonly db: PowerSyncCrudSource;
  private readonly connector: OfflineSyncConnector;
  private readonly local: PowerSyncLocalDatabase;

  constructor(options: PowerSyncConnectorOptions) {
    this.db = options.db;
    this.connector = options.connector;
    this.local = new PowerSyncLocalDatabase(options.db);
  }

  async localDatabase(): Promise<AccessLocalDatabase> {
    return this.local;
  }

  async fetchCredentials(): Promise<ConnectorCredentials | null> {
    return this.connector.fetchCredentials();
  }

  resumeAfterReconnect(): void {
    this.connector.resumeAfterReconnect();
  }

  /** Called by the engine, never by the module. */
  async uploadData(): Promise<void> {
    const tx = await this.db.getNextCrudTransaction();
    if (tx === null) return;

    await this.connector.uploadData(toPendingTransaction(tx));
  }
}

export function toPendingTransaction(
  tx: PowerSyncCrudTransaction,
): PendingTransaction {
  return {
    writes: tx.crud.map(toPendingWrite),
    complete: () => tx.complete(),
  };
}

function toPendingWrite(entry: PowerSyncCrudEntry): PendingWrite {
  return {
    id: entry.id,
    clientId: entry.clientId,
    table: entry.table,
    op: toWriteKind(entry.op),
    ...(entry.opData !== undefined ? { data: entry.opData } : {}),
    ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    ...(entry.transactionId !== undefined
      ? { transactionId: entry.transactionId }
      : {}),
  };
}

/** An unknown write kind becomes PATCH: the conservative choice, it only touches what's given. */
function toWriteKind(op: string): WriteKind {
  const upper = op.toUpperCase();
  return upper === 'PUT' || upper === 'DELETE' ? upper : 'PATCH';
}
