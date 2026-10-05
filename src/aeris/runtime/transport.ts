import type { PolicyManifest } from '../ir/types.js';
import type {
  DeltaResponse,
  ReconcileRequest,
  ReconcileResponse,
  SnapshotEnvelope,
} from '../protocol.js';

export interface RuntimeRequest {
  method: string;
  /** Absolute URL or origin-relative path with query string. */
  url: string;
  headers: Record<string, string>;
  body?: string | null;
}

export interface RuntimeResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export type TransportErrorKind = 'network' | 'auth' | 'server' | 'protocol';

export class TransportError extends Error {
  constructor(readonly kind: TransportErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Everything the runtime needs from the outside world. */
export interface AerisTransport {
  /** Latest signed artifact envelope, or undefined when unchanged/unavailable. */
  artifact(): Promise<unknown>;
  policy(): Promise<PolicyManifest>;
  snapshot(projectionVersion: string): Promise<SnapshotEnvelope>;
  delta(projectionVersion: string, since: string): Promise<DeltaResponse>;
  reconcile(request: ReconcileRequest): Promise<ReconcileResponse>;
  /** The application's own API, used on the online path. */
  network(request: RuntimeRequest): Promise<RuntimeResponse>;
}

export interface HttpTransportOptions {
  /** Base URL of the Sync Gateway, e.g. https://api.example.com/aeris */
  gatewayUrl: string;
  /** Authorization headers for the current session (the gateway re-authenticates every call). */
  authHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  /** Defaults to globalThis.fetch. Inside a Service Worker, pass the original fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Fetch-based transport for browsers, workers and Node 20+. */
export class HttpTransport implements AerisTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpTransportOptions) {
    const impl = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (impl === undefined) throw new Error('No fetch implementation available.');
    this.fetchImpl = impl.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async artifact(): Promise<unknown> {
    return this.json('GET', '/artifact');
  }

  async policy(): Promise<PolicyManifest> {
    return this.json('GET', '/policy') as Promise<PolicyManifest>;
  }

  async snapshot(projectionVersion: string): Promise<SnapshotEnvelope> {
    return this.json('GET', `/snapshot?projection=${encodeURIComponent(projectionVersion)}`) as Promise<SnapshotEnvelope>;
  }

  async delta(projectionVersion: string, since: string): Promise<DeltaResponse> {
    return this.json('GET', `/delta?projection=${encodeURIComponent(projectionVersion)}&since=${encodeURIComponent(since)}`) as Promise<DeltaResponse>;
  }

  async reconcile(request: ReconcileRequest): Promise<ReconcileResponse> {
    return this.json('POST', '/reconcile', request) as Promise<ReconcileResponse>;
  }

  async network(request: RuntimeRequest): Promise<RuntimeResponse> {
    const response = await this.send(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const body = request.method === 'HEAD' || response.status === 204 ? null : await response.text();
    return { status: response.status, headers, body };
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(await this.options.authHeaders()),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.send(`${this.options.gatewayUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      throw new TransportError('auth', `Gateway refused the session (${response.status}).`, response.status);
    }
    if (response.status === 304) return undefined;
    if (!response.ok) throw new TransportError('server', `Gateway answered ${response.status}.`, response.status);
    try {
      return await response.json();
    } catch {
      throw new TransportError('protocol', 'Gateway answered with invalid JSON.');
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal, credentials: 'include' });
    } catch (error) {
      throw new TransportError('network', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
