/**
 * AERIS IR, format 1.x.
 *
 * The IR is the only contract between the build-time Behavior Compiler, the
 * browser runtime and the Sync Gateway. It is deliberately small: a program is
 * a list of instructions over pure expressions, executed against local
 * projections inside one transaction. Nothing in it can reach the network, a
 * secret or a clock that was not captured for the operation.
 */

export const AERIS_IR_FORMAT = 'aeris-ir' as const;
export const AERIS_IR_VERSION = '1.0.0' as const;
/** Oldest runtime able to execute artifacts produced by this compiler. */
export const AERIS_RUNTIME_MIN_VERSION = '1.0.0' as const;
export const AERIS_SIGNED_FORMAT = 'aeris-signed-ir' as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Classes from the architecture document, section 12. */
export type OfflineClass =
  | 'LOCAL_READ_SAFE'
  | 'LOCAL_WRITE_SAFE'
  | 'REPLAYABLE'
  | 'SPECULATIVE'
  | 'ONLINE_REQUIRED'
  | 'UNSUPPORTED';

export const OFFLINE_CLASSES: readonly OfflineClass[] = [
  'LOCAL_READ_SAFE', 'LOCAL_WRITE_SAFE', 'REPLAYABLE', 'SPECULATIVE', 'ONLINE_REQUIRED', 'UNSUPPORTED',
];

/** Classes the runtime may execute locally. */
export const LOCAL_CLASSES: ReadonlySet<OfflineClass> = new Set<OfflineClass>([
  'LOCAL_READ_SAFE', 'LOCAL_WRITE_SAFE', 'REPLAYABLE', 'SPECULATIVE',
]);

/**
 * Scalar types as seen on the wire. Temporal values travel as ISO-8601
 * strings in the exact shape the backend serializer produces.
 */
export type ScalarType =
  | 'string'
  | 'uuid'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'        // instant with offset, e.g. 2026-10-05T18:58:28.269Z
  | 'datetime-local'  // wall-clock time in the server zone, no offset
  | 'date'
  | 'time'
  | 'enum'
  | 'json';

export const SCALAR_TYPES: readonly ScalarType[] = [
  'string', 'uuid', 'integer', 'decimal', 'boolean', 'datetime', 'datetime-local', 'date', 'time', 'enum', 'json',
];

