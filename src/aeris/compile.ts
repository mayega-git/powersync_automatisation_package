import {
  AERIS_IR_VERSION,
  type AERISArtifact,
  type AdapterAnalysis,
  type BehaviorInstruction,
  type CompiledEndpoint,
  type EndpointFacts,
  type OfflinePolicy,
  type SourceEvidence,
} from './types.js';

export class AERISCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AERISCompileError';
  }
}

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REPLAY_SEMANTICS = new Set(['idempotent', 'server-revalidated', 'local-only', 'unknown']);
const EVIDENCE_KINDS = new Set([
  'route', 'database-read', 'database-write', 'validation', 'transaction',
  'external-effect', 'authorization', 'call', 'annotation',
]);

export function compileAnalysis(analysis: AdapterAnalysis): AERISArtifact {
  validateAnalysis(analysis);

  return {
    format: 'aeris-ir',
    formatVersion: AERIS_IR_VERSION,
    sourceRevision: analysis.sourceRevision,
    adapter: analysis.adapter,
    endpoints: analysis.endpoints.map(compileEndpoint),
    diagnostics: [...analysis.diagnostics],
  };
}

export function classifyEndpoint(endpoint: EndpointFacts): {
  policy: OfflinePolicy;
  reasons: readonly string[];
} {
  if (!endpoint.complete || endpoint.unresolved.length > 0) {
    return {
      policy: 'UNSUPPORTED',
      reasons: endpoint.unresolved.length > 0
        ? [...endpoint.unresolved]
        : ['The adapter did not prove that endpoint analysis is complete.'],
    };
  }

  if (endpoint.evidence.length === 0 || !hasValidEvidence(endpoint.evidence)) {
    return {
      policy: 'UNSUPPORTED',
      reasons: ['No verifiable source evidence was attached to this endpoint.'],
    };
  }

  if (!endpoint.deterministic) {
    return {
      policy: 'UNSUPPORTED',
      reasons: ['The local behavior is not deterministic.'],
    };
  }

  if (endpoint.requiresFreshAuthorization) {
    return {
      policy: 'ONLINE_REQUIRED',
      reasons: ['Authorization must be checked against the current server session.'],
    };
  }

  if (endpoint.hasIrreversibleExternalEffect) {
    return {
      policy: 'ONLINE_REQUIRED',
      reasons: ['The endpoint performs an irreversible external effect.'],
    };
  }

  if (endpoint.hasStrictGlobalInvariant) {
    return {
      policy: 'ONLINE_REQUIRED',
      reasons: ['The endpoint depends on a strict global invariant.'],
    };
  }

  if (isRead(endpoint.method) && endpoint.writes.length === 0) {
    if (endpoint.reads.length === 0) {
      return {
        policy: 'UNSUPPORTED',
        reasons: ['A read-only endpoint has no proven local data projection.'],
      };
    }
    return requireBehaviorPlan(endpoint, {
      policy: 'LOCAL_READ_SAFE',
      reasons: ['Read-only local projection is proven.'],
    });
  }

  if (endpoint.writes.length === 0) {
    return {
      policy: 'ONLINE_REQUIRED',
      reasons: ['The endpoint is not a supported read and has no proven local write.'],
    };
  }

  switch (endpoint.replaySemantics) {
    case 'local-only':
      return requireBehaviorPlan(endpoint, {
        policy: 'LOCAL_WRITE_SAFE',
        reasons: ['The write has no server-side effect.'],
      });
    case 'idempotent':
      return requireBehaviorPlan(endpoint, {
        policy: 'REPLAYABLE',
        reasons: ['Server replay is proven idempotent.'],
      });
    case 'server-revalidated':
      return requireBehaviorPlan(endpoint, {
        policy: 'SPECULATIVE',
        reasons: ['The result is provisional until the server revalidates the operation.'],
      });
    case 'unknown':
      return {
        policy: 'ONLINE_REQUIRED',
        reasons: ['Replay semantics have not been proven.'],
      };
  }
}

function requireBehaviorPlan(
  endpoint: EndpointFacts,
  decision: { policy: OfflinePolicy; reasons: readonly string[] },
): { policy: OfflinePolicy; reasons: readonly string[] } {
  if (endpoint.behaviorPlan !== undefined) return decision;
  return {
    policy: 'UNSUPPORTED',
    reasons: ['No executable local behavior plan was emitted for this endpoint.'],
  };
}

function compileEndpoint(endpoint: EndpointFacts): CompiledEndpoint {
  const result = classifyEndpoint(endpoint);
  return { ...endpoint, policy: result.policy, policyReasons: result.reasons };
}

