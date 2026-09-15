import type { AccessLocalDatabase } from './core/AccessLocalDatabase.js';
import { ComposedOperations } from './core/ComposedOperations.js';
import { Converter } from './core/Converter.js';
import { EntityRoutes, type EntitiesDeclaration } from './core/EntityRoutes.js';
import {
  DEFAULT_DEDUP_WINDOW_MS,
  DuplicateGuard,
} from './core/DuplicateGuard.js';
import {
  DeadLetterStore,
  type DeadLetterEntry,
} from './core/DeadLetterStore.js';
import {
  ErrorHandlerRegistry,
  type ErrorHandler,
} from './core/ErrorHandlerRegistry.js';
import type { Handler, Response } from './core/Handler.js';
import type { HttpClient } from './core/HttpClient.js';
import type { HttpRequest } from './core/HttpRequest.js';
import { Interceptor } from './core/Interceptor.js';
import { defaultLogger, type Logger } from './core/Logger.js';
import type { OfflineMap } from './core/OperationMapping.js';
import { RequestRegistry } from './core/RequestRegistry.js';
import type { TableColumns } from './core/SqlBuilder.js';
import type { SyncConnectorPort } from './core/SyncConnectorPort.js';
import { validateOfflineMap } from './core/validateOfflineMap.js';
import { FetchClient } from './core/FetchClient.js';

export interface OfflineSyncOptions {
  /** The sync engine, already built by the application. Never constructed by the module. */
  connector: SyncConnectorPort;

  /** Table-to-request declaration, the content of offline-sync.entities.yaml. */
  entities?: EntitiesDeclaration;

  /** Real columns of each table. Required as soon as `entities` is provided. */
  tableColumns?: TableColumns;

  /** Optional hand-written handlers file. A declared handler always wins over composed SQL. */
  requests?: Readonly<Record<string, Handler>>;

  /** Operations map that accompanies those handlers. Optional. */
  offlineMap?: OfflineMap;

  /** What to do with a definitive rejection, per operation. */
  errorHandlers?: Readonly<Record<string, ErrorHandler>>;

  /** Without it, everything logs to the console. */
  logger?: Logger;

  /** Without it, the module falls back to its own network client. */
  httpClient?: HttpClient;

  /** Prefix for relative paths, passed to the default client. */
  baseUrl?: string;

  /** Duplicate-protection window, when an operation doesn't declare its own. */
  dedupWindowMs?: number;
}

export class OfflineSync {
  private constructor(
    private readonly interceptor: Interceptor,
    private readonly converter: Converter,
    private readonly composed: ComposedOperations | undefined,
    private readonly deadLetters: DeadLetterStore,
    readonly requests: RequestRegistry,
    readonly errorHandlers: ErrorHandlerRegistry,
    readonly db: AccessLocalDatabase,
    readonly logger: Logger,
    private readonly connector: SyncConnectorPort,
  ) {}

  /** Called once, at application startup. */
  static async create(options: OfflineSyncOptions): Promise<OfflineSync> {
    const logger = options.logger ?? defaultLogger;

    if (options.entities === undefined && options.offlineMap === undefined) {
      throw new Error(
        'The module has nothing to intercept: neither "entities" (the table ' +
          'declaration) nor "offlineMap" (the operations map) was given to it.',
      );
    }
    if (options.entities !== undefined && options.tableColumns === undefined) {
      throw new Error(
        '"entities" is given without "tableColumns": the module would know ' +
          'which table to target but not which columns it has, and the ' +
          'composed SQL would write columns that don\'t exist. For ' +
          'PowerSync, pass tableColumnsFromSchema(AppSchema).',
      );
    }

    const offlineMap: OfflineMap = options.offlineMap ?? { operations: [] };

    validateOfflineMap(offlineMap);

    const db = await options.connector.localDatabase();

    const converter = Converter.fromOfflineMap(offlineMap);

    const composed =
      options.entities === undefined
        ? undefined
        : new ComposedOperations({
            routes: EntityRoutes.build(options.entities),
            schema: options.tableColumns!,
            logger,
          });

    const requests = new RequestRegistry();
    if (options.requests !== undefined) requests.registerAll(options.requests);

    const errorHandlers = new ErrorHandlerRegistry({ logger });
    if (options.errorHandlers !== undefined) {
      errorHandlers.registerAll(options.errorHandlers);
    }

    const deadLetters = new DeadLetterStore({ db });

    const duplicates = new DuplicateGuard({
      defaultWindowMs: options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS,
    });

    const http =
      options.httpClient ??
      new FetchClient(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {});

    const interceptor = new Interceptor({
      converter,
      requests,
      db,
      http,
      logger,
      duplicates,
      ...(composed !== undefined ? { composed } : {}),
    });

    logger.info('module ready', {
      tables: options.entities === undefined ? 0 : Object.keys(options.entities).length,
      operations: offlineMap.operations.length,
      handlers: requests.size,
    });

    return new OfflineSync(
      interceptor,
      converter,
      composed,
      deadLetters,
      requests,
      errorHandlers,
      db,
      logger,
      options.connector,
    );
  }

  /**
   * Call once the application knows a valid session exists again. Never
   * throws: a connector with no notion of reauth simply has nothing to do.
   */
  resumeUploads(): void {
    this.connector.resumeAfterReconnect?.();
  }

  /** The single entry point for every outgoing request. */
  async interceptRequest(req: HttpRequest): Promise<Response> {
    return this.interceptor.interceptRequest(req);
  }

  /**
   * Is this request declared in the operations map?
   *
   * Call this before interceptRequest when the application has its own HTTP
   * client (session cookies, custom headers, 401 redirects): a request the
   * map doesn't know about is still relayed by the module, but through its
   * own client, which knows none of that.
   */
  handles(req: HttpRequest): boolean {
    if (this.converter.resolve(req) !== undefined) return true;
    return this.composed?.resolve(req) !== undefined;
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
}
