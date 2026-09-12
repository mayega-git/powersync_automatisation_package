import { describe, expect, it, vi } from 'vitest';

import {
  patchFetch,
  RELOAD_FLAG,
  reloadOnce,
} from '../../src/pwa/Startup.js';
import { REPLAY_HEADER } from '../../src/core/OfflineSyncConnector.js';

/** A sessionStorage reduced to its two useful methods. */
function session(start: Record<string, string> = {}) {
  const content = { ...start };
  return {
    getItem: (k: string) => content[k] ?? null,
    setItem: (k: string, v: string) => {
      content[k] = v;
    },
    content,
  };
}

describe('one-time reload after taking control', () => {
  it('reloads once when the Service Worker just took over', async () => {
    const reload = vi.fn();
    const s = session();

    await reloadOnce({
      controlled: Promise.resolve(),
      session: s,
      reload,
      alreadyControlled: false,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(s.content[RELOAD_FLAG]).toBe('1');
  });

  it('does not reload when a Service Worker already controlled the page', async () => {
    // Nothing to catch up on: every request from this page already went through it.
    const reload = vi.fn();
    await reloadOnce({
      controlled: Promise.resolve(),
      session: session(),
      reload,
      alreadyControlled: true,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads twice: that is the loop to avoid', async () => {
    const reload = vi.fn();
    const s = session({ [RELOAD_FLAG]: '1' });
    await reloadOnce({
      controlled: Promise.resolve(),
      session: s,
      reload,
      alreadyControlled: false,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('re-reads the flag AFTER waiting, in case another tab set it', async () => {
    const reload = vi.fn();
    const s = session();
    let release: () => void = () => {};
    const controlled = new Promise<void>((f) => {
      release = f;
    });

    const promise = reloadOnce({
      controlled,
      session: s,
      reload,
      alreadyControlled: false,
    });

    s.setItem(RELOAD_FLAG, '1');
    release();
    await promise;

    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the fallback: patching fetch', () => {
  const req = { method: 'GET', url: '/api/education/tags' };

  /** A `fetch` holder whose signature accepts whatever is passed to it. */
  function holderWith(original: (input: unknown, init?: unknown) => Promise<unknown>) {
    return { fetch: vi.fn(original) };
  }

  it('answers from the database when the module recognizes the request', async () => {
    const holder = holderWith(async () => 'from the network');
    patchFetch({
      holder,
      handles: () => true,
      respond: async () => ({ status: 'Success', entity: [{ id: 't-1' }] }),
      buildResponse: (body, init) => ({ body, ...init }),
      readRequest: async () => req,
    });

    const response = (await holder.fetch('/api/education/tags')) as { body: string };
    expect(JSON.parse(response.body)).toEqual([{ id: 't-1' }]);
  });

  it('lets through what the module does not recognize', async () => {
    const original = vi.fn(async (_e: unknown, _i?: unknown) => 'from the network');
    const holder = { fetch: original };
    patchFetch({
      holder,
      handles: () => false,
      respond: async () => ({ status: 'Success', entity: null }),
      buildResponse: (body, init) => ({ body, ...init }),
      readRequest: async () => req,
    });

    expect(await holder.fetch('/api/education/blogs')).toBe('from the network');
  });

  it('falls back to the network when the database fails, without breaking the call', async () => {
    const holder = holderWith(async () => 'from the network');
    patchFetch({
      holder,
      handles: () => true,
      respond: async () => {
        throw new Error('database closed');
      },
      buildResponse: (body, init) => ({ body, ...init }),
      readRequest: async () => req,
      logger: { error: () => {} },
    });

    expect(await holder.fetch('/api/education/tags')).toBe('from the network');
  });

  it('restores the original when unpatched', async () => {
    const original = vi.fn(async (_e: unknown, _i?: unknown) => 'from the network');
    const holder = { fetch: original };
    const unpatch = patchFetch({
      holder,
      handles: () => true,
      respond: async () => ({ status: 'Success', entity: 'local' }),
      buildResponse: (body, init) => ({ body, ...init }),
      readRequest: async () => req,
    });

    unpatch();
    expect(holder.fetch).toBe(original);
    expect(await holder.fetch('/api/education/tags')).toBe('from the network');
  });

  it('always lets a replay through, even on a path the module would otherwise capture (Fix 1)', async () => {
    // Without this check, a bridge without a Service Worker would re-capture
    // its own replayed writes and write them back to the local database
    // instead of letting them reach the server.
    const holder = holderWith(async () => 'from the network');
    const respond = vi.fn(async () => ({ status: 'Success', entity: 'local' }));
    patchFetch({
      holder,
      handles: () => true,
      respond,
      buildResponse: (body, init) => ({ body, ...init }),
      readRequest: async () => ({
        method: 'POST',
        url: '/api/education/tags',
        headers: { [REPLAY_HEADER]: '1' },
      }),
    });

    expect(await holder.fetch('/api/education/tags')).toBe('from the network');
    expect(respond).not.toHaveBeenCalled();
  });
});
