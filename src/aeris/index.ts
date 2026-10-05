/**
 * AERIS browser runtime and IR (browser-safe: WebCrypto only, no Node APIs).
 * Build-time compiler: `@ksm/offline-sync/aeris/compiler`; server: `@ksm/offline-sync/aeris/gateway`.
 */
export * from './ir/types.js';
export { AerisValidationError, validateArtifact } from './ir/validate.js';
export { canonicalJson, canonicalDigest, sha256Hex, jsonEqual } from './ir/canonical.js';
export { AerisSignatureError, importPrivateKeyPem, importPublicKey, signArtifact, verifyArtifact } from './ir/signing.js';
export * from './protocol.js';
export { AerisRuntime, AERIS_RUNTIME_VERSION, readyOperations, type AerisRuntimeOptions, type RuntimeEvent, type SessionProvider } from './runtime/runtime.js';
export {
  AerisExecutionError,
  AerisHttpError,
  Executor,
  type Captured,
  type Effect,
  type ExecutionRequest,
  type ExecutionResult,
} from './runtime/executor.js';
export { EndpointRouter, type RouteMatch } from './runtime/router.js';
export { compareResults, type ComparisonResult } from './runtime/compare.js';
export { HttpTransport, TransportError, type AerisTransport, type HttpTransportOptions, type RuntimeRequest, type RuntimeResponse } from './runtime/transport.js';
export type { OperationState, OutboxEntry } from './runtime/outbox.js';
export {
  DuplicateKeyError,
  UnknownEntityError,
  type LocalStore,
  type StoreTx,
  type StoredRow,
  type ResolvedFilter,
} from './runtime/store/LocalStore.js';
export { MemoryStore } from './runtime/store/MemoryStore.js';
export { SqlStore } from './runtime/store/SqlStore.js';
export { IndexedDbStore } from './runtime/store/IndexedDbStore.js';
export { BetterSqliteDatabase, type BetterSqliteLike } from './runtime/store/BetterSqliteDatabase.js';
export { castValue, formatNow, valuesEqual, compareValues } from './runtime/values.js';
export { evaluatePolicy, authoritiesOf, type PolicyBeans } from './runtime/policy.js';
export {
  AERIS_CHANNEL,
  connectAerisServiceWorker,
  createBrowserRuntime,
  installAerisFetch,
  type BrowserRuntimeOptions,
  type InstallFetchOptions,
} from './runtime/browser.js';
export { prettyExpr, prettyProgram, explainPlan } from './ir/pretty.js';
