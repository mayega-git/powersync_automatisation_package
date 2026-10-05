/// <reference lib="webworker" />
/**
 * AERIS Service Worker side. In the worker:
 *
 *   import { installAerisServiceWorker } from '@ksm/offline-sync/aeris/sw';
 *   installAerisServiceWorker({ apiOrigin: 'https://api.example.com' });
 *
 * Intercepted API requests are answered by the runtime running in a page
 * (see connectAerisServiceWorker). The worker performs the network calls the
 * runtime decides on, so they are not intercepted twice.
 */
import { AERIS_CHANNEL, type PageToWorker } from './runtime/browser.js';
import type { RuntimeRequest, RuntimeResponse } from './runtime/transport.js';

export interface AerisWorkerOptions {
  apiOrigin: string;
  /** Extra filter on intercepted URLs. */
  match?: (url: URL) => boolean;
  /** How long to wait for a page to answer (ms). */
  timeoutMs?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare const self: ServiceWorkerGlobalScope;

export function installAerisServiceWorker(options: AerisWorkerOptions): void {
  const origin = new URL(options.apiOrigin).origin;
  self.addEventListener('fetch', (event: FetchEvent) => {
    const url = new URL(event.request.url);
    if (url.origin !== origin || (options.match !== undefined && !options.match(url))) return;
    event.respondWith(answer(event, options.timeoutMs ?? 10_000));
  });
}

async function serialize(request: Request): Promise<RuntimeRequest> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { method: request.method, url: request.url, headers, body: SAFE_METHODS.has(request.method) ? null : await request.clone().text() };
}

async function networkCall(request: RuntimeRequest): Promise<RuntimeResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body ?? undefined,
    credentials: 'include',
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return { status: response.status, headers, body: request.method === 'HEAD' || response.status === 204 ? null : await response.text() };
}

async function answer(event: FetchEvent, timeoutMs: number): Promise<Response> {
  const client = (event.clientId ? await self.clients.get(event.clientId) : undefined)
    ?? (await self.clients.matchAll({ type: 'window' }))[0];
  // No page can run the runtime: behave like a plain fetch.
  if (client === undefined) return fetch(event.request);
  const request = await serialize(event.request);
  const channel = new MessageChannel();
  return new Promise<Response>((resolve) => {
    let settled = false;
    const finish = (response: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(response);
    };
    const timer = setTimeout(() => {
      // A mutation may have been applied locally: its outcome is unknown, never resend it blindly.
      finish(SAFE_METHODS.has(request.method)
        ? Response.error()
        : new Response(JSON.stringify({ status: 504, code: 'AERIS_OUTCOME_UNKNOWN', message: 'The local runtime did not answer.' }), { status: 504, headers: { 'content-type': 'application/json' } }));
    }, timeoutMs);
    channel.port1.onmessage = (message: MessageEvent<PageToWorker>) => {
      const data = message.data;
      if (data.kind === 'network-request') {
        networkCall(data.request)
          .then((response) => channel.port1.postMessage({ channel: AERIS_CHANNEL, kind: 'network-response', response }))
          .catch((error: unknown) => channel.port1.postMessage({ channel: AERIS_CHANNEL, kind: 'network-response', error: String(error) }));
        return;
      }
      if (data.kind === 'response') {
        finish(new Response(data.response.body, { status: data.response.status, headers: data.response.headers }));
        return;
      }
      finish(data.message === 'network' ? Response.error() : new Response(JSON.stringify({ status: 500, message: data.message }), { status: 500, headers: { 'content-type': 'application/json' } }));
    };
    client.postMessage({ channel: AERIS_CHANNEL, kind: 'request', request }, [channel.port2]);
  });
}
