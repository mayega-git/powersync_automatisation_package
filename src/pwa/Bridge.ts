import type { HttpRequest } from '../core/HttpRequest.js';
import { warnIfNeverControlled } from './Register.js';

export const BRIDGE_CHANNEL = 'offline-sync:bridge';

export interface BridgeRequest {
  channel: typeof BRIDGE_CHANNEL;
  request: HttpRequest;
}

export interface BridgeResponse {
  handled: boolean;
  entity?: unknown;
  status?: string;
  error?: string;
}

export const BRIDGE_TIMEOUT_MS = 2000;

interface MessagePortLike {
  postMessage(message: unknown): void;
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
  openChannel: () => MessageChannelLike;
  buildResponse: (body: string, init: { status: number; headers: Record<string, string> }) => unknown;
  goToNetwork: (request: unknown) => Promise<unknown>;
  timeoutMs?: number;
  logger?: { debug: (msg: string, ctx?: unknown) => void };
}

export interface CapturedRequest {
  raw: unknown;
  clientId: string;
  request: HttpRequest;
}

// Convert snake_case keys to camelCase and auto-parse JSON strings
function formatPayload(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map(formatPayload);
  } else if (data !== null && typeof data === 'object') {
    const formatted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const camelKey = key.replace(/_([a-z])/g, (g) => g[1]!.toUpperCase());
      
      // Auto-parse JSON if it looks like JSON
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
          formatted[camelKey] = JSON.parse(value);
        } catch {
          formatted[camelKey] = formatPayload(value);
        }
      } else {
        formatted[camelKey] = formatPayload(value);
      }
    }
    return formatted;
  }
  return data;
}

export function serveFromPage(options: WorkerSideOptions) {
  const timeout = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;

  return async function respond(captured: CapturedRequest): Promise<unknown> {
    const client = await findTab(options.clients, captured.clientId, captured.request);

    if (client === undefined) {
      options.logger?.debug('bridge: no reachable tab, the request goes to the network');
      return options.goToNetwork(captured.raw);
    }

    const response = await ask(client, captured.request, options.openChannel, timeout);

    if (response === undefined) {
      if (!canSafelyRetry(captured.request)) {
        return localFailure(
          options,
          504,
          'The local operation timed out; its outcome is unknown. Do not retry automatically.',
          'outcome-unknown',
        );
      }
      return options.goToNetwork(captured.raw);
    }

    if (!response.handled && response.error === undefined) {
      return options.goToNetwork(captured.raw);
    }
    if (response.error !== undefined) {
      return localFailure(options, 500, response.error, 'local-error');
    }

    options.logger?.debug('bridge: the page answered from the local database', {
      url: captured.request.url,
    });

    const body = {
      ok: response.status === 'Success' || response.status === undefined,
      source: 'local',
      data: response.entity === undefined ? null : formatPayload(response.entity),
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

async function findTab(
  clients: WorkerClients,
  clientId: string,
  request: HttpRequest,
): Promise<WorkerClient | undefined> {
  if (clientId.length > 0) {
    return clients.get(clientId);
  }
  if (!canSafelyRetry(request)) return undefined;
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
      clearTimeout(timer);
      channel.port1.close?.();
      resolve(value);
    };

    channel.port1.onmessage = (event) => finish(event.data as BridgeResponse);
    channel.port1.start?.();

    const timer = setTimeout(() => finish(undefined), timeout);

    const message: BridgeRequest = { channel: BRIDGE_CHANNEL, request };
    try {
      client.postMessage(message, [channel.port2]);
    } catch {
      finish(undefined);
    }
  });
}

export interface PageSideOptions {
  handles: (req: HttpRequest) => boolean;
  respond: (req: HttpRequest) => Promise<{ status: string; entity: unknown }>;
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
          handled: true,
          error: cause instanceof Error ? cause.message : String(cause),
        } satisfies BridgeResponse);
      }
    })();
  };

  options.source.addEventListener('message', listener);
  return () => options.source.removeEventListener?.('message', listener);
}

function canSafelyRetry(request: HttpRequest): boolean {
  const method = request.method.toUpperCase();
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function localFailure(
  options: WorkerSideOptions,
  status: number,
  error: string,
  outcome: string,
): unknown {
  return options.buildResponse(JSON.stringify({ ok: false, source: 'local', error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Offline-Sync': outcome,
    },
  });
}

export function connectBridge(syncInstance: any): () => void {
  const nav = typeof globalThis !== 'undefined' ? (globalThis as any).navigator : undefined;
  if (!nav || !nav.serviceWorker) {
    return () => {};
  }
  const stopBridge = bridgeServiceWorker({
    handles: (req) => syncInstance.handles(req),
    respond: (req) => syncInstance.interceptRequest(req),
    source: nav.serviceWorker,
    logger: syncInstance.logger,
  });
  // The bridge above is only ever reached if a Service Worker actually controls this
  // page -- a registration with too narrow a `scope` wires everything up without error
  // and then answers nothing, ever. See warnIfNeverControlled's doc comment.
  const stopWarning = warnIfNeverControlled({ navigator: nav, logger: syncInstance.logger });
  return () => {
    stopBridge();
    stopWarning();
  };
}
