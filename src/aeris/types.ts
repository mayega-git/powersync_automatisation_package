export const AERIS_IR_VERSION = '0.2.0' as const;

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type OfflinePolicy =
  | 'LOCAL_READ_SAFE'
  | 'LOCAL_WRITE_SAFE'
  | 'REPLAYABLE'
  | 'SPECULATIVE'
  | 'ONLINE_REQUIRED'
  | 'UNSUPPORTED';

export type EvidenceKind =
  | 'route'
  | 'database-read'
  | 'database-write'
  | 'validation'
  | 'transaction'
  | 'external-effect'
  | 'authorization'
  | 'call'
  | 'annotation';

export interface SourceEvidence {
  file: string;
  symbol: string;
  kind: EvidenceKind;
  startLine: number;
  endLine: number;
  excerptHash: string;
}

export interface DataAccess {
  entity: string;
  fields?: readonly string[];
  evidence: readonly SourceEvidence[];
}

export type BehaviorValue =
  | { source: 'input'; name: string }
  | { source: 'path'; name: string }
  | { source: 'constant'; value: string | number | boolean | null }
  | { source: 'variable'; name: string };

export interface BehaviorFilter {
  field: string;
  operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
  value: BehaviorValue;
}

export type BehaviorInstruction =
  | { op: 'QUERY'; entity: string; output: string; filters: readonly BehaviorFilter[] }
  | { op: 'ASSERT'; filter: BehaviorFilter }
  | { op: 'COMPUTE'; output: string; operation: 'concat' | 'add' | 'subtract'; operands: readonly BehaviorValue[] }
  | { op: 'INSERT'; entity: string; values: Readonly<Record<string, BehaviorValue>> }
  | { op: 'UPDATE'; entity: string; filters: readonly BehaviorFilter[]; values: Readonly<Record<string, BehaviorValue>> }
  | { op: 'DELETE'; entity: string; filters: readonly BehaviorFilter[] }
  | { op: 'QUEUE_INTENT'; operationId: string; payload: BehaviorValue }
  | { op: 'RETURN'; value: BehaviorValue };

export interface BehaviorPlan {
  engine: 'aeris-behavior-v1';
  instructions: readonly BehaviorInstruction[];
}

export interface CallSite {
  name: string;
  receiver?: string;
  caller: string;
  argumentCount: number;
  dispatch: 'implicit' | 'qualified' | 'chain';
  resolution: 'resolved' | 'known-library' | 'ambiguous' | 'unresolved';
  receiverType?: string;
  targetClass?: string;
  targetFile?: string;
  targetMethod?: string;
  evidence: SourceEvidence;
}

export type ReplaySemantics =
  | 'idempotent'
  | 'server-revalidated'
  | 'local-only'
  | 'unknown';

export interface EndpointFacts {
  operationId: string;
  method: HttpMethod;
  path: string;
  complete: boolean;
  deterministic: boolean;
  requiresFreshAuthorization: boolean;
  hasStrictGlobalInvariant: boolean;
  hasIrreversibleExternalEffect: boolean;
  replaySemantics: ReplaySemantics;
  reads: readonly DataAccess[];
  writes: readonly DataAccess[];
  behaviorPlan?: BehaviorPlan;
  calls?: readonly CallSite[];
  evidence: readonly SourceEvidence[];
  unresolved: readonly string[];
}

export interface CompiledEndpoint extends EndpointFacts {
  policy: OfflinePolicy;
  policyReasons: readonly string[];
}

export interface AdapterIdentity {
  id: string;
  version: string;
  language: string;
  framework: string;
}

export interface AdapterAnalysis {
  adapter: AdapterIdentity;
  sourceRevision: string;
  endpoints: readonly EndpointFacts[];
  diagnostics: readonly string[];
}

export interface AERISArtifact {
  format: 'aeris-ir';
  formatVersion: typeof AERIS_IR_VERSION;
  sourceRevision: string;
  adapter: AdapterIdentity;
  endpoints: readonly CompiledEndpoint[];
  diagnostics: readonly string[];
}

export interface AERISSignedArtifact {
  format: 'aeris-signed-ir';
  formatVersion: '1.0.0';
  algorithm: 'Ed25519';
  keyId: string;
  artifact: AERISArtifact;
  signature: string;
}
