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
  const sources: { method: string; kind: string; type?: string; claim?: string }[] = [];
  /** Session accessors returning one identifier, resolved once the records are known. */
  const claimCandidates: { method: string; payload: string }[] = [];
  for (const type of project.types.values()) {
    for (const method of type.methods) {
      if (!method.modifiers.has('static') || method.params.length !== 0 || method.body === undefined) continue;
      if (!/deferContextual|ReactiveSecurityContextHolder/.test(method.body.text)) continue;
      if (method.returnType.name !== 'reactor.core.publisher.Mono') continue;
      const payload = method.returnType.args[0];
      if (payload === undefined) continue;
      const optional = payload.name === 'java.util.Optional';
      const record = project.type(optional ? payload.args[0]?.name ?? '' : payload.name);
      if (record === undefined || (record.kind !== 'record' && record.kind !== 'class')) {
        // A holder that hands back a single identifier rather than the whole
        // session (`getCurrentUserId(): Mono<UUID>`). Which claim it is cannot
        // be decided here, because the session records are still being
        // collected, so it is resolved below against their components.
        if (!optional && /^(java\.util\.UUID|java\.lang\.String)$/.test(payload.name)) {
          claimCandidates.push({ method: `${type.simple}.${method.name}`, payload: payload.name });
        }
        continue;
      }
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
  // Either the class or the method may carry the intent: `AuditService.save`
  // and `ActivityLog.record` are the same thing under two vocabularies.
  const bookkeeping = /audit|telemetry|metric|analytic|tracking|outbox|activity|journal|history|eventpublisher/i;
  const bookkeepingVerb = /^(record|log|audit|track|trace|publish|emit|notify|report|append|register)[A-Z]?/;
  const inertCandidates: string[] = [];
  for (const type of project.types.values()) {
    const named = bookkeeping.test(type.simple.replace(/[^a-z]/gi, ''));
    for (const method of type.methods) {
      if (!named && !bookkeepingVerb.test(method.name)) continue;
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
  // The claims that can restrict a row are the session's own identifiers, read
  // off the record the holder returns — not a vocabulary decided in advance.
  const scopeClaims: Record<string, string[]> = {};
  for (const source of sources) {
    if (source.kind === 'metadata' || source.type === undefined) continue;
    const record = project.type(source.type);
    if (record === undefined) continue;
    for (const component of record.kind === 'record' ? record.recordComponents : record.fields) {
      if (component.type.name === 'java.util.UUID') scopeClaims[component.name] = [component.name];
    }
  }
  if (Object.keys(scopeClaims).length === 0) notes.push('No session identifier found: fill scopeClaims with the entity properties that restrict a row to a session.');

  // A holder returning one identifier is a `claim` source, but only when the
  // claim it returns is *proven*: its name has to match a component of a
  // session record found above. `getCurrentUserId` next to a `User` carrying
  // `userId` is that proof; anything else is reported, never guessed, because
  // naming the wrong claim would scope every row by the wrong identity.
  const sessionClaims = new Map<string, string>();
  for (const source of sources) {
    if (source.kind === 'metadata' || source.type === undefined) continue;
    const record = project.type(source.type);
    if (record === undefined) continue;
    for (const component of record.kind === 'record' ? record.recordComponents : record.fields) {
      sessionClaims.set(component.name.toLowerCase(), component.name);
    }
  }
  for (const candidate of claimCandidates) {
    const accessor = candidate.method.slice(candidate.method.indexOf('.') + 1);
    const stripped = accessor.replace(/^(get|current|fetch|resolve|require)+/i, '').replace(/^(current|authenticated|connected|logged(In)?)/i, '');
    const claim = sessionClaims.get(stripped.toLowerCase());
    if (claim === undefined) {
      notes.push(`${candidate.method} returns a single ${candidate.payload.split('.').pop()} from the session but no claim is named ${stripped || accessor}: add it as a 'claim' source yourself if it is one.`);
      continue;
    }
    sources.push({ method: candidate.method, kind: 'claim', claim });
  }

  const authentication = [...project.types.values()].find((type) =>
    type.kind === 'class' && type.superclass !== undefined && /AbstractAuthenticationToken$/.test(type.superclass.name));
  const idempotencyFilter = files.find((file) => /implements\s+WebFilter/.test(file.content) && /Idempotency-Key/.test(file.content));
  if (idempotencyFilter !== undefined) notes.push(`Idempotency filter detected in ${idempotencyFilter.path}: check the covered methods and paths.`);
  else notes.push('No Idempotency-Key filter found: creations (POST) will stay online-only until the backend deduplicates replays.');
  let profiles: string[] = [];
  // Every module root the sources reveal, so a single-module project (`src/main/java/...`)
  // is found as readily as one module of a multi-module build (`service-a/src/main/java/...`).
  const moduleRoots = new Set<string>();
  for (const file of files) {
    const marker = file.path.indexOf('src/main/java/');
    if (marker >= 0) moduleRoots.add(file.path.slice(0, marker));
  }
  if (moduleRoots.size === 0) moduleRoots.add('');
  for (const candidate of [...moduleRoots].flatMap((module) =>
    ['src/main/resources/application.yml', 'src/main/resources/application.yaml'].map((name) => join(module, name)))) {
    const base = rootDir;
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
    scopeClaims,
    publicEntities: [],
    onlineOnly: [],
  };
  const header = [
    '# AERIS Behavior Compiler configuration (generated by `aeris init`, review before use).',
    '# activeProfiles: Spring profiles of the production deployment (selects @Profile beans).',
    '# context.sources: static methods returning the verified session; their record components are the session claims.',
    "# A 'claim' source returns one identifier of that session (getCurrentUserId): check it is the claim named.",
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
