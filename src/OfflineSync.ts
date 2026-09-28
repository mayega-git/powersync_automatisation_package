import type { AccessLocalDatabase, SqlValue } from './core/AccessLocalDatabase.js';
import { ActivityLog, type ActivityEvent } from './core/ActivityLog.js';
import {
  DeadLetterStore,
  type DeadLetterEntry,
} from './core/DeadLetterStore.js';
import {
  ErrorHandlerRegistry,
  type ErrorHandler,
} from './core/ErrorHandlerRegistry.js';
import { defaultLogger, type Logger } from './core/Logger.js';
import { enqueue } from './core/PendingQueue.js';
import type { SyncConnectorPort } from './core/SyncConnectorPort.js';

export type ResponseStatus = 'Success' | 'Fail';

export interface Response<T = unknown> {
  status: ResponseStatus;
  entity: T;
}

export interface OfflineSyncOptions {
  /** The sync engine, already built by the application. Never constructed by the module. */
  connector: SyncConnectorPort;

  /** What to do with a definitive rejection, per operation. */
  errorHandlers?: Readonly<Record<string, ErrorHandler>>;

  /** Without it, everything logs to the console. */
  logger?: Logger;

  /**
   * Shared trail of module activity, for `@ksm/offline-sync/ui`'s activity
   * feed. Pass the same instance given to `OfflineSyncConnector` (built
   * separately, before this call) so events from both sides land in one
   * feed. Without it, `OfflineSync` creates its own -- `activity()` and
   * `onActivity()` never throw, but a connector-side event (dead-letter,
   * reauth) only shows up if the same instance was shared.
   */
  activity?: ActivityLog;
}

/**
 * A write the application performs directly, bypassing HTTP interception
 * entirely: the caller already knows what SQL to run and what request it
 * should become on replay -- there is no `entities.yaml`/`EntityRoutes`
 * declaration to resolve against. See `OfflineSync.write`.
 */
export interface DirectWriteInput {
  /**
   * Also bound to `_metadata` by the caller's own SQL (as `:_metadata` or
   * equivalent) -- this is what lets `OfflineSyncConnector.uploadData()`
   * find this write's queued request again once the engine reports it as a
   * pending CRUD entry. The target table MUST declare `trackMetadata: true`
   * in the PowerSync schema, or the engine never reports `_metadata` back
   * and the write is replayed as an unroutable one (dead-lettered).
   */
  id: string;
  /** HTTP verb this write replays as, once the network is back. */
  method: string;
  /** Full path (with query string, if any) the write replays against. */
  url: string;
  /** SQL to run against the local database now. Must end in `RETURNING *`, per this module's convention, for `entity` to come back non-null. */
  sql: string;
  params?: readonly SqlValue[];
  /** Sent as the body when the write is replayed. Defaults to `params` when omitted. */
  body?: unknown;
}

/**
 * A read the application performs directly, against hand-written SQL: no
 * `entities.yaml`/`EntityRoutes` declaration to resolve against, no
 * generated projection. See `OfflineSync.read`.
 */
export interface DirectReadInput {
  /** SQL the caller wrote by hand, with its own `AS camelCase` aliases. Positional (`?`) placeholders. */
  sql: string;
  params?: readonly SqlValue[];
  /** `true` reads a single row (or `null`); omitted/`false` reads a list. */
  single?: boolean;
}

export class OfflineSync {
  private constructor(
    private readonly deadLetters: DeadLetterStore,
    readonly errorHandlers: ErrorHandlerRegistry,
    readonly db: AccessLocalDatabase,
    readonly logger: Logger,
    private readonly connector: SyncConnectorPort,
    private readonly activityLog: ActivityLog,
  ) {}

  /** Called once, at application startup. */
  static async create(options: OfflineSyncOptions): Promise<OfflineSync> {
    const logger = options.logger ?? defaultLogger;

    const db = await options.connector.localDatabase();

    const errorHandlers = new ErrorHandlerRegistry({ logger });
    if (options.errorHandlers !== undefined) {
      errorHandlers.registerAll(options.errorHandlers);
    }

    const deadLetters = new DeadLetterStore({ db });
    const activityLog = options.activity ?? new ActivityLog();

    logger.info('module ready');

    return new OfflineSync(
      deadLetters,
      errorHandlers,
      db,
      logger,
      options.connector,
      activityLog,
    );
  }

  /**
   * Call once the application knows a valid session exists again. Never
   * throws: a connector with no notion of reauth simply has nothing to do.
   */
  resumeUploads(): void {
    this.connector.resumeAfterReconnect?.();
  }

  /**
   * Perform a write directly: no interception, no `entities.yaml` to
   * declare. The caller supplies the SQL and what it should become on
   * replay (method, url, body) -- this module composes nothing here, it
   * only writes locally, queues for later delivery, and hands back the
   * written row.
   *
   * Replaces an ordinary `fetch()` call at the call site: the application
   * gets an immediate, local answer, and the real request goes out later
   * through the same `OfflineSyncConnector`/`uploadData()` path as every
   * other queued write, conflict/invariant handling included.
   */
  async write(input: DirectWriteInput): Promise<Response> {
    const now = new Date().toISOString();

    return this.db.runInTransaction(async (tx) => {
      const result = await tx.writeData(input.sql, input.params);

      await enqueue(tx, {
        id: input.id,
        method: input.method,
        path: input.url,
        ...(input.body !== undefined
          ? { body: input.body }
          : input.params !== undefined
            ? { body: input.params }
            : {}),
        now,
      });

      this.logger.info('local write done (direct), request kept for replay', {
        method: input.method.toUpperCase(),
        id: input.id,
      });

      return { status: 'Success', entity: result.rows[0] ?? null };
    });
  }

  /**
   * Read directly against the local database: no interception, no
   * `entities.yaml` to declare. The caller supplies the SQL, including its
   * own `AS camelCase` projection -- this module runs it as-is and hands
   * back the rows, nothing composed or translated.
   *
   * Replaces an ordinary `fetch()` call at the call site: the application
   * gets an immediate, local answer instead of going out over the network.
   * Never queued -- a read has nothing to replay.
   */
  async read(input: DirectReadInput): Promise<Array<Record<string, SqlValue>> | Record<string, SqlValue> | null> {
    const rows = await this.db.readData(input.sql, input.params);
    this.logger.info('local read done (direct)', { rows: rows.length, single: input.single === true });
    return input.single === true ? (rows[0] ?? null) : rows;
  }

  async pendingIssues(): Promise<DeadLetterEntry[]> {
    return this.deadLetters.list();
  }

  async pendingIssueCount(): Promise<number> {
    return this.deadLetters.count();
  }

  async resolveIssue(id: string): Promise<void> {
    return this.deadLetters.remove(id);
  }

  /** Recent module activity, oldest first, bounded (see `ActivityLog`). */
  activity(): readonly ActivityEvent[] {
    return this.activityLog.list();
  }

  /** Called on every new activity event, from the moment of subscription onward. */
  onActivity(listener: (event: ActivityEvent) => void): () => void {
    return this.activityLog.subscribe(listener);
  }
}
