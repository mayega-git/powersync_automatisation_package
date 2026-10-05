import { TransportError, type RuntimeRequest, type RuntimeResponse } from './transport.js';
import type { AerisRuntime } from './runtime.js';

export const AERIS_CHANNEL = 'aeris:request';

/** Messages between the Service Worker and the page that hosts the runtime. */
export type WorkerToPage =
  | { channel: typeof AERIS_CHANNEL; kind: 'request'; request: RuntimeRequest }
  | { channel: typeof AERIS_CHANNEL; kind: 'network-response'; response?: RuntimeResponse; error?: string };

export type PageToWorker =
  | { kind: 'response'; response: RuntimeResponse }
  | { kind: 'network-request'; request: RuntimeRequest }
  | { kind: 'error'; message: string };

export interface InstallFetchOptions {
  /** Only requests for which this returns true go through AERIS (default: the runtime's apiOrigin). */
  match?: (url: URL) => boolean;
  /** The window or worker global whose fetch is patched (default globalThis). */
  target?: { fetch: typeof fetch };
}

/**
 * Routes the page's fetch calls through the runtime. The runtime's own
 * network calls must use the original fetch: pass `originalFetch` to the
 * HttpTransport (see `createBrowserRuntime`).
 */
export function installAerisFetch(runtime: AerisRuntime, options: InstallFetchOptions = {}): { restore: () => void; originalFetch: typeof fetch } {
  const target = options.target ?? (globalThis as unknown as { fetch: typeof fetch });
  const originalFetch = target.fetch.bind(target);
  const matches = options.match ?? (() => true);
  target.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (!matches(new URL(request.url))) return originalFetch(input, init);
    try {
      return await runtime.fetch(request);
    } catch (error) {
      // Same failure shape as a real fetch: a TypeError.
      if (error instanceof TransportError) throw new TypeError(error.message);
      throw error;
    }
  };
  return { restore: () => { target.fetch = originalFetch; }, originalFetch };
}

interface MessagePortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?: () => void;
}

interface ServiceWorkerContainerLike {
  addEventListener(type: 'message', listener: (event: { data: unknown; ports: readonly MessagePortLike[] }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown; ports: readonly MessagePortLike[] }) => void): void;
}

/**
 * Page side of the Service Worker mode: answers intercepted requests with
 * the runtime. Network calls are delegated back to the worker so they are not
 * intercepted again.
 */
export function connectAerisServiceWorker(runtime: AerisRuntime, container?: ServiceWorkerContainerLike): () => void {
  const source = container ?? (globalThis as unknown as { navigator?: { serviceWorker?: ServiceWorkerContainerLike } }).navigator?.serviceWorker;
  if (source === undefined) return () => undefined;
  const listener = (event: { data: unknown; ports: readonly MessagePortLike[] }) => {
    const message = event.data as WorkerToPage | undefined;
    if (message?.channel !== AERIS_CHANNEL || message.kind !== 'request') return;
    const port = event.ports[0];
    if (port === undefined) return;
    const pending: ((reply: { response?: RuntimeResponse; error?: string }) => void)[] = [];
    port.onmessage = (reply) => {
      const data = reply.data as WorkerToPage;
      if (data.kind === 'network-response') pending.shift()?.(data);
    };
    port.start?.();
    const network = (request: RuntimeRequest) => new Promise<RuntimeResponse>((resolve, reject) => {
      pending.push((reply) => (reply.response !== undefined ? resolve(reply.response) : reject(new TransportError('network', reply.error ?? 'network error'))));
      port.postMessage({ kind: 'network-request', request } satisfies PageToWorker);
    });
    runtime.handle(message.request, { network })
      .then((response) => port.postMessage({ kind: 'response', response } satisfies PageToWorker))
      .catch((error: unknown) => {
        if (error instanceof TransportError && error.kind === 'network') {
          port.postMessage({ kind: 'error', message: 'network' } satisfies PageToWorker);
        } else {
          port.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) } satisfies PageToWorker);
        }
      });
  };
  source.addEventListener('message', listener);
  return () => source.removeEventListener('message', listener);
}

import type { AccessLocalDatabase } from '../../core/AccessLocalDatabase.js';
import { AerisRuntime as Runtime, type AerisRuntimeOptions } from './runtime.js';
import { HttpTransport } from './transport.js';
import { IndexedDbStore } from './store/IndexedDbStore.js';
import { SqlStore } from './store/SqlStore.js';

export interface BrowserRuntimeOptions extends Omit<AerisRuntimeOptions, 'store' | 'transport'> {
  /** Base URL of the Sync Gateway, e.g. https://api.example.com/aeris */
  gatewayUrl: string;
  /** Origin of the business API to intercept, e.g. https://api.example.com */
  apiOrigin: string;
  /** Headers authenticating the session on the gateway (usually the bearer token). */
  authHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  /** SQLite (PowerSync/wa-sqlite) when available, otherwise IndexedDB. */
  database?: AccessLocalDatabase;
  /** IndexedDB database name; partition it per deployment. */
  storageName?: string;
  /** Patch window.fetch (default true). Use false with the Service Worker mode. */
  patchFetch?: boolean;
}

/**
 * One-call setup for a web application: storage, gateway transport (with the
 * original fetch, so the runtime never intercepts itself), fetch patching and
 * start-up. Call `stop()` on logout after `runtime.purge()`.
 */
export async function createBrowserRuntime(options: BrowserRuntimeOptions): Promise<{ runtime: Runtime; stop: () => void }> {
  const scope = globalThis as unknown as { fetch: typeof fetch; indexedDB?: IDBFactory };
  const originalFetch = scope.fetch.bind(scope);
  const store = options.database !== undefined
    ? new SqlStore(options.database)
    : scope.indexedDB !== undefined
      ? new IndexedDbStore(scope.indexedDB, options.storageName ?? 'aeris')
      : (() => { throw new Error('No local storage available: provide a SQLite database or run in a browser with IndexedDB.'); })();
  const transport = new HttpTransport({ gatewayUrl: options.gatewayUrl, authHeaders: options.authHeaders, fetch: originalFetch });
  const runtime = new Runtime({ ...options, store, transport, apiOrigin: options.apiOrigin });
  const origin = new URL(options.apiOrigin).origin;
  const patch = options.patchFetch === false ? undefined : installAerisFetch(runtime, { match: (url) => url.origin === origin && !url.pathname.startsWith(new URL(options.gatewayUrl).pathname) });
  await runtime.start();
  return {
    runtime,
    stop: () => {
      runtime.stop();
      patch?.restore();
    },
  };
}
