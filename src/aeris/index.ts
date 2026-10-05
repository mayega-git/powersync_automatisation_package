export { AERISCompileError, classifyEndpoint, compileAnalysis } from './compile.js';
export { compileProject, type ProjectCompileOptions, type ProjectCompileResult } from './ProjectCompiler.js';
export type { CompilerAdapter, SourceFile } from './CompilerAdapter.js';
export { SpringBootAdapter } from './SpringBootAdapter.js';
export { signAERISArtifact, verifyAERISArtifact } from './signature.js';
export {
  AERIS_IR_VERSION,
  type AERISArtifact,
  type AERISSignedArtifact,
  type AdapterAnalysis,
  type AdapterIdentity,
  type BehaviorFilter,
  type BehaviorInstruction,
  type BehaviorPlan,
  type BehaviorValue,
  type CallSite,
  type CompiledEndpoint,
  type DataAccess,
  type EndpointFacts,
  type EvidenceKind,
  type HttpMethod,
  type OfflinePolicy,
  type ReplaySemantics,
  type SourceEvidence,
} from './types.js';