function validateAnalysis(analysis: AdapterAnalysis): void {
  if (analysis === null || typeof analysis !== 'object') {
    throw new AERISCompileError('An adapter analysis object is required.');
  }
  if (!analysis.sourceRevision.trim()) {
    throw new AERISCompileError('A source revision is required to make an artifact traceable.');
  }
  if (!analysis.adapter.id.trim() || !analysis.adapter.version.trim() ||
      !analysis.adapter.language.trim() || !analysis.adapter.framework.trim()) {
    throw new AERISCompileError('Adapter identity, version, language and framework are required.');
  }
  if (!Array.isArray(analysis.endpoints) || !Array.isArray(analysis.diagnostics) ||
      analysis.diagnostics.some((diagnostic) => typeof diagnostic !== 'string')) {
    throw new AERISCompileError('Adapter endpoints and diagnostics must be arrays of valid values.');
  }

  const seen = new Set<string>();
  for (const endpoint of analysis.endpoints) {
    if (endpoint === null || typeof endpoint !== 'object') {
      throw new AERISCompileError('An endpoint analysis must be an object.');
    }
    if (typeof endpoint.operationId !== 'string' || endpoint.operationId.trim().length === 0) {
      throw new AERISCompileError('Every endpoint requires a non-empty operation id.');
    }
    if (seen.has(endpoint.operationId)) {
      throw new AERISCompileError(`Duplicate operation id: ${endpoint.operationId}.`);
    }
    seen.add(endpoint.operationId);

    if (!HTTP_METHODS.has(endpoint.method)) {
      throw new AERISCompileError(`${endpoint.operationId} has an unsupported HTTP method.`);
    }
    if (typeof endpoint.path !== 'string' || !endpoint.path.startsWith('/') ||
        endpoint.path.includes('?') || endpoint.path.includes('#')) {
      throw new AERISCompileError(`${endpoint.operationId} has an invalid path; use an absolute path without query or fragment.`);
    }
    if (!REPLAY_SEMANTICS.has(endpoint.replaySemantics)) {
      throw new AERISCompileError(`${endpoint.operationId} has unknown replay semantics.`);
    }
    if ([endpoint.complete, endpoint.deterministic, endpoint.requiresFreshAuthorization,
      endpoint.hasStrictGlobalInvariant, endpoint.hasIrreversibleExternalEffect].some(
      (value) => typeof value !== 'boolean')) {
      throw new AERISCompileError(`${endpoint.operationId} has invalid analysis flags.`);
    }
    if (!Array.isArray(endpoint.reads) || !Array.isArray(endpoint.writes) ||
        !Array.isArray(endpoint.evidence) || !Array.isArray(endpoint.unresolved) ||
        (endpoint.calls !== undefined && !Array.isArray(endpoint.calls)) ||
        endpoint.unresolved.some((item: unknown) => typeof item !== 'string')) {
      throw new AERISCompileError(`${endpoint.operationId} has malformed analysis collections.`);
    }
    if (endpoint.behaviorPlan !== undefined) {
      validateBehaviorPlan(endpoint.operationId, endpoint.behaviorPlan);
      if (endpoint.writes.length > 0 &&
          ['idempotent', 'server-revalidated'].includes(endpoint.replaySemantics) &&
          !endpoint.behaviorPlan.instructions.some((instruction: BehaviorInstruction) =>
            instruction.op === 'QUEUE_INTENT')) {
        throw new AERISCompileError(`${endpoint.operationId} has replayable writes but no QUEUE_INTENT instruction.`);
      }
    }
    if (endpoint.operationId !== `${endpoint.method} ${endpoint.path}`) {
      throw new AERISCompileError(`${endpoint.operationId} does not match its HTTP method and path.`);
    }
    if (endpoint.evidence.length > 0 && !hasValidEvidence(endpoint.evidence)) {
      throw new AERISCompileError(`${endpoint.operationId} contains invalid source evidence.`);
    }
    for (const call of endpoint.calls ?? []) {
      if (typeof call.name !== 'string' || call.name.trim().length === 0 ||
          (call.receiver !== undefined && typeof call.receiver !== 'string') ||
          typeof call.caller !== 'string' || call.caller.trim().length === 0 ||
          !Number.isInteger(call.argumentCount) || call.argumentCount < 0 ||
          !['implicit', 'qualified', 'chain'].includes(call.dispatch) ||
          !['resolved', 'known-library', 'ambiguous', 'unresolved'].includes(call.resolution) ||
          (call.receiverType !== undefined && typeof call.receiverType !== 'string') ||
          (call.resolution === 'resolved' &&
            (![call.targetClass, call.targetFile, call.targetMethod].every(
              (value) => typeof value === 'string' && value.trim().length > 0,
            ))) ||
          !hasValidEvidence([call.evidence]) || call.evidence.kind !== 'call') {
        throw new AERISCompileError(`${endpoint.operationId} contains an invalid call-site record.`);
      }
    }

    const accesses = [...endpoint.reads, ...endpoint.writes];
    for (const access of accesses) {
      if (access.entity.trim().length === 0) {
        throw new AERISCompileError(`${endpoint.operationId} contains an unnamed data entity.`);
      }
      if (!hasValidEvidence(access.evidence)) {
        throw new AERISCompileError(
          `${endpoint.operationId} has a data access without valid source evidence.`,
        );
      }
    }
  }
}

