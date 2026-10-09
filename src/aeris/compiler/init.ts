import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { JavaProject, type SourceFile, type TypeDecl } from './java/model.js';

export interface DetectedConfig {
  yaml: string;
  notes: string[];
}

/**
 * Proposes an aeris.config.yaml from the sources: context holders (static
 * methods returning the session from the Reactor Context), the
 * Authentication class, an idempotency web filter and active profiles.
 */
/**
 * The Reactor Context key a holder reads: `ctx.get(USER_ID_KEY)` where
 * `USER_ID_KEY = "userId"` names the claim `userId`. Only a constant of the
 * holder's own class counts; anything else leaves the name to the method.
 */
function contextKey(type: TypeDecl, body: string): { key: string } | undefined {
  const read = /\.\s*(?:get|hasKey)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(body);
  if (read === null) return undefined;
  const field = type.fields.find((candidate) => candidate.name === read[1] && candidate.modifiers.has('static'));
  const literal = field?.initializer === undefined ? undefined : /^\s*"([^"\\]*)"\s*$/.exec(field.initializer.text);
  return literal === null || literal === undefined ? undefined : { key: literal[1]! };
}

export async function detectConfig(rootDir: string, files: readonly SourceFile[]): Promise<DetectedConfig> {
  const project = await JavaProject.load(files);
  const notes: string[] = [];
  const sources: { method: string; kind: string; type?: string; claim?: string }[] = [];
  /** Session accessors returning one claim, resolved once the records are known. */
  const claimCandidates: { method: string; payload: string; key?: string }[] = [];
  for (const type of project.types.values()) {
    // A class holding the session in a static ThreadLocal a filter fills: not
    // reactive, but the same thing -- the verified session, read without a
    // parameter. The usual shape in Spring MVC, and what such a ThreadLocal is
    // *otherwise* is shared mutable state the compiler refuses, so leaving it
    // undetected costs every handler that reads the session this way.
    // Every static no-argument accessor of such a class is a session accessor;
    // what it returns says which kind.
    const held = new Set(type.fields
      .filter((field) => /^(java\.lang\.)?ThreadLocal$/.test(field.type.name) && field.modifiers.has('static'))
      .flatMap((field) => {
        const argument = field.type.args[0];
        return argument === undefined ? [] : [argument.name, argument.name.split('.').at(-1)!];
      }));
    for (const method of type.methods) {
      if (!method.modifiers.has('static') || method.params.length !== 0 || method.body === undefined) continue;
      const reactive = /deferContextual|ReactiveSecurityContextHolder/.test(method.body.text)
        && method.returnType.name === 'reactor.core.publisher.Mono';
      if (!reactive && held.size === 0) continue;
      // A reactive holder answers Mono<T>; a blocking one answers T itself.
      const payload = reactive ? method.returnType.args[0] : method.returnType;
      if (payload === undefined) continue;
      const optional = payload.name === 'java.util.Optional';
      const inner = optional ? payload.args[0] : payload;
      if (inner === undefined) continue;
      const record = project.type(inner.name);
      if (record === undefined || (record.kind !== 'record' && record.kind !== 'class')) {
        // A holder that hands back a single identifier rather than the whole
        // session (`getCurrentUserId()`). Which claim it is cannot be decided
        // here, because the session records are still being collected, so it is
        // resolved below against their components.
        if (!optional && /^(java\.util\.UUID|java\.lang\.String)$/.test(inner.name)) {
          claimCandidates.push({ method: `${type.simple}.${method.name}`, payload: inner.name, ...(contextKey(type, method.body.text) ?? {}) });
        }
        continue;
      }
      // For a blocking holder the session is what the ThreadLocal actually
      // holds; any other record a static method of that class returns is not.
      if (!reactive && !held.has(record.fqn) && !held.has(record.simple)) continue;
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
  // A holder returning one identifier rather than the whole session
  // (`getCurrentUserId(): Mono<UUID>`) is a `claim` source. Which claim it
  // returns is read off a session record found in the same sources whenever
  // there is one -- `getCurrentUserId` next to a `User` carrying `userId` is
  // that proof. A backend that has no such record (its holder hands back only
  // identifiers) leaves the accessor's own name as the only evidence, so the
  // name is proposed and the note says to check it: a wrong claim here scopes
  // every row by the wrong identity. An accessor returning something other
  // than an identifier is never proposed -- a String may be a username, a
  // role or a locale, and nothing in the sources says which.
  const sessionClaims = new Map<string, string>();
  for (const source of sources) {
    if (source.kind === 'metadata' || source.type === undefined) continue;
    const record = project.type(source.type);
    if (record === undefined) continue;
    for (const component of record.kind === 'record' ? record.recordComponents : record.fields) {
      if (component.type.name === 'java.util.UUID') sessionClaims.set(component.name.toLowerCase(), component.name);
    }
  }
  const proposedClaims: string[] = [];
  /** Claims that are identifiers: only these may restrict a row. */
  const identifierClaims = new Set<string>();
  // The claim's name comes from a session record when there is one, and from
  // the accessor otherwise. A claim that is not an identifier is still worth
  // declaring -- a handler that reads it has no other way to -- but it never
  // reaches `scopeClaims` below, so it cannot silently become the vocabulary a
  // projection is restricted by.
  const resolved = claimCandidates.map((candidate) => {
    const accessor = candidate.method.slice(candidate.method.indexOf('.') + 1);
    const stripped = accessor.replace(/^(get|fetch|resolve|require)+/i, '').replace(/^(current|authenticated|connected|logged(In)?)/i, '');
    const identifier = candidate.payload === 'java.util.UUID';
    const known = identifier ? sessionClaims.get(stripped.toLowerCase()) : undefined;
    // The Reactor Context key the accessor reads *is* the claim's name in the
    // backend's own vocabulary -- better evidence than the method's name, and
    // it is the name `contextWrite` is checked against downstream.
    const derived = candidate.key ?? (stripped.length === 0 ? undefined : stripped[0]!.toLowerCase() + stripped.slice(1));
    return { candidate, identifier, proven: known !== undefined, claim: known ?? derived };
  });
  // One identity, one claim. `getCurrentOrganization()` and `getOrganizationId()`
  // are the same identifier spelled two ways, and declaring it twice under two
  // names would make the configuration contradict itself -- the backend's own
  // more explicit spelling wins.
  const everyName = resolved.map((entry) => entry.claim).filter((claim): claim is string => claim !== undefined);
  const canonical = (claim: string): string => {
    const longer = everyName.find((other) => other !== claim && other.toLowerCase() === `${claim.toLowerCase()}id`);
    return longer ?? claim;
  };
  for (const entry of resolved) {
    if (entry.claim === undefined) {
      notes.push(`${entry.candidate.method} reads the session but its name says nothing about which claim: declare it yourself.`);
      continue;
    }
    const claim = entry.proven ? entry.claim : canonical(entry.claim);
    sources.push({ method: entry.candidate.method, kind: 'claim', claim });
    if (entry.identifier) identifierClaims.add(claim);
    if (!entry.proven) proposedClaims.push(`${claim}${entry.identifier ? '' : ' (not an identifier)'}`);
  }
  if (proposedClaims.length > 0) {
    const named = [...new Set(proposedClaims)];
    notes.push(`${named.map((claim) => `'${claim}'`).join(', ')} ${named.length === 1 ? 'is a claim name' : 'are claim names'} read off the accessor names: confirm each one is the claim the backend really puts in the session. Only the identifiers among them restrict rows.`);
  }

  // The claims that can restrict a row are the session's own identifiers, read
  // off the record the holder returns -- or off the claim sources when the
  // backend has no record. Never a vocabulary decided in advance.
  const scopeClaims: Record<string, string[]> = {};
  for (const source of sources) {
    if (source.kind === 'claim') {
      if (identifierClaims.has(source.claim!)) scopeClaims[source.claim!] = [source.claim!];
      continue;
    }
    if (source.kind === 'metadata' || source.type === undefined) continue;
    const record = project.type(source.type);
    if (record === undefined) continue;
    for (const component of record.kind === 'record' ? record.recordComponents : record.fields) {
      if (component.type.name === 'java.util.UUID') scopeClaims[component.name] = [component.name];
    }
  }
  if (Object.keys(scopeClaims).length === 0) notes.push('No session identifier found: fill scopeClaims with the entity properties that restrict a row to a session.');

  const authentication = [...project.types.values()].find((type) =>
    type.kind === 'class' && type.superclass !== undefined && /AbstractAuthenticationToken$/.test(type.superclass.name));
  // WebFilter on WebFlux, Filter or OncePerRequestFilter on the servlet stack.
  const idempotencyFilter = files.find((file) =>
    /implements\s+(Web)?Filter\b|extends\s+OncePerRequestFilter\b/.test(file.content) && /Idempotency-Key/.test(file.content));
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
