import type {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from './HttpClient.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchClientOptions {
  /** Prefix for relative paths; without it only absolute URLs work. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Overridable for tests; defaults to the environment's fetch. */
  fetch?: typeof globalThis.fetch;
}

/** A transport failure: the request never arrived, or the response never came. */
export class NetworkError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export class FetchClient implements HttpClient {
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: FetchClientOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async send(req: HttpClientRequest): Promise<HttpClientResponse> {
    const url = this.baseUrl === undefined ? req.url : new URL(req.url, this.baseUrl).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let raw: globalThis.Response;
    try {
      raw = await this.doFetch(url, {
        method: req.method,
        headers: buildHeaders(req),
        ...(req.body !== undefined ? { body: serialiseBody(req.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new NetworkError(
          `No response after ${this.timeoutMs} ms: ${req.method} ${url}`,
          { cause: err },
        );
      }
      throw new NetworkError(`Request failed: ${req.method} ${url}`, {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    return {
      status: raw.status,
      headers: Object.fromEntries(raw.headers.entries()),
      body: await readBody(raw),
    };
  }
}

function buildHeaders(req: HttpClientRequest): Record<string, string> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  const declared = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'content-type',
  );
  if (!declared && needsJsonHeader(req.body)) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function needsJsonHeader(body: unknown): boolean {
  return body !== undefined && body !== null && typeof body !== 'string';
}

function serialiseBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** A malformed or empty body never fails the call; the raw text is returned instead. */
async function readBody(raw: globalThis.Response): Promise<unknown> {
  const text = await raw.text();
  if (text.length === 0) return null;

  const type = raw.headers.get('content-type') ?? '';
  if (!type.includes('json')) return text;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
