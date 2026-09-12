/**
 * The bridge, tested with a fake browser. Vitest runs in a `node`
 * environment: no `clients`, no `MessageChannel`, no `Response`. They're
 * built here in a few lines, which has the benefit of making the bridge's
 * dependencies explicit.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  bridgeServiceWorker,
  BRIDGE_CHANNEL,
  serveFromPage,
  type BridgeRequest,
  type BridgeResponse,
} from '../../src/pwa/Bridge.js';

/** A pair of linked ports, like a real MessageChannel. */
function fakeChannel() {
  const port1: any = { onmessage: null, close: () => {}, start: () => {} };
  const port2: any = {
    onmessage: null,
    postMessage: (m: unknown) => port1.onmessage?.({ data: m }),
    close: () => {},
  };
  port1.postMessage = (m: unknown) => port2.onmessage?.({ data: m });
  return { port1, port2 };
}

/** A minimal response: keeps only what the tests look at. */
function buildResponse(body: string, init: { status: number; headers: Record<string, string> }) {
  return { body, status: init.status, headers: init.headers };
}

/** A tab that answers whatever it's told to answer. */
function tabThatAnswers(response: BridgeResponse | undefined) {
  return {
    postMessage: (message: unknown, transfer?: unknown[]) => {
      const port = (transfer?.[0] ?? undefined) as { postMessage: (m: unknown) => void } | undefined;
      if (response !== undefined) port?.postMessage(response);
      void message;
    },
  };
}

function clientsWith(tab: unknown | undefined) {
  return {
    get: async () => tab as never,
    matchAll: async () => (tab === undefined ? [] : [tab as never]),
  };
}

const req = { method: 'GET', url: '/api/education/tags' };

