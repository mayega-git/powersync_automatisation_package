export const OFFLINE_SYNC_VERSION = "0.1.0";

// Local database access
export type {
  AccessLocalDatabase,
  LocalDatabaseSession,
  SqlRow,
  SqlValue,
  WriteResult,
} from "./core/AccessLocalDatabase.js";

// SQL translation
export {
  SqlTranslator,
  SqlTranslationError,
  type PositionalSql,
  type SqlParams,
} from "./core/SqlTranslator.js";

// Request identification
export type { HttpRequest } from "./core/HttpRequest.js";
export type {
  Connectivity,
  OfflineMap,
  OperationMapping,
} from "./core/OperationMapping.js";
export {
  PathMatchIndex,
  splitPath,
  type MatchStatus,
  type PathMatchResult,
} from "./core/PathMatchIndex.js";
export { Converter, RELATIVE_BASE, type ResolvedOperation } from "./core/Converter.js";
export {
  buildWriteMetadata,
  serialiseWriteMetadata,
} from "./core/WriteMetadataBuilder.js";

// Table declaration: which table for which requests
export {
  EntityRoutes,
  EntityRoutesError,
  type DeclaredPath,
  type EntitiesDeclaration,
  type EntityRule,
  type ResolvedEntity,
} from "./core/EntityRoutes.js";
export {
  SqlBuilder,
  SqlBuildError,
  toCamelCase,
  toSnakeCase,
  type BuiltStatement,
  type SqlBuildInput,
  type SqlKind,
  type TableColumns,
} from "./core/SqlBuilder.js";
export {
  ComposedOperations,
  type ComposedOperationsOptions,
} from "./core/ComposedOperations.js";

// The queue: the original request, kept for every case
export {
  QUEUE_COLUMNS,
  QUEUE_TABLE,
  PendingQueueError,
  dequeue,
  enqueue,
  listQueued,
  readQueued,
  toHttpRequest,
  type EnqueueInput,
  type QueuedRequest,
} from "./core/PendingQueue.js";

// Handlers assembled by the Interceptor
export type {
  Handler,
  OnlineHandler,
  Request,
  Response,
  ResponseStatus,
} from "./core/Handler.js";
export { isOnlineHandler, isRequestHandler } from "./core/Handler.js";
export type {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "./core/HttpClient.js";
export {
  HandlerRegistrationError,
  RequestRegistry,
} from "./core/RequestRegistry.js";
export {
  DEFAULT_DEDUP_WINDOW_MS,
  DuplicateGuard,
  type DuplicateGuardOptions,
} from "./core/DuplicateGuard.js";

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
export {
  HandlerMismatchError,
  Interceptor,
  type InterceptorOptions,
} from "./core/Interceptor.js";

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
  type OfflineSyncOptions,
} from "./OfflineSync.js";
export type {
  ConnectorCredentials as SyncCredentials,
  SyncConnectorPort,
} from "./core/SyncConnectorPort.js";
export {
  OfflineMapValidationError,
  validateOfflineMap,
} from "./core/validateOfflineMap.js";
