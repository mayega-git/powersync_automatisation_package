import type { HttpRequest } from '../core/HttpRequest.js';

export const BRIDGE_CHANNEL = 'offline-sync:bridge';

/** What the Service Worker sends to the page. */
export interface BridgeRequest {
  channel: typeof BRIDGE_CHANNEL;
  request: HttpRequest;
}

/** What the page sends back. `handled: false` means "not for me". */
export interface BridgeResponse {
  handled: boolean;
  entity?: unknown;
  status?: string;
  error?: string;
}

export const BRIDGE_TIMEOUT_MS = 2000;

interface MessagePortLike {
  postMessage(message: unknown): void;
  /** Kept wide (`any`) to stay assignable from a real `MessagePort` without importing DOM types. */
  onmessage: ((event: any) => void) | null;
  start?: () => void;
  close?: () => void;
}

interface MessageChannelLike {
  port1: MessagePortLike;
  port2: MessagePortLike;
}

interface WorkerClient {
  postMessage(message: unknown, transfer?: unknown[]): void;
}

interface WorkerClients {
  get(id: string): Promise<WorkerClient | undefined>;
  matchAll(options?: {
    type?: string;
    includeUncontrolled?: boolean;
  }): Promise<readonly WorkerClient[]>;
}

export interface WorkerSideOptions {
  clients: WorkerClients;
  /** `() => new MessageChannel()`, overridable in tests. */
  openChannel: () => MessageChannelLike;
  buildResponse: (body: string, init: { status: number; headers: Record<string, string> }) => unknown;
  goToNetwork: (request: unknown) => Promise<unknown>;
  timeoutMs?: number;
  logger?: { debug: (msg: string, ctx?: unknown) => void };
}

export interface CapturedRequest {
  /** The browser's `Request` object, passed through as-is if going to the network. */
  raw: unknown;
  /** The tab that made the request; empty on a navigation. */
  clientId: string;
  request: HttpRequest;
}

/**
 * Worker side: catch, ask the page, fall back to the network. Returns a
 * function to use as a cache-rule handler; it always resolves, never throws,
 * never waits forever.
 */
export function serveFromPage(options: WorkerSideOptions) {
  const timeout = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;

  return async function respond(captured: CapturedRequest): Promise<unknown> {
    const client = await findTab(options.clients, captured.clientId);

    if (client === undefined) {
      options.logger?.debug('bridge: no reachable tab, the request goes to the network');
      return options.goToNetwork(captured.raw);
    }

    const response = await ask(client, captured.request, options.openChannel, timeout);

    if (response === undefined || !response.handled) {
      return options.goToNetwork(captured.raw);
    }

    options.logger?.debug('bridge: the page answered from the local database', {
      url: captured.request.url,
    });

    const body = {
      ok: response.status === 'Success' || response.status === undefined,
      source: 'local',
      payload: response.entity ?? null,
    };

    return options.buildResponse(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Offline-Sync': 'local-database',
      },
    });
  };
}

/** The tab that made the request, otherwise any open one: the local database is the same for all. */
async function findTab(
  clients: WorkerClients,
  clientId: string,
): Promise<WorkerClient | undefined> {
  if (clientId.length > 0) {
    const exact = await clients.get(clientId);
    if (exact !== undefined) return exact;
  }
  const open = await clients.matchAll({ type: 'window' });
  return open[0];
}

function ask(
  client: WorkerClient,
  request: HttpRequest,
  openChannel: () => MessageChannelLike,
  timeout: number,
): Promise<BridgeResponse | undefined> {
  return new Promise((resolve) => {
    const channel = openChannel();
    let done = false;

    const finish = (value: BridgeResponse | undefined): void => {
      if (done) return;
      done = true;
      channel.port1.close?.();
      resolve(value);
    };

    channel.port1.onmessage = (event) => finish(event.data as BridgeResponse);
    channel.port1.start?.();

    setTimeout(() => finish(undefined), timeout);

    const message: BridgeRequest = { channel: BRIDGE_CHANNEL, request };
    client.postMessage(message, [channel.port2]);
  });
}

export interface PageSideOptions {
  /** `sync.handles(request)`. */
  handles: (req: HttpRequest) => boolean;
  /** `sync.interceptRequest(request)`. */
  respond: (req: HttpRequest) => Promise<{ status: string; entity: unknown }>;
  /** In practice: `navigator.serviceWorker`. */
  source: {
    addEventListener: (type: string, listener: (event: unknown) => void) => void;
    removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  };
  logger?: { error: (msg: string, ctx?: unknown) => void };
}

interface ReceivedMessage {
  data?: unknown;
  ports?: readonly MessagePortLike[];
}

/**
 * Page side: listen for the bridge and answer from the local database.
 * Returns a function that unsubscribes. Call once at startup.
 */
export function bridgeServiceWorker(options: PageSideOptions): () => void {
  const listener = (raw: unknown): void => {
    const event = raw as ReceivedMessage;
    const message = event.data as BridgeRequest | undefined;
    if (message?.channel !== BRIDGE_CHANNEL) return;

    const port = event.ports?.[0];
    if (port === undefined) return;

    void (async () => {
      try {
        if (!options.handles(message.request)) {
          port.postMessage({ handled: false } satisfies BridgeResponse);
          return;
        }
        const response = await options.respond(message.request);
        port.postMessage({
          handled: true,
          status: response.status,
          entity: response.entity,
        } satisfies BridgeResponse);
      } catch (cause) {
        options.logger?.error('bridge: the page could not answer', cause);
        port.postMessage({
          handled: false,
          error: cause instanceof Error ? cause.message : String(cause),
        } satisfies BridgeResponse);
      }
    })();
  };

  options.source.addEventListener('message', listener);
  return () => options.source.removeEventListener?.('message', listener);
}

/**
 * Convenience helper to connect an OfflineSync instance to the Service Worker bridge.
 */
export function connectBridge(syncInstance: any): () => void {
  const nav = typeof globalThis !== 'undefined' ? (globalThis as any).navigator : undefined;
  if (!nav || !nav.serviceWorker) {
    return () => {};
  }
  return bridgeServiceWorker({
    handles: (req) => syncInstance.handles(req),
    respond: (req) => syncInstance.interceptRequest(req),
    source: nav.serviceWorker,
    logger: syncInstance.logger,
  });
}
