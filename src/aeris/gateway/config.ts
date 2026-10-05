import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';

export type AuthConfig =
  | {
    mode: 'jwt';
    /** JWKS endpoint (e.g. the backend's /.well-known/jwks.json) or a PEM public key file. */
    jwksUrl?: string;
    publicKeyFile?: string;
    issuer?: string | string[];
    audience?: string | string[];
    /** Session claim -> JWT claim name. */
    claims: Record<string, string>;
  }
  | {
    mode: 'introspection';
    /** Backend URL answering the caller's identity as JSON when given the caller's headers. */
    url: string;
    /** Session claim -> dotted path in the JSON answer. */
    claims: Record<string, string>;
    /** Request headers forwarded to the introspection call. */
    forwardHeaders: string[];
  }
  | {
    mode: 'trusted-headers';
    /** Session claim -> request header. Only behind a proxy that sets these headers itself. */
    claims: Record<string, string>;
    acknowledgeInsecure: true;
  };

export interface GatewayConfig {
  listen: { host: string; port: number };
  /** Signed artifact served to clients (aeris-artifact.signed.json). */
  artifactFile: string;
  /** Public keys trusted for the artifact (keyId -> SPKI PEM or base64 raw). */
  trustedKeys: Record<string, string>;
  backend: { url: string; timeoutMs: number; forwardHeaders: string[] };
  database: { url: string; schema: string; poolSize: number };
  auth: AuthConfig;
  /** Claims identifying the operation owner in the idempotency registry. */
  subjectClaims: string[];
  policy: { disabled: string[]; freshness: Record<string, number>; minArtifactVersion: number };
  cors: { origins: string[] };
  limits: { maxBatch: number; maxBodyBytes: number; deltaPageSize: number };
  /** Change-log retention: older cursors must re-snapshot. */
  retentionDays: number;
}

export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
  const raw = yaml.load(await readFile(path, 'utf8')) as Partial<GatewayConfig> & Record<string, unknown>;
  const base = dirname(path);
  const env = (value: unknown): unknown => (typeof value === 'string' ? value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => process.env[name] ?? '') : value);
  const resolved = JSON.parse(JSON.stringify(raw), (_key, value) => env(value)) as Partial<GatewayConfig>;
  if (resolved.artifactFile === undefined) throw new Error('gateway: artifactFile is required.');
  if (resolved.backend?.url === undefined) throw new Error('gateway: backend.url is required.');
  if (resolved.database?.url === undefined) throw new Error('gateway: database.url is required.');
  if (resolved.auth === undefined) throw new Error('gateway: auth is required.');
  if (resolved.auth.mode === 'trusted-headers' && resolved.auth.acknowledgeInsecure !== true) {
    throw new Error('gateway: trusted-headers authentication requires acknowledgeInsecure: true.');
  }
  if (resolved.trustedKeys === undefined || Object.keys(resolved.trustedKeys).length === 0) throw new Error('gateway: trustedKeys is required.');
  return {
    listen: { host: resolved.listen?.host ?? '127.0.0.1', port: resolved.listen?.port ?? 8090 },
    artifactFile: resolve(base, resolved.artifactFile),
    trustedKeys: resolved.trustedKeys,
    backend: {
      url: resolved.backend.url.replace(/\/$/, ''),
      timeoutMs: resolved.backend.timeoutMs ?? 30_000,
      forwardHeaders: (resolved.backend.forwardHeaders ?? ['authorization', 'x-api-key', 'x-client-id', 'x-agency-id', 'accept-language']).map((name) => name.toLowerCase()),
    },
    database: { url: resolved.database.url, schema: resolved.database.schema ?? 'aeris', poolSize: resolved.database.poolSize ?? 10 },
    auth: resolved.auth.mode === 'jwt' && resolved.auth.publicKeyFile !== undefined
      ? { ...resolved.auth, publicKeyFile: resolve(base, resolved.auth.publicKeyFile) }
      : resolved.auth,
    subjectClaims: resolved.subjectClaims ?? ['tenantId', 'userId'],
    policy: {
      disabled: resolved.policy?.disabled ?? [],
      freshness: resolved.policy?.freshness ?? {},
      minArtifactVersion: resolved.policy?.minArtifactVersion ?? 0,
    },
    cors: { origins: resolved.cors?.origins ?? [] },
    limits: {
      maxBatch: resolved.limits?.maxBatch ?? 50,
      maxBodyBytes: resolved.limits?.maxBodyBytes ?? 2 * 1024 * 1024,
      deltaPageSize: resolved.limits?.deltaPageSize ?? 1000,
    },
    retentionDays: resolved.retentionDays ?? 30,
  };
}