export interface FieldType {
  type: ScalarType;
  nullable: boolean;
  /** For `enum`: the accepted constant names. */
  values?: readonly string[];
  /** For a list-valued field. */
  list?: boolean;
  /** Database limit on string length (varchar(n)); longer values fail like the server. */
  maxLength?: number;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type ExprOp =
  | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'
  | 'and' | 'or' | 'not'
  | 'isNull' | 'notNull'
  | 'add' | 'sub' | 'mul' | 'div' | 'neg' | 'mod'
  | 'concat' | 'coalesce'
  | 'lower' | 'upper' | 'trim' | 'length' | 'isBlank' | 'isEmpty'
  | 'startsWith' | 'endsWith' | 'contains'
  | 'min' | 'max' | 'abs'
  | 'size' | 'first' | 'replace'
  | 'take' | 'strip' | 'setScale' | 'divide' | 'append'
  | 'range' | 'replaceAll' | 'matches';

export const EXPR_OPS: readonly ExprOp[] = [
  'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or', 'not', 'isNull', 'notNull',
  'add', 'sub', 'mul', 'div', 'neg', 'mod', 'concat', 'coalesce',
  'lower', 'upper', 'trim', 'length', 'isBlank', 'isEmpty',
  'startsWith', 'endsWith', 'contains', 'min', 'max', 'abs', 'size', 'first', 'replace',
  'take', 'strip', 'setScale', 'divide', 'append', 'range', 'replaceAll', 'matches',
];

/** java.math.RoundingMode names accepted by setScale / divide (as string literals). */
export const ROUNDING_MODES = ['UP', 'DOWN', 'CEILING', 'FLOOR', 'HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UNNECESSARY'] as const;

export interface SortKey {
  /** Key extracted from the element bound by the enclosing sort's `as`. */
  key: Expr;
  desc: boolean;
  /** Placement of null keys; `error` = Comparator.comparing semantics (NullPointerException). */
  nulls: 'first' | 'last' | 'error';
}

export type Expr =
  /** A JSON literal. */
  | { k: 'lit'; v: JsonValue }
  /** A value from the request body; empty path = the whole body. */
  | { k: 'input'; path: readonly string[] }
  /** A path variable, already converted to its declared type. */
  | { k: 'param'; name: string }
  /** A query-string parameter, converted, or null when absent. */
  | { k: 'query'; name: string }
  /** A trusted claim of the authenticated session (tenant, organization, user...). */
  | { k: 'ctx'; name: string }
  /** A program variable. */
  | { k: 'var'; name: string }
  /** Field access on a record or object value. Access on null aborts with 500, like a Java NullPointerException. */
  | { k: 'get'; of: Expr; field: string }
  /** The operation timestamp, captured once per operation and journaled with it. */
  | { k: 'now'; type: 'datetime' | 'datetime-local' | 'date' }
  /** The n-th client-generated identifier of the operation, journaled with it. */
  | { k: 'uuid'; slot: number }
  | { k: 'cond'; test: Expr; then: Expr; else: Expr }
  | { k: 'op'; op: ExprOp; args: readonly Expr[] }
  /** Object construction, e.g. a response DTO. Key order is preserved. */
  | { k: 'object'; fields: Readonly<Record<string, Expr>> }
  | { k: 'list'; items: readonly Expr[] }
  /** Pure list transformations; `as` binds each element as a variable. */
  | { k: 'map'; of: Expr; as: string; body: Expr }
  | { k: 'filter'; of: Expr; as: string; body: Expr }
  /**
   * Left fold, the IR form of a side-effect-free Java loop: `acc` starts at
   * `init`, and `body` (with `as` bound to the element) computes the next acc.
   */
  | { k: 'fold'; of: Expr; as: string; acc: string; init: Expr; body: Expr }
  /** Stable sort (Java List.sort / Flux.sort semantics). */
  | { k: 'sort'; of: Expr; as: string; keys: readonly SortKey[] }
  /**
   * Java try/catch over a pure computation: `fallback` replaces `body` when
   * evaluating it fails with a conversion error (`cast`, i.e.
   * IllegalArgumentException and subclasses) or with any error (`any`).
   */
  | { k: 'try'; body: Expr; catches: 'cast' | 'any'; fallback: Expr }
  /** Conversion with validation; a failed conversion aborts with 400. */
  | { k: 'cast'; to: ScalarType; of: Expr; values?: readonly string[] };

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export type FilterCmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'isNull' | 'notNull' | 'in';

export interface Filter {
  /** Entity property name (not the column name). */
  field: string;
  cmp: FilterCmp;
  /** Absent for `isNull` / `notNull`. */
  value?: Expr;
}

export interface OrderBy {
  field: string;
  dir: 'asc' | 'desc';
}

export type QueryMode = 'one' | 'many' | 'count' | 'exists';

export interface ErrorSpec {
  status: number;
  /** Stable machine code, e.g. NOT_FOUND or VALIDATION. */
  code: string;
  message: Expr;
  /**
   * Error body as the backend's exception handler builds it; `$message` is
   * bound to the evaluated message. Absent: the runtime's default error body.
   */
  body?: Expr;
}

export type Instr =
  /**
   * Bounded read of a projection. `one` yields the record or null and fails
   * if more than one row matches (the backend would fail too).
   */
  | {
    op: 'QUERY';
    out: string;
    entity: string;
    mode: QueryMode;
    where: readonly Filter[];
    orderBy?: readonly OrderBy[];
    limit?: number;
  }
  | { op: 'LET'; out: string; expr: Expr }
  /** Aborts the operation with the given error when `test` is false. */
  | { op: 'ASSERT'; test: Expr; error: ErrorSpec }
  | { op: 'IF'; test: Expr; then: readonly Instr[]; else: readonly Instr[] }
  /** Inserts one row; `out` receives the stored record. */
  | { op: 'INSERT'; entity: string; values: Readonly<Record<string, Expr>>; out?: string }
  /** Updates the row with the given key; fails when it does not exist. */
  | { op: 'UPDATE'; entity: string; key: Expr; values: Readonly<Record<string, Expr>>; out?: string }
  | { op: 'DELETE'; entity: string; key: Expr }
  /** UI-only notification, never leaves the device. */
  | { op: 'EMIT_LOCAL_EVENT'; name: string; payload: Expr }
  /** Journals the server intention in the outbox, in the same transaction. */
  | { op: 'QUEUE_INTENT' }
  /** Ends the program (2xx, or a business 4xx built without an exception). `body` null = empty body. */
  | { op: 'RETURN'; status: number; body: Expr | null };

// ---------------------------------------------------------------------------
// Evidence, policies and contracts
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'route' | 'handler' | 'call' | 'database-read' | 'database-write'
  | 'validation' | 'authorization' | 'transaction' | 'external-effect'
  | 'context' | 'annotation' | 'config' | 'schema';

export interface Evidence {
  kind: EvidenceKind;
  file: string;
  symbol: string;
  startLine: number;
  endLine: number;
  /** sha256 of the exact source excerpt, so a reviewer can detect drift. */
  excerptHash: string;
}

export type ConflictStrategy =
  | 'APPEND'              // commutative, append-only
  | 'SERVER_REVALIDATE'   // the server re-executes against the current state
  | 'OPTIMISTIC_VERSION'  // compare-and-set on a version column
  | 'REJECT_COMPENSATE';

export interface IdMapping {
  /** Client-generated uuid slot used locally. */
  slot: number;
  /** Where the server-assigned id is found in the canonical response body. */
  responsePath: readonly string[];
  entity: string;
}

export interface SyncContract {
  /** Every replay carries the operation id in this header. */
  idempotencyHeader: string;
  /**
   * How the server-side effect is made exactly-once:
   * - backend-key: the backend deduplicates on the idempotency header;
   * - natural: replaying the request has no additional effect (PUT/DELETE by key).
   */
  idempotency: 'backend-key' | 'natural';
  conflict: ConflictStrategy;
  /** Server-assigned ids to remap locally once the receipt arrives. */
  idMap: readonly IdMapping[];
}

export interface Freshness {
  /** Oldest projection age, in seconds, at which local execution is allowed. */
  maxAgeSeconds: number;
}

export interface AuthRequirement {
  authenticated: boolean;
  /** Trusted claims the program reads; all must be present offline. */
  context: readonly string[];
  /** Roles/authorities, checked locally against cached claims and again by the server. */
  anyAuthority?: readonly string[];
  /**
   * Authorization expressions of the backend (e.g. Spring @PreAuthorize SpEL),
   * evaluated offline by the application's authorizer on cached claims. The
   * server re-evaluates them on every replay.
   */
  policies?: readonly string[];
  /**
   * Authorization expressions compiled from the backend's own policy code into
   * boolean IR expressions over session claims. A policy listed here needs no
   * application-provided implementation.
   */
  checks?: readonly { policy: string; test: Expr }[];
}

export interface InputSpec {
  params: Readonly<Record<string, FieldType>>;
  query: Readonly<Record<string, FieldType & { required: boolean }>>;
  /** Body fields, or undefined when the handler takes no body. */
  body?: {
    required: boolean;
    fields: Readonly<Record<string, FieldType>>;
  };
}

export interface EndpointPlan {
  /** `METHOD /path/{param}`, unique in an artifact. */
  id: string;
  method: HttpMethod;
  /** Route template, Spring-style `{name}` segments. */
  path: string;
  handler: { file: string; symbol: string };
  input: InputSpec;
  output: { status: number; list: boolean; empty: boolean };
  auth: AuthRequirement;
  reads: readonly string[];
  writes: readonly string[];
  /** Present only when the compiler proved a local program. */
  program?: readonly Instr[];
  /** Number of uuid slots the program consumes. */
  uuidSlots: number;
  offlineClass: OfflineClass;
  reasons: readonly string[];
  freshness: Freshness;
  sync?: SyncContract;
  evidence: readonly Evidence[];
  unresolved: readonly string[];
  testVectors: readonly string[];
}

export interface ProjectionColumn {
  /** Entity property name. */
  name: string;
  /** Physical column in the server database. */
  column: string;
  type: FieldType;
}

export interface Projection {
  entity: string;
  schema?: string;
  table: string;
  key: string;
  columns: readonly ProjectionColumn[];
  /**
   * Row filter that limits the projection to what the session may see,
   * expressed over trusted context claims only. Empty only for data the
   * configuration explicitly declares as public reference data.
   */
  scope: readonly Filter[];
  /** Reference data shared by every session; requires explicit configuration. */
  public: boolean;
  /** Optional optimistic-lock property. */
  version?: string;
}

export interface PolicySet {
  /** Server-side clock zone used by `datetime-local` values. */
  serverTimeZone: string;
  /** Defaults applied when an endpoint does not override them. */
  defaultFreshnessSeconds: Readonly<Record<OfflineClass, number>>;
  /** Hard deny-list from configuration: never offline, whatever the analysis says. */
  onlineOnly: readonly string[];
}

export interface TestVector {
  id: string;
  endpoint: string;
  description: string;
  /** Seed rows per entity, in property names. */
  fixture: Readonly<Record<string, readonly Readonly<Record<string, JsonValue>>[]>>;
  context: Readonly<Record<string, JsonValue>>;
  request: {
    params: Readonly<Record<string, string>>;
    query: Readonly<Record<string, string>>;
    body?: JsonValue;
  };
  /** Computed by the local executor at build time, then checked against the backend. */
  expected?: {
    status: number;
    body: JsonValue | null;
  };
}

export interface AdapterIdentity {
  id: string;
  version: string;
  language: string;
  framework: string;
}

export interface AerisArtifact {
  format: typeof AERIS_IR_FORMAT;
  formatVersion: string;
  /** Monotonic business version of this artifact; the runtime refuses downgrades. */
  artifactVersion: number;
  runtimeMinVersion: string;
  /** Hash of the analyzed sources. */
  sourceRevision: string;
  /** Optional VCS commit of the backend. */
  sourceCommit?: string;
  createdAt: string;
  adapter: AdapterIdentity;
  /** Hash of the projection manifest; the local store re-snapshots when it changes. */
  projectionVersion: string;
  endpoints: readonly EndpointPlan[];
  projections: readonly Projection[];
  policies: PolicySet;
  testVectors: readonly TestVector[];
  diagnostics: readonly string[];
}

export interface AerisSignedArtifact {
  format: typeof AERIS_SIGNED_FORMAT;
  formatVersion: '1.0.0';
  algorithm: 'Ed25519';
  keyId: string;
  /** `sha256:<hex>` of the canonical artifact encoding. */
  digest: string;
  artifact: AerisArtifact;
  /** base64 Ed25519 signature over the canonical encoding of the header (all fields but artifact and signature). */
  signature: string;
}

/** Server-issued policy manifest (GET /aeris/policy): kill switches without redeploying. */
export interface PolicyManifest {
  /** Endpoints that must run online until further notice. */
  disabled: readonly string[];
  /** Per-endpoint freshness overrides, in seconds. */
  freshness: Readonly<Record<string, number>>;
  /** Artifacts below this version must not execute locally. */
  minArtifactVersion: number;
  issuedAt: string;
}
