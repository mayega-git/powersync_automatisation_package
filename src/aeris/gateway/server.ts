import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import pg from 'pg';
import { canonicalJson } from '../ir/canonical.js';
import { importPublicKey, verifyArtifact } from '../ir/signing.js';
import type { AerisArtifact, JsonValue, PolicyManifest } from '../ir/types.js';
import type { ReconcileRequest } from '../protocol.js';
import { AuthenticationError, sessionResolver, type SessionClaims, type SessionResolver } from './auth.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import { ProjectionReader, rawTypes } from './data.js';
import { BatchAuthError, Reconciler, type BackendClient } from './reconcile.js';
import { setupSql } from './sql.js';
import { checkProjections } from '../compiler/schema-check.js';

export interface GatewayDependencies {
  pool?: pg.Pool;
  resolveSession?: SessionResolver;
  backend?: BackendClient;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface Gateway {
  server: Server;
  artifact: AerisArtifact;
  close(): Promise<void>;
  /** Idempotent schema setup (change log, triggers, registry). */
  setup(): Promise<void>;
  url(): string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function fetchBackend(fetchImpl: typeof fetch, timeoutMs: number): BackendClient {
  return async (call) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(call.url, { method: call.method, headers: call.headers, body: call.body ?? undefined, signal: controller.signal });
      const text = await response.text();
      let body: JsonValue | null = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as JsonValue;
        } catch {
          body = text;
        }
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON.');
  }
}

/** Creates (but does not start) a Sync Gateway. */
export async function createGateway(config: GatewayConfig, dependencies: GatewayDependencies = {}): Promise<Gateway> {
  const log = dependencies.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const envelope = JSON.parse(await readFile(config.artifactFile, 'utf8')) as unknown;
  const keys = new Map<string, CryptoKey>();
  for (const [keyId, key] of Object.entries(config.trustedKeys)) keys.set(keyId, await importPublicKey(key));
  const artifact = await verifyArtifact(envelope, keys);
  const etag = `"${createHash('sha256').update(canonicalJson(envelope)).digest('hex').slice(0, 32)}"`;
  const pool = dependencies.pool ?? new pg.Pool({ connectionString: config.database.url, max: config.database.poolSize, types: rawTypes });
  const reader = new ProjectionReader(pool, artifact, config.database.schema);
  const fetchImpl = dependencies.fetch ?? fetch;
  const reconciler = new Reconciler(pool, artifact, reader, dependencies.backend ?? fetchBackend(fetchImpl, config.backend.timeoutMs), {
    backendUrl: config.backend.url,
    idempotencyHeader: artifact.endpoints.find((plan) => plan.sync !== undefined)?.sync?.idempotencyHeader ?? 'Idempotency-Key',
    schema: config.database.schema,
    maxBatch: config.limits.maxBatch,
  });
  const resolveSession = dependencies.resolveSession ?? await sessionResolver(config.auth, fetchImpl);
  const manifest = (): PolicyManifest => ({ ...config.policy, issuedAt: new Date().toISOString() });

  const subjectOf = (claims: SessionClaims): string =>
    createHash('sha256').update(canonicalJson(config.subjectClaims.map((claim) => claims[claim] ?? null))).digest('hex');

  const cors = (request: IncomingMessage, response: ServerResponse) => {
    const origin = request.headers.origin;
    if (origin !== undefined && config.cors.origins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, if-none-match, x-api-key, x-client-id, x-agency-id');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Vary', 'Origin');
    }
  };

  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    response.end(text);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    cors(request, response);
    const url = new URL(request.url ?? '/', 'http://gateway.invalid');
    const route = `${request.method} ${url.pathname.replace(/\/$/, '')}`;
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (route === 'GET /aeris/health') {
      await pool.query('SELECT 1');
      send(response, 200, { status: 'ok', artifactVersion: artifact.artifactVersion });
      return;
    }
    if (route === 'GET /aeris/artifact') {
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return;
      }
      send(response, 200, envelope, { etag, 'cache-control': 'no-cache' });
      return;
    }
    // Everything below needs an authenticated session.
    const claims = await resolveSession(request.headers);
    if (route === 'GET /aeris/policy') {
      send(response, 200, manifest());
      return;
    }
    if (route === 'GET /aeris/snapshot') {
      if (url.searchParams.get('projection') !== artifact.projectionVersion) throw new HttpError(409, 'Projection version mismatch: refresh the artifact.');
      send(response, 200, await reader.snapshot(claims));
      return;
    }
    if (route === 'GET /aeris/delta') {
      if (url.searchParams.get('projection') !== artifact.projectionVersion) {
        send(response, 200, { projectionVersion: artifact.projectionVersion, cursor: '0', changes: [], hasMore: false, resnapshot: true });
        return;
      }
      send(response, 200, await reader.delta(claims, url.searchParams.get('since') ?? '0', config.limits.deltaPageSize));
      return;
    }
    if (route === 'POST /aeris/reconcile') {
      const body = await readBody(request, config.limits.maxBodyBytes) as ReconcileRequest | undefined;
      if (body === undefined || typeof body !== 'object') throw new HttpError(400, 'Missing body.');
      const forwarded: Record<string, string> = {};
      for (const name of config.backend.forwardHeaders) {
        const value = request.headers[name];
        if (typeof value === 'string') forwarded[name] = value;
      }
      if (typeof request.headers.traceparent === 'string') forwarded.traceparent = request.headers.traceparent;
      send(response, 200, await reconciler.reconcile(subjectOf(claims), forwarded, body));
      return;
    }
    throw new HttpError(404, 'Not found.');
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof AuthenticationError || error instanceof BatchAuthError) {
        send(response, 401, { error: 'UNAUTHENTICATED', message: error.message }, { 'www-authenticate': 'Bearer' });
      } else if (error instanceof HttpError) {
        send(response, error.status, { error: 'REQUEST', message: error.message });
      } else {
        log(`aeris-gateway: ${(error as Error).stack ?? String(error)}`);
        send(response, 500, { error: 'INTERNAL', message: 'Gateway error.' });
      }
    });
  });

  const pruneTimer = setInterval(() => {
    reader.prune(config.retentionDays).catch((error: unknown) => log(`aeris-gateway: prune failed: ${(error as Error).message}`));
  }, 3_600_000);
  pruneTimer.unref();

  return {
    server,
    artifact,
    url: () => {
      const address = server.address();
      return typeof address === 'object' && address !== null ? `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}` : '';
    },
    setup: async () => {
      await pool.query(setupSql(artifact, config.database.schema));
    },
    close: async () => {
      clearInterval(pruneTimer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dependencies.pool === undefined) await pool.end();
    },
  };
}

/** `aeris gateway --config gateway.yaml`: verifies the artifact, prepares the schema, serves. */
export async function startGatewayFromConfig(path: string): Promise<Gateway> {
  const config = await loadGatewayConfig(path);
  const gateway = await createGateway(config);
  const problems = await checkProjections(config.database.url, gateway.artifact.projections);
  if (problems.size > 0) {
    await gateway.close();
    throw new Error(`The artifact does not match the database schema; rebuild it with \`aeris analyze --database\`:\n${[...problems.values()].join('\n')}`);
  }
  await gateway.setup();
  await new Promise<void>((resolve) => gateway.server.listen(config.listen.port, config.listen.host, resolve));
  process.stdout.write(`AERIS Sync Gateway listening on ${gateway.url()} (artifact v${gateway.artifact.artifactVersion}, ${gateway.artifact.projections.length} projections)\n`);
  const stop = () => {
    gateway.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return gateway;
}