describe('the bridge, Service Worker side', () => {
  it('returns what the page read from the local database', async () => {
    const network = vi.fn(async () => ({ body: 'from the network', status: 200, headers: {} }));
    const respond = serveFromPage({
      clients: clientsWith(tabThatAnswers({ handled: true, status: 'Success', entity: [{ id: 't-1' }] })),
      openChannel: fakeChannel,
      buildResponse,
      goToNetwork: network,
    });

    const response = (await respond({ raw: {}, clientId: 'c-1', request: req })) as {
      body: string;
      headers: Record<string, string>;
    };

    expect(network).not.toHaveBeenCalled();
    expect(JSON.parse(response.body)).toEqual([{ id: 't-1' }]);
    expect(response.headers['X-Offline-Sync']).toBe('local-database');
  });

  it('goes to the network when the page says it is not for it', async () => {
    const network = vi.fn(async () => 'from the network');
    const respond = serveFromPage({
      clients: clientsWith(tabThatAnswers({ handled: false })),
      openChannel: fakeChannel,
      buildResponse,
      goToNetwork: network,
    });

    expect(await respond({ raw: {}, clientId: 'c-1', request: req })).toBe('from the network');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('goes to the network when no tab is reachable at all', async () => {
    // The normal case when the browser wakes the Service Worker on its own:
    // nobody is there to read the database. Clients.get then returns undefined.
    const network = vi.fn(async () => 'from the network');
    const respond = serveFromPage({
      clients: clientsWith(undefined),
      openChannel: fakeChannel,
      buildResponse,
      goToNetwork: network,
    });

    expect(await respond({ raw: {}, clientId: 'c-1', request: req })).toBe('from the network');
  });

  it('NEVER BLOCKS when the page never answers', async () => {
    // The most important property here. No spec imposes a deadline on
    // respondWith: without this safety net, a busy page would hold the
    // request until the browser kills the Service Worker.
    vi.useFakeTimers();
    const network = vi.fn(async () => 'from the network');
    const respond = serveFromPage({
      clients: clientsWith(tabThatAnswers(undefined)),
      openChannel: fakeChannel,
      buildResponse,
      goToNetwork: network,
      timeoutMs: 50,
    });

    const promise = respond({ raw: {}, clientId: 'c-1', request: req });
    await vi.advanceTimersByTimeAsync(60);
    expect(await promise).toBe('from the network');
    vi.useRealTimers();
  });

  it('falls back to any open tab when the request names none', async () => {
    // clientId is the empty string on a navigation request: the page doesn't
    // exist yet. Since the local database is the same for everyone, any open
    // tab can answer.
    const tab = tabThatAnswers({ handled: true, status: 'Success', entity: 'ok' });
    const get = vi.fn(async () => undefined as never);
    const respond = serveFromPage({
      clients: { get, matchAll: async () => [tab as never] },
      openChannel: fakeChannel,
      buildResponse,
      goToNetwork: async () => 'from the network',
    });

    const response = (await respond({ raw: {}, clientId: '', request: req })) as { body: string };
    expect(get).not.toHaveBeenCalled();
    expect(JSON.parse(response.body)).toBe('ok');
  });
});

describe('the bridge, page side', () => {
  /** A `navigator.serviceWorker` reduced to what the bridge uses. */
  function fakeSource() {
    const listeners: ((e: unknown) => void)[] = [];
    return {
      source: {
        addEventListener: (_t: string, f: (e: unknown) => void) => listeners.push(f),
        removeEventListener: (_t: string, f: (e: unknown) => void) => {
          const i = listeners.indexOf(f);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      send: (data: unknown, port: unknown) => listeners.forEach((f) => f({ data, ports: [port] })),
      count: () => listeners.length,
    };
  }

  function message(): BridgeRequest {
    return { channel: BRIDGE_CHANNEL, request: req };
  }

  it('answers from the database when the module recognizes the request', async () => {
    const fake = fakeSource();
    bridgeServiceWorker({
      handles: () => true,
      respond: async () => ({ status: 'Success', entity: [{ id: 't-1' }] }),
      source: fake.source,
    });

    const received: BridgeResponse[] = [];
    fake.send(message(), { postMessage: (m: BridgeResponse) => received.push(m) });
    await new Promise((f) => setImmediate(f));

    expect(received[0]).toEqual({ handled: true, status: 'Success', entity: [{ id: 't-1' }] });
  });

  it('says it is not for it when the module does not recognize the request', async () => {
    const fake = fakeSource();
    bridgeServiceWorker({
      handles: () => false,
      respond: async () => {
        throw new Error('must never be called');
      },
      source: fake.source,
    });

    const received: BridgeResponse[] = [];
    fake.send(message(), { postMessage: (m: BridgeResponse) => received.push(m) });
    await new Promise((f) => setImmediate(f));

    expect(received[0]).toEqual({ handled: false });
  });

  it('falls back to the network rather than staying silent when the database fails', async () => {
    // Staying silent would make the Service Worker wait out its whole timeout for nothing.
    const fake = fakeSource();
    const errors: unknown[] = [];
    bridgeServiceWorker({
      handles: () => true,
      respond: async () => {
        throw new Error('database closed');
      },
      source: fake.source,
      logger: { error: (_m, c) => errors.push(c) },
    });

    const received: BridgeResponse[] = [];
    fake.send(message(), { postMessage: (m: BridgeResponse) => received.push(m) });
    await new Promise((f) => setImmediate(f));

    expect(received[0]).toMatchObject({ handled: false, error: 'database closed' });
    expect(errors).toHaveLength(1);
  });

  it('ignores messages that are not its own', async () => {
    const fake = fakeSource();
    const respond = vi.fn();
    bridgeServiceWorker({ handles: () => true, respond: respond as never, source: fake.source });

    fake.send({ type: 'something-else' }, { postMessage: () => {} });
    await new Promise((f) => setImmediate(f));

    expect(respond).not.toHaveBeenCalled();
  });

  it('unsubscribes on request', () => {
    const fake = fakeSource();
    const unsubscribe = bridgeServiceWorker({
      handles: () => true,
      respond: async () => ({ status: 'Success', entity: null }),
      source: fake.source,
    });
    expect(fake.count()).toBe(1);
    unsubscribe();
    expect(fake.count()).toBe(0);
  });
});
