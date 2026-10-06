import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { JavaProject, type SourceFile } from './java/model.js';

export interface DetectedConfig {
  yaml: string;
  notes: string[];
}

/**
 * Proposes an aeris.config.yaml from the sources: context holders (static
 * methods returning the session from the Reactor Context), the
 * Authentication class, an idempotency web filter and active profiles.
 */
export async function detectConfig(rootDir: string, files: readonly SourceFile[]): Promise<DetectedConfig> {
  const project = await JavaProject.load(files);
  const notes: string[] = [];
  const sources: { method: string; kind: string; type: string }[] = [];
  for (const type of project.types.values()) {
    for (const method of type.methods) {
      if (!method.modifiers.has('static') || method.params.length !== 0 || method.body === undefined) continue;
      if (!/deferContextual|ReactiveSecurityContextHolder/.test(method.body.text)) continue;
      if (method.returnType.name !== 'reactor.core.publisher.Mono') continue;
      const payload = method.returnType.args[0];
      if (payload === undefined) continue;
      const optional = payload.name === 'java.util.Optional';
      const record = project.type(optional ? payload.args[0]?.name ?? '' : payload.name);
      if (record === undefined || (record.kind !== 'record' && record.kind !== 'class')) continue;
      // A session carries identities (tenant, organization, user...), not request metadata.
      const components = record.kind === 'record' ? record.recordComponents : record.fields;
      // What identifies the *call* rather than the caller: a device has none of
      // it, so it is declared opaque instead of being invented. Checked first,
      // because such a record may well carry a UUID of its own (a request id).
      // Only the Optional form is modeled.
      const metadata = components.some((component) => /correlation|trace|span|remote|ip\b|address|agent|referer|httpmethod|requestpath|requesturi/i
        .test(component.name.replace(/[^a-z]/gi, '').toLowerCase()) || /^request(id|path|method|uri)$/i.test(component.name));
      if (optional && metadata) {
        sources.push({ method: `${type.simple}.${method.name}`, kind: 'metadata', type: record.fqn });
        continue;
      }
      // A session is recognized by shape, not by vocabulary: it carries at least
      // one identifier. Naming it `tenantId` or `workspaceId` is the backend's
      // business, not the compiler's.
      if (!components.some((component) => component.type.name === 'java.util.UUID')) {
        notes.push(`${type.simple}.${method.name} reads the Reactor Context but ${record.simple} carries no identifier: declare it yourself if it is the session.`);
        continue;
      }
      sources.push({ method: `${type.simple}.${method.name}`, kind: optional ? 'optional' : 'required', type: record.fqn });
    }
  }
  if (sources.length === 0) notes.push('No context holder found: declare context.sources for the session claims (tenant, organization, user).');
  // Bookkeeping candidates, proposed commented out and never enabled: a method
  // returning nothing is not necessarily inert (`deleteAll()` returns Mono<Void>
  // too), so each one is a decision the reader makes, not the detector.
  const inertCandidates: string[] = [];
  for (const type of project.types.values()) {
    if (!/audit|telemetry|metric|analytic|tracking|outbox|eventpublisher/i.test(type.simple.replace(/[^a-z]/gi, ''))) continue;
    for (const method of type.methods) {
      const returned = method.returnType;
      const payload = returned.args[0];
      const voidResult = returned.name === 'void'
        || (returned.name === 'reactor.core.publisher.Mono' && payload !== undefined && /(^|\.)Void$/.test(payload.name));
      if (voidResult) inertCandidates.push(`${type.simple}.${method.name}`);
    }
  }
  if (inertCandidates.length > 0) {
    notes.push(`${inertCandidates.length} method(s) look like server-side bookkeeping and are proposed commented out under inertEffects: enable only those whose sole effect the server redoes when the operation is replayed.`);
  }
  const authentication = [...project.types.values()].find((type) =>
    type.kind === 'class' && type.superclass !== undefined && /AbstractAuthenticationToken$/.test(type.superclass.name));
  const idempotencyFilter = files.find((file) => /implements\s+WebFilter/.test(file.content) && /Idempotency-Key/.test(file.content));
  if (idempotencyFilter !== undefined) notes.push(`Idempotency filter detected in ${idempotencyFilter.path}: check the covered methods and paths.`);
  else notes.push('No Idempotency-Key filter found: creations (POST) will stay online-only until the backend deduplicates replays.');
  let profiles: string[] = [];
  for (const candidate of ['src/main/resources/application.yml', 'src/main/resources/application.yaml']) {
    const found = files.find((file) => file.path.endsWith('Application.java'));
    const base = found === undefined ? rootDir : join(rootDir, found.path.split('/src/main/')[0] ?? '');
    try {
      const document = yaml.load(await readFile(join(base, candidate), 'utf8')) as { spring?: { profiles?: { active?: string } } } | undefined;
      const active = document?.spring?.profiles?.active;
      if (typeof active === 'string') profiles = active.split(',').map((profile) => profile.trim()).filter((profile) => !profile.startsWith('${'));
    } catch {
      // No configuration file at this location.
    }
  }
  const config = {
    activeProfiles: profiles,
    serverTimeZone: 'UTC',
    context: {
      sources,
      ...(authentication === undefined ? {} : { authentication: authentication.fqn }),
    },
    ...(idempotencyFilter === undefined ? {} : { idempotency: { header: 'Idempotency-Key', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], paths: ['/api/**'] } }),
    scopeClaims: { tenantId: ['tenantId'], organizationId: ['organizationId'] },
    publicEntities: [],
    onlineOnly: [],
  };
  const header = [
    '# AERIS Behavior Compiler configuration (generated by `aeris init`, review before use).',
    '# activeProfiles: Spring profiles of the production deployment (selects @Profile beans).',
    '# context.sources: static methods returning the verified session; their record components are the session claims.',
    "# A 'metadata' source carries what identifies the call (correlation, caller address), not the caller:",
    '# its value is present but opaque, so no endpoint whose answer depends on it can be served locally.',
    '# idempotency: only declare it if the backend really deduplicates replays carrying this header.',
    '# scopeClaims: which entity properties restrict rows to a session claim (projections never leave this scope).',
    '# publicEntities: reference data every session may hold. onlineOnly: endpoint globs that must never run offline.',
    '',
  ].join('\n');
  const suggestions = inertCandidates.length === 0 ? '' : [
    '',
    '# inertEffects: methods whose only effect is server-side bookkeeping (audit, access log, metrics,',
    '# event outbox). A declared call is skipped instead of analyzed, which holds because the server redoes',
    '# it when the operation is replayed through its API. The compiler refuses any declaration on a method',
    '# that returns a value, but returning nothing is not enough to be inert: uncomment only what you know.',
    '# inertEffects:',
    ...inertCandidates.map((candidate) => `#   - ${candidate}`),
    '',
  ].join('\n');
  return { yaml: header + yaml.dump(config, { lineWidth: 120 }) + suggestions, notes };
}
