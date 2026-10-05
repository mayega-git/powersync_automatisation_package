import { assemble } from '../../../src/aeris/compiler/assemble.js';
import { mergeConfig } from '../../../src/aeris/compiler/config.js';
import { JavaProject } from '../../../src/aeris/compiler/java/model.js';
import { compileEndpoints } from '../../../src/aeris/compiler/spring/endpoints.js';
import { ExceptionHandlers } from '../../../src/aeris/compiler/spring/errors.js';
import { PersistenceModel } from '../../../src/aeris/compiler/spring/persistence.js';
import type { AerisArtifact, EndpointPlan, JsonValue } from '../../../src/aeris/ir/types.js';
import { AerisHttpError, Executor } from '../../../src/aeris/runtime/executor.js';
import { MemoryStore } from '../../../src/aeris/runtime/store/MemoryStore.js';

export const CONTEXT_SOURCES = `
package demo.kernel;
import reactor.core.publisher.Mono;
import java.util.UUID;
public record TenantContext(UUID tenantId, UUID organizationId, UUID userId) {}
`;

export const HOLDER = `
package demo.kernel;
import reactor.core.publisher.Mono;
public final class RequestContextHolder {
  private RequestContextHolder() {}
  public static Mono<TenantContext> getRequiredContext() {
    return Mono.deferContextual(ctx -> Mono.just(ctx.get("tenant")));
  }
}
`;

export async function compileJava(sources: Record<string, string>, config: Record<string, unknown> = {}): Promise<AerisArtifact> {
  const files = Object.entries({ 'demo/kernel/TenantContext.java': CONTEXT_SOURCES, 'demo/kernel/RequestContextHolder.java': HOLDER, ...sources })
    .map(([path, content]) => ({ path, content }));
  const merged = mergeConfig({
    context: { sources: [{ method: 'RequestContextHolder.getRequiredContext', kind: 'required', type: 'demo.kernel.TenantContext' }] },
    idempotency: { header: 'Idempotency-Key', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], paths: ['/api/**'] },
    ...config,
  });
  const project = await JavaProject.load(files, merged.activeProfiles);
  const diagnostics: string[] = [];
  const drafts = compileEndpoints({ project, persistence: new PersistenceModel(project), config: merged, handlers: new ExceptionHandlers(project) }, diagnostics);
  return assemble({ drafts, config: merged, adapter: { id: 'test', version: '1', language: 'java', framework: 'spring' }, sourceRevision: 'sha256:test', diagnostics });
}

export function endpoint(artifact: AerisArtifact, id: string): EndpointPlan {
  const plan = artifact.endpoints.find((candidate) => candidate.id === id);
  if (plan === undefined) throw new Error(`No endpoint ${id}; have ${artifact.endpoints.map((candidate) => candidate.id).join(', ')}`);
  return plan;
}

/** Runs an endpoint program on rows, returning status and body like the backend would. */
export async function run(
  artifact: AerisArtifact,
  id: string,
  rows: Record<string, Record<string, JsonValue>[]>,
  request: { params?: Record<string, string>; query?: Record<string, string>; body?: JsonValue; context: Record<string, JsonValue> },
): Promise<{ status: number; body: JsonValue | null; code?: string }> {
  const plan = endpoint(artifact, id);
  const projections = new Map(artifact.projections.map((projection) => [projection.entity, projection]));
  const store = new MemoryStore();
  await store.open(artifact.projections);
  await store.transaction(async (tx) => {
    for (const [entity, list] of Object.entries(rows)) for (const row of list) await tx.put(entity, row);
  });
  const executor = new Executor({ projections, serverTimeZone: 'UTC' });
  try {
    const result = await store.transaction((tx) => executor.execute(plan, {
      params: request.params ?? {}, query: request.query ?? {}, body: request.body, context: request.context, path: plan.path,
    }, { now: Date.parse('2026-03-01T10:00:00Z'), uuids: Array.from({ length: plan.uuidSlots }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`) }, tx));
    return { status: result.status, body: result.body };
  } catch (error) {
    if (error instanceof AerisHttpError) return { status: error.status, body: error.body ?? null, code: error.code };
    throw error;
  }
}
