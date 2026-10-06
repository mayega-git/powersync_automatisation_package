import { readFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import type { OfflineClass } from '../ir/types.js';

export interface ContextSource {
  /** `SimpleClassName.method` or fully-qualified `pkg.Class.method`. */
  method: string;
  /**
   * required: Mono<T> of the session record T (claims = its components);
   * optional: Mono<Optional<T>>;
   * claim: Mono<X> of one claim, empty when absent;
   * metadata: Mono<Optional<T>> of request metadata (correlation id, remote
   * address, request path) that a device genuinely does not have. The value
   * is present but opaque: reading any part of it is refused, so it can only
   * be handed to a method declared in `inertEffects`. The compiler therefore
   * never has to invent a value, and no endpoint whose answer depends on
   * request metadata can be served locally.
   */
  kind: 'required' | 'optional' | 'claim' | 'metadata';
  /** For required/optional: the record or class carrying the claims. */
  type?: string;
  /** For claim: the claim name. */
  claim?: string;
}

export interface CompilerConfig {
  /** Spring profiles considered active when choosing beans (@Profile). */
  activeProfiles: string[];
  /** Zone of the server JVM, used for LocalDateTime.now(). */
  serverTimeZone: string;
  context: {
    sources: ContextSource[];
    /** Class of the Authentication principal; its fields are session claims (same names). */
    authentication?: string;
    /** Session claim holding the granted authorities (Authentication#getAuthorities). */
    authoritiesClaim?: string;
  };
  /** Type name prefixes whose use is an external, irreversible effect (forces ONLINE_REQUIRED). */
  externalEffects: string[];
  /**
   * Methods whose only effect is server-side bookkeeping the device must not
   * reproduce: audit trails, access logs, metrics. Written as `Class.method`
   * or `pkg.Class.method` (globs allowed).
   *
   * A declared method is modeled as a no-op instead of being analyzed, which
   * is only sound because the compiler refuses the declaration unless the
   * method returns nothing (`void` or `Mono<Void>`): having no value, it
   * provably cannot reach the response, an authorization decision or a
   * stored row. Its own writes are server-side and happen when the operation
   * is replayed through the backend's API at reconciliation.
   *
   * Every skipped call is recorded as `inert` evidence in the artifact, so a
   * reviewer can see exactly what each endpoint was allowed to ignore.
   */
  inertEffects: string[];
  /**
   * Backend-side idempotency: replays carrying this header are applied once
   * (e.g. an Idempotency-Key web filter). Without it, creations cannot be
   * replayed safely and stay online-only.
   */
  idempotency?: { header: string; methods: string[]; paths: string[] };
  /** Endpoint ids (glob, e.g. "POST /api/payments/**") that must never run offline. */
  onlineOnly: string[];
  /** Entities shared by every session (reference data); everything else must be scoped. */
  publicEntities: string[];
  /** Claim -> entity property names that carry it, used to infer projection scopes. */
  scopeClaims: Record<string, string[]>;
  freshness: Record<OfflineClass, number>;
  /** Jackson default property inclusion of the backend. */
  jsonInclusion: 'always' | 'non_null';
  /**
   * Global request filters the compiler cannot analyze (entitlements, tenant
   * gates): each adds an authorization policy to the endpoints it covers,
   * evaluated offline on cached claims, e.g.
   * { paths: ['/api/treasury/**'], policy: "claim('services').contains('TREASURY')" }.
   */
  requestGates: { paths: string[]; policy: string }[];
  /** Annotation-free overrides: endpoint id -> class (may only lower the computed class). */
  overrides: Record<string, OfflineClass>;
  maxInlineDepth: number;
  artifactVersion?: number;
}

export const DEFAULT_CONFIG: CompilerConfig = {
  activeProfiles: [],
  serverTimeZone: 'UTC',
  context: { sources: [] },
  inertEffects: [],
  externalEffects: [
    'org.springframework.web.reactive.function.client.WebClient',
    'org.springframework.web.client.RestTemplate',
    'org.springframework.web.client.RestClient',
    'org.springframework.kafka.core.KafkaTemplate',
    'org.springframework.kafka.core.reactive.ReactiveKafkaProducerTemplate',
    'org.springframework.cloud.stream.function.StreamBridge',
    'org.springframework.amqp.rabbit.core.RabbitTemplate',
    'org.springframework.mail.',
    'org.springframework.context.ApplicationEventPublisher',
    'org.springframework.messaging.',
    'java.net.http.HttpClient',
    'software.amazon.awssdk.',
    'com.google.cloud.',
    'io.minio.',
    'reactor.kafka.',
  ],
  onlineOnly: [],
  publicEntities: [],
  scopeClaims: {
    tenantId: ['tenantId'],
    organizationId: ['organizationId'],
  },
  freshness: {
    LOCAL_READ_SAFE: 24 * 3600,
    LOCAL_WRITE_SAFE: 24 * 3600,
    REPLAYABLE: 24 * 3600,
    SPECULATIVE: 15 * 60,
    ONLINE_REQUIRED: 0,
    UNSUPPORTED: 0,
  },
  jsonInclusion: 'always',
  requestGates: [],
  overrides: {},
  maxInlineDepth: 32,
};

/** Reads `aeris.config.yaml` (or .json); missing keys keep their defaults. */
export async function loadConfig(path: string | undefined): Promise<CompilerConfig> {
  if (path === undefined) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    const text = await readFile(path, 'utf8');
    raw = path.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
  return mergeConfig(raw);
}

export function mergeConfig(raw: unknown): CompilerConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  if (raw === null || raw === undefined) return config;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('AERIS configuration must be a mapping.');
  const input = raw as Partial<CompilerConfig> & { externalEffectsExtra?: string[] };
  if (input.activeProfiles !== undefined) config.activeProfiles = stringList(input.activeProfiles, 'activeProfiles');
  if (input.serverTimeZone !== undefined) {
    if (typeof input.serverTimeZone !== 'string') throw new Error('serverTimeZone must be a string.');
    new Intl.DateTimeFormat('en', { timeZone: input.serverTimeZone });
    config.serverTimeZone = input.serverTimeZone;
  }
  if (input.context?.sources !== undefined) {
    config.context.sources = input.context.sources.map((source, index) => {
      if (typeof source?.method !== 'string' || !['required', 'optional', 'claim', 'metadata'].includes(source.kind)) {
        throw new Error(`context.sources[${index}] needs a method and a kind (required, optional, claim or metadata).`);
      }
      if (source.kind === 'claim' && typeof source.claim !== 'string') throw new Error(`context.sources[${index}] needs a claim.`);
      if (source.kind !== 'claim' && typeof source.type !== 'string') throw new Error(`context.sources[${index}] needs a type.`);
      return source;
    });
  }
  if (input.context?.authoritiesClaim !== undefined) config.context.authoritiesClaim = String(input.context.authoritiesClaim);
  if (input.context?.authentication !== undefined) {
    if (typeof input.context.authentication !== 'string') throw new Error('context.authentication must be a class name.');
    config.context.authentication = input.context.authentication;
  }
  if (input.externalEffects !== undefined) config.externalEffects = stringList(input.externalEffects, 'externalEffects');
  if (input.externalEffectsExtra !== undefined) config.externalEffects.push(...stringList(input.externalEffectsExtra, 'externalEffectsExtra'));
  if (input.inertEffects !== undefined) config.inertEffects = stringList(input.inertEffects, 'inertEffects');
  if (input.idempotency !== undefined) {
    const idem = input.idempotency;
    if (typeof idem.header !== 'string') throw new Error('idempotency.header must be a string.');
    config.idempotency = {
      header: idem.header,
      methods: stringList(idem.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE'], 'idempotency.methods').map((method) => method.toUpperCase()),
      paths: stringList(idem.paths ?? ['/**'], 'idempotency.paths'),
    };
  }
  if (input.onlineOnly !== undefined) config.onlineOnly = stringList(input.onlineOnly, 'onlineOnly');
  if (input.publicEntities !== undefined) config.publicEntities = stringList(input.publicEntities, 'publicEntities');
  if (input.scopeClaims !== undefined) {
    config.scopeClaims = {};
    for (const [claim, properties] of Object.entries(input.scopeClaims)) config.scopeClaims[claim] = stringList(properties, `scopeClaims.${claim}`);
  }
  if (input.freshness !== undefined) {
    for (const [name, seconds] of Object.entries(input.freshness)) {
      if (!(name in config.freshness) || typeof seconds !== 'number' || seconds < 0) throw new Error(`Invalid freshness for ${name}.`);
      config.freshness[name as OfflineClass] = seconds;
    }
  }
  if (input.jsonInclusion !== undefined) {
    if (input.jsonInclusion !== 'always' && input.jsonInclusion !== 'non_null') throw new Error('jsonInclusion must be always or non_null.');
    config.jsonInclusion = input.jsonInclusion;
  }
  if (input.overrides !== undefined) config.overrides = { ...input.overrides };
  if (input.requestGates !== undefined) {
    config.requestGates = input.requestGates.map((gate, index) => {
      if (typeof gate?.policy !== 'string') throw new Error(`requestGates[${index}].policy must be a string.`);
      return { paths: stringList(gate.paths, `requestGates[${index}].paths`), policy: gate.policy };
    });
  }
  if (input.maxInlineDepth !== undefined) config.maxInlineDepth = Number(input.maxInlineDepth);
  if (input.artifactVersion !== undefined) {
    if (!Number.isSafeInteger(input.artifactVersion) || input.artifactVersion < 1) throw new Error('artifactVersion must be a positive integer.');
    config.artifactVersion = input.artifactVersion;
  }
  return config;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${name} must be a list of strings.`);
  return [...value];
}

/** Glob over endpoint ids or paths: `*` = one segment, `**` = any. */
export function globMatch(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${pattern.split('**').map((part) => part.split('*').map(escapeRegex).join('[^/]*')).join('.*')}$`);
  return regex.test(value);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