function validateBehaviorPlan(operationId: string, plan: unknown): void {
  if (!isRecord(plan) || plan.engine !== 'aeris-behavior-v1' || !Array.isArray(plan.instructions) ||
      plan.instructions.length === 0 || plan.instructions.at(-1) === undefined ||
      !isRecord(plan.instructions.at(-1)) || plan.instructions.at(-1)!.op !== 'RETURN' ||
      plan.instructions.filter((instruction: unknown) => isRecord(instruction) && instruction.op === 'RETURN').length !== 1 ||
      !plan.instructions.every((instruction: unknown) => isBehaviorInstruction(operationId, instruction))) {
    throw new AERISCompileError(`${operationId} has a malformed or non-terminating behavior plan.`);
  }
}

function isBehaviorInstruction(operationId: string, instruction: unknown): boolean {
  if (!isRecord(instruction)) return false;
  switch (instruction.op) {
    case 'QUERY':
      return hasExactKeys(instruction, ['op', 'entity', 'output', 'filters']) &&
        isIdentifier(instruction.entity) && isIdentifier(instruction.output) && isFilters(instruction.filters);
    case 'ASSERT':
      return hasExactKeys(instruction, ['op', 'filter']) && isFilter(instruction.filter);
    case 'COMPUTE':
      return hasExactKeys(instruction, ['op', 'output', 'operation', 'operands']) &&
        isIdentifier(instruction.output) && ['concat', 'add', 'subtract'].includes(String(instruction.operation)) &&
        Array.isArray(instruction.operands) && instruction.operands.length > 0 &&
        instruction.operands.every(isBehaviorValue) &&
        (instruction.operation === 'concat' || instruction.operands.length === 2);
    case 'INSERT':
      return hasExactKeys(instruction, ['op', 'entity', 'values']) && isIdentifier(instruction.entity) &&
        isBehaviorValues(instruction.values);
    case 'UPDATE':
      return hasExactKeys(instruction, ['op', 'entity', 'filters', 'values']) && isIdentifier(instruction.entity) &&
        isFilters(instruction.filters) && instruction.filters.length > 0 && isBehaviorValues(instruction.values);
    case 'DELETE':
      return hasExactKeys(instruction, ['op', 'entity', 'filters']) && isIdentifier(instruction.entity) &&
        isFilters(instruction.filters) && instruction.filters.length > 0;
    case 'QUEUE_INTENT':
      return hasExactKeys(instruction, ['op', 'operationId', 'payload']) &&
        instruction.operationId === operationId && isBehaviorValue(instruction.payload);
    case 'RETURN':
      return hasExactKeys(instruction, ['op', 'value']) && isBehaviorValue(instruction.value);
    default:
      return false;
  }
}

function isBehaviorValues(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0 &&
    Object.entries(value).every(([key, operand]) => isIdentifier(key) && isBehaviorValue(operand));
}

function isFilters(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every(isFilter);
}

function isFilter(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['field', 'operator', 'value']) &&
    isIdentifier(value.field) && ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(String(value.operator)) &&
    isBehaviorValue(value.value);
}

function isBehaviorValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.source === 'input' || value.source === 'path' || value.source === 'variable') {
    return hasExactKeys(value, ['source', 'name']) && isIdentifier(value.name);
  }
  return value.source === 'constant' && hasExactKeys(value, ['source', 'value']) &&
    (value.value === null || ['string', 'number', 'boolean'].includes(typeof value.value)) &&
    (typeof value.value !== 'number' || Number.isFinite(value.value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function hasValidEvidence(evidence: readonly SourceEvidence[]): boolean {
  return evidence.length > 0 && evidence.every((item) =>
    typeof item.file === 'string' && item.file.trim().length > 0 &&
    typeof item.symbol === 'string' && item.symbol.trim().length > 0 &&
    EVIDENCE_KINDS.has(item.kind) &&
    typeof item.excerptHash === 'string' && /^[a-f0-9]{64}$/i.test(item.excerptHash) &&
    Number.isInteger(item.startLine) &&
    Number.isInteger(item.endLine) &&
    item.startLine > 0 &&
    item.endLine >= item.startLine,
  );
}

function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}
