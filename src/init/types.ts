import type { Connectivity } from '../core/OperationMapping.js';

// --- What the developer fills in config.yaml ---

export interface WrapperSpec {
  /** JSDoc tag that marks a server call. Placed directly in front of the path, not the function. */
  jsDocTag: string;
}

/** Which calls to keep. Criteria apply to BROWSER paths, matched against the operations table. */
export interface ScopeFilter {
  /** Keep calls whose path starts with one of these. Empty = all. */
  pathPrefixes: string[];
  /** Exclude these: they stay online only. */
  onlineOnlyPathPrefixes: string[];
}

/** Where calls live, on each side. */
export interface RouteDirectories {
  /** Browser calls to the BFF. */
  browser: string[];
  /** BFF calls to the remote server. Optional. */
  server: string[];
}

/** Where to reach the sync engine's admin API, and which buckets belong to this platform. */
export interface PowerSyncAdminSpec {
  adminUrl: string;
  /** A trailing star is accepted (`yownews_*`). Empty means "all". */
  buckets: string[];
  /** Where to write the application's schema file. */
  schemaFile: string;
  /** Endpoint that mints a token sized for the engine, distinct from the user's session. */
  tokenEndpoint?: string;
}

export interface SyncConfig {
  routes: RouteDirectories;
  /** Where to find the operations table. Defaults to the project root. */
  operations?: string;
  httpWrapper: WrapperSpec;
  /** Optional: without it, `schema` refuses to run and `discover` falls back to guessed table names. */
  powersync?: PowerSyncAdminSpec;
  /** Optional: without it, `discover` still scans and produces a draft, just without documented response shapes. */
  docSource?: string;
  scope: ScopeFilter;
}

// --- What the scan finds in the source code ---

/** Only meaningful while analyzing not-yet-executed code; at runtime every segment is a concrete value. */
export type SegmentKind =
  | 'Literal'
  | 'Identifier'
  /** A value that can target several endpoints, e.g. `${kind}`. Never guessed. */
  | 'Selector'
  | 'Unresolved';

export interface PathSegment {
  raw: string;
  kind: SegmentKind;
}

export interface DiscoveredCallSite {
  file: string;
  line: number;
  method: string;
  pathExpression: string;
  segments: PathSegment[];
  /** Set only if the path couldn't be fully understood. */
  unresolvedReason?: string;
}

// --- What the server documentation gives ---

export interface OpenApiOperation {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  /** Sample response, or the expected shape. Only for the developer writing a handler by hand. */
  responseSuccess?: string;
  responseFailure?: string;
}

export interface OpenApiDocument {
  operations: OpenApiOperation[];
}

// --- What the two generated files have in common ---

/** An operation ready to be written, into the map draft as well as the handlers draft. */
export interface OperationDraft {
  /** Name the handler is exported under and designated by `handle`. */
  handlerName: string;
  method: string;
  /** Normalized path: holes written `{name}`, no query string. */
  path: string;
  /** Hole names, in path order. */
  paramNames: string[];
  /** Table name: read from the schema when there, guessed otherwise. */
  table: string;
  /** Where that name came from -- the only thing separating a SURE name from a PLAUSIBLE one. */
  tableOrigin: TableOrigin;
  /** What to tell the developer when the name isn't established. */
  tableReason?: string;
  /** Replicated columns, when the schema knows them. */
  tableColumns?: string[];
  /** `file:line` of every call site. */
  callSites: string[];
  /** Matching documented endpoint, when there is one. */
  documentedAs?: string;
  /** Several possible documented endpoints: to resolve by hand. */
  ambiguous: boolean;
  /** Path segments that weren't fully understood; the chosen name is a guess. */
  uncertainSegments: string[];
  /** Declared in the table. Absent when the draft comes from a scan. */
  connectivity?: Connectivity;
  /** Server endpoint, when the table declares one. */
  serverPath?: string;
  /** Documented response shape for that server endpoint. */
  responseShape?: string;
}

/** `schema`: read from the generated schema file. Sure. `guess`: inferred from the HTTP path. Plausible. */
export type TableOrigin = 'schema' | 'guess';

// --- The operations table, source of truth ---

/** A row of offline-sync.operations.md: written by an agent, reviewed by a human, read by the module. */
export interface OperationRow {
  /** Names the operation and the handler. Unique across the document. */
  key: string;
  /** What the browser calls -- what gets intercepted and replayed. */
  method: string;
  path: string;
  /** What the BFF calls -- leads to the documented response. Absent is valid for an aggregating route. */
  serverMethod?: string;
  serverPath?: string;
  connectivity: Connectivity;
  /** `file:line` of the call in the code, to check the row against the code. */
  declaredIn: string;
  /** Where this row sits in the document, for error messages. */
  line: number;
}
