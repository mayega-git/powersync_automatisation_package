import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_TIMEOUT_MS, FetchClient, NetworkError } from '../src/core/FetchClient.js';

/** Minimal fetch response, without depending on the environment. */
function reply(
  body: string | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): globalThis.Response {
  // `new Response('', {status: 204})` throws: a 204 can't carry a body, even empty.
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'application/json' },
  });
}

/** Typed mock: without declared parameters, `mock.calls` would be typed empty. */
function mockFetch(
  impl: (url: string, init: RequestInit) => Promise<globalThis.Response>,
) {
  return vi.fn(impl);
}

describe('FetchClient', () => {
  it('sends method, url and serialized body', async () => {
    const fetch = mockFetch(async () => reply('{"ok":true}'));
    const client = new FetchClient({ fetch: fetch as never });

    const out = await client.send({
      method: 'POST',
      url: 'https://api.test/blogs',
      body: { title: 'a' },
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.test/blogs');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"title":"a"}');
    expect(out).toEqual({
      status: 200,
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
      body: { ok: true },
    });
  });

  it('prefixes relative paths with the base URL', async () => {
    const fetch = mockFetch(async () => reply('{}'));
    const client = new FetchClient({ baseUrl: 'https://api.test', fetch: fetch as never });

    await client.send({ method: 'GET', url: '/blogs/1' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.test/blogs/1');
  });

  it('sets the JSON type when the caller did not', async () => {
    const fetch = mockFetch(async () => reply('{}'));
    const client = new FetchClient({ fetch: fetch as never });

    await client.send({ method: 'POST', url: 'https://api.test/x', body: { a: 1 } });
    const init = fetch.mock.calls[0]![1];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('respects the type declared by the caller', async () => {
    const fetch = mockFetch(async () => reply('{}'));
    const client = new FetchClient({ fetch: fetch as never });

    await client.send({
      method: 'POST',
      url: 'https://api.test/x',
      headers: { 'content-type': 'text/plain' },
      body: 'raw',
    });

    const headers = fetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['content-type']).toBe('text/plain');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('sends no body when there is none', async () => {
    const fetch = mockFetch(async () => reply('{}'));
    const client = new FetchClient({ fetch: fetch as never });

    await client.send({ method: 'GET', url: 'https://api.test/x' });
    expect(fetch.mock.calls[0]![1].body).toBeUndefined();
  });

  it('returns a server rejection as a response, not as an error', async () => {
    // A 422 is a response: only the caller knows if it's final.
    const fetch = vi.fn(async () => reply('{"error":"missing title"}', { status: 422 }));
    const client = new FetchClient({ fetch: fetch as never });

    const out = await client.send({ method: 'POST', url: 'https://api.test/x' });
    expect(out.status).toBe(422);
    expect(out.body).toEqual({ error: 'missing title' });
  });

  it('returns null for an empty body', async () => {
    const fetch = vi.fn(async () => reply(null, { status: 204 }));
    const client = new FetchClient({ fetch: fetch as never });

    expect((await client.send({ method: 'DELETE', url: 'https://api.test/x' })).body).toBeNull();
  });

  it('returns raw text when the response is not JSON', async () => {
    const fetch = vi.fn(async () =>
      reply('page unavailable', { headers: { 'content-type': 'text/html' } }),
    );
    const client = new FetchClient({ fetch: fetch as never });

    expect((await client.send({ method: 'GET', url: 'https://api.test/x' })).body).toBe(
      'page unavailable',
    );
  });

  it('does not fail the call on malformed JSON', async () => {
    // The server answered: turning this into a network failure would look
    // like a connection outage.
    const fetch = vi.fn(async () => reply('{ not json'));
    const client = new FetchClient({ fetch: fetch as never });

    expect((await client.send({ method: 'GET', url: 'https://api.test/x' })).body).toBe(
      '{ not json',
    );
  });

  it('throws NetworkError when the transport fails', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = new FetchClient({ fetch: fetch as never });

    await expect(
      client.send({ method: 'GET', url: 'https://api.test/x' }),
    ).rejects.toThrow(NetworkError);
  });

  it('gives up past the timeout, saying so clearly', async () => {
    const fetch = mockFetch(
      async (_url, init) =>
        new Promise<globalThis.Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const client = new FetchClient({ timeoutMs: 5, fetch: fetch as never });

    const err = await client
      .send({ method: 'GET', url: 'https://api.test/slow' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain('5 ms');
  });

  it('clears the timer when the response arrives in time', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const fetch = mockFetch(async () => reply('{}'));
    const client = new FetchClient({ fetch: fetch as never });

    await client.send({ method: 'GET', url: 'https://api.test/x' });
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('defaults to ten seconds', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });
});
