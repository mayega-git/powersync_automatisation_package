import { describe, expect, it } from 'vitest';
import { AERIS_CHANNEL, connectAerisServiceWorker, installAerisFetch } from '../../../src/aeris/runtime/browser.js';
import type { AerisRuntime } from '../../../src/aeris/runtime/runtime.js';
import type { RuntimeRequest, RuntimeResponse } from '../../../src/aeris/runtime/transport.js';

describe('browser integration', () => {
  it('routes matching fetch calls through the runtime and leaves others alone', async () => {
    const seen: string[] = [];
    const target = { fetch: (async (input: RequestInfo | URL) => {
      seen.push(`network ${String(input)}`);
      return new Response('net');
    }) as typeof fetch };
    const runtime = { fetch: async (request: Request) => {
      seen.push(`runtime ${request.method} ${request.url}`);
      return new Response('{"ok":true}', { status: 200 });
    } } as unknown as AerisRuntime;
    const { restore } = installAerisFetch(runtime, { target, match: (url) => url.origin === 'https://api.test' });
    expect(await (await target.fetch('https://api.test/items/1')).text()).toBe('{"ok":true}');
    expect(await (await target.fetch('https://cdn.test/app.js')).text()).toBe('net');
    restore();
    expect(seen).toEqual(['runtime GET https://api.test/items/1', 'network https://cdn.test/app.js']);
  });

  it('answers Service Worker requests and delegates network calls back to the worker', async () => {
    const listeners: ((event: { data: unknown; ports: readonly MessagePort[] }) => void)[] = [];
    const container = {
      addEventListener: (_type: 'message', listener: (event: { data: unknown; ports: readonly MessagePort[] }) => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    };
    const runtime = {
      handle: async (request: RuntimeRequest, via?: { network?: (request: RuntimeRequest) => Promise<RuntimeResponse> }) => {
        const upstream = await via!.network!(request);
        return { ...upstream, headers: { ...upstream.headers, 'x-aeris-state': 'checked' } };
      },
    } as unknown as AerisRuntime;
    const stop = connectAerisServiceWorker(runtime, container as never);
    const channel = new MessageChannel();
    const reply = new Promise<unknown>((resolve) => {
      channel.port1.onmessage = (event) => {
        const data = event.data as { kind: string; request?: RuntimeRequest };
        if (data.kind === 'network-request') {
          channel.port1.postMessage({ channel: AERIS_CHANNEL, kind: 'network-response', response: { status: 200, headers: {}, body: `from worker ${data.request!.url}` } });
        } else {
          resolve(data);
        }
      };
    });
    listeners[0]!({ data: { channel: AERIS_CHANNEL, kind: 'request', request: { method: 'GET', url: 'https://api.test/x', headers: {}, body: null } }, ports: [channel.port2] });
    expect(await reply).toEqual({ kind: 'response', response: { status: 200, headers: { 'x-aeris-state': 'checked' }, body: 'from worker https://api.test/x' } });
    channel.port1.close();
    stop();
  });
});
