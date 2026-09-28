export const OFFLINE_SYNC_VERSION = "0.1.0";

// Local database access
export type {
  AccessLocalDatabase,
  LocalDatabaseSession,
  SqlRow,
  SqlValue,
  WriteResult,
} from "./core/AccessLocalDatabase.js";

// The queue: the original request, kept for every case
export {
  QUEUE_COLUMNS,
  QUEUE_TABLE,
  PendingQueueError,
  dequeue,
  enqueue,
  listQueued,
  readQueued,
  type EnqueueInput,
  type QueuedRequest,
} from "./core/PendingQueue.js";

export type {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "./core/HttpClient.js";

// End-to-end request flow
export {
  ConsoleLogger,
  SilentLogger,
  defaultLogger,
  silentLogger,
  type LogContext,
  type Logger,
} from "./core/Logger.js";
export {
  ClassifiedError,
  classify,
  type ClassifiedErrorKind,
  type StatusClassifier,
} from "./core/ClassifiedError.js";

// Default network client
export {
  DEFAULT_TIMEOUT_MS,
  FetchClient,
  NetworkError,
  type FetchClientOptions,
} from "./core/FetchClient.js";

// Dead-letter store for definitively rejected writes
export {
  DEAD_LETTER_TABLE_NAME,
  DEAD_LETTER_COLUMNS,
  DeadLetterStore,
  type DeadLetterEntry,
  type DeadLetterStoreOptions,
} from "./core/DeadLetterStore.js";

// Handling of definitive rejections
export {
  ErrorHandlerRegistrationError,
  ErrorHandlerRegistry,
  type ErrorContext,
  type ErrorHandler,
  type ErrorHandlerRegistryOptions,
} from "./core/ErrorHandlerRegistry.js";

// Deferred upload
export type { TokenProvider } from "./core/TokenProvider.js";
export type {
  PendingTransaction,
  PendingWrite,
  WriteKind,
  WriteMetadata,
} from "./core/PendingWrite.js";
export {
  OfflineSyncConnector,
  REPLAY_HEADER,
  type ConnectorCredentials,
  type OfflineSyncConnectorOptions,
} from "./core/OfflineSyncConnector.js";

// Facade: the only thing the application builds
export {
  OfflineSync,
  type DirectReadInput,
  type DirectWriteInput,
  type OfflineSyncOptions,
  type Response,
  type ResponseStatus,
} from "./OfflineSync.js";
export type {
  ConnectorCredentials as SyncCredentials,
  SyncConnectorPort,
} from "./core/SyncConnectorPort.js";
