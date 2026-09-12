import { describe, expect, it, vi } from 'vitest';

import type { AccessLocalDatabase } from '../src/core/AccessLocalDatabase.js';
import { ClassifiedError } from '../src/core/ClassifiedError.js';
import { Converter } from '../src/core/Converter.js';
import { DuplicateGuard } from '../src/core/DuplicateGuard.js';
import type { Handler, Response } from '../src/core/Handler.js';
import type { HttpClient, HttpClientResponse } from '../src/core/HttpClient.js';
import { HandlerMismatchError, Interceptor } from '../src/core/Interceptor.js';
import { SilentLogger } from '../src/core/Logger.js';
import type { OperationMapping } from '../src/core/OperationMapping.js';
import { RequestRegistry } from '../src/core/RequestRegistry.js';

const ok: Response = { status: 'Success', entity: { id: 'c-1' } };

function op(over: Partial<OperationMapping> = {}): OperationMapping {
  return {
    operationId: 'createBlog',
    method: 'POST',
    path: '/api/v1/blogs',
    serverPath: '/api/v1/blogs',
    connectivity: 'offline',
    handle: 'createBlog',
    ...over,
  };
}

const db = {} as AccessLocalDatabase;

function build(
  operations: OperationMapping[],
  handlers: Record<string, Handler>,
  http?: Partial<HttpClient>,
) {
  const requests = new RequestRegistry();
  requests.registerAll(handlers);
  const send = vi.fn(
    http?.send ??
      (async (): Promise<HttpClientResponse> => ({
        status: 200,
        headers: {},
        body: { relayed: true },
      })),
  );
  const duplicates = new DuplicateGuard();
  const interceptor = new Interceptor({
    converter: Converter.fromOfflineMap({ operations }),
    requests,
    db,
    http: { send },
    logger: new SilentLogger(),
    duplicates,
  });
  return { interceptor, send, duplicates };
}

const post = (body?: unknown) => ({ method: 'POST', url: '/api/v1/blogs', body });

describe('Interceptor -- offline branch', () => {
  it('calls the handler with the local database and the request values', async () => {
    const localWrite = vi.fn(async () => ok);
    const { interceptor } = build(
      [op({ path: '/api/v1/blogs/{id}' })],
      { createBlog: { localWrite } },
    );

    const out = await interceptor.interceptRequest({
      method: 'POST',
      url: '/api/v1/blogs/7?draft=true',
      body: { title: 'a' },
    });

    expect(out).toBe(ok);
    expect(localWrite).toHaveBeenCalledWith(db, {
      id: '7',
      draft: 'true',
      title: 'a',
      _metadata: expect.any(String),
    });
  });

  it('gives the handler what it needs to replay, without the handler building it', async () => {
    // The whole point of the mechanism: what gets replayed is the intercepted
    // request, COPIED. No reconstruction from ctx, where the body's structure
    // and the query string would already be gone.
    let seen: Record<string, unknown> | undefined;
    const localWrite = vi.fn(async (_db, ctx: Record<string, unknown>) => {
      seen = ctx;
      return ok;
    });
    const { interceptor } = build([op({ path: '/api/v1/blogs/{id}' })], {
      createBlog: { localWrite },
    });

    await interceptor.interceptRequest({
      method: 'post',
      url: '/api/v1/blogs/7?draft=true',
      body: { title: 'a', author: { id: 'u-1', name: 'Ada' } },
    });

    expect(JSON.parse(String(seen?.['_metadata']))).toEqual({
      method: 'POST',
      // The query string is KEPT: replaying it without it would ask for
      // something other than what the user requested.
      path: '/api/v1/blogs/7?draft=true',
      operationId: 'createBlog',
      // The nested object survives, though extractParams dropped it from ctx.
      body: { title: 'a', author: { id: 'u-1', name: 'Ada' } },
    });
    expect(seen?.['author']).toBeUndefined();
  });

  it('lets the handler\'s override win', async () => {
    // The only case where a handler still has a say: what must be sent to
    // the server differs from what the application sent.
    let seen: Record<string, unknown> | undefined;
    const localWrite = vi.fn(async (_db, ctx: Record<string, unknown>) => {
      seen = ctx;
      return ok;
    });
    const { interceptor } = build([op()], {
      createBlog: {
        localWrite,
        constructMetadata: (_ctx, req) =>
          JSON.stringify({ method: 'PUT', path: '/elsewhere', received: req.method }),
      },
    });

    await interceptor.interceptRequest(post({ title: 'a' }));

    expect(JSON.parse(String(seen?.['_metadata']))).toEqual({
      method: 'PUT',
      path: '/elsewhere',
      received: 'POST',
    });
  });

  it('does not let a body field supersede the module\'s metadata', async () => {
    let seen: Record<string, unknown> | undefined;
    const localWrite = vi.fn(async (_db, ctx: Record<string, unknown>) => {
      seen = ctx;
      return ok;
    });
    const { interceptor } = build([op()], { createBlog: { localWrite } });

    await interceptor.interceptRequest(post({ _metadata: 'made up by the caller' }));

    expect(JSON.parse(String(seen?.['_metadata']))).toMatchObject({
      operationId: 'createBlog',
    });
  });

  it('never calls the network on an offline operation', async () => {
    const { interceptor, send } = build([op()], {
      createBlog: { localWrite: async () => ok },
    });

    await interceptor.interceptRequest(post({ title: 'a' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('remembers the response for the next identical click', async () => {
    const localWrite = vi.fn(async () => ok);
    const { interceptor } = build([op()], { createBlog: { localWrite } });

    const first = await interceptor.interceptRequest(post({ title: 'a' }));
    const second = await interceptor.interceptRequest(post({ title: 'a' }));

    expect(second).toBe(first);
    // The double-click produced only one write.
    expect(localWrite).toHaveBeenCalledTimes(1);
  });

  it('does not confuse two requests whose body differs', async () => {
    const localWrite = vi.fn(async () => ok);
    const { interceptor } = build([op()], { createBlog: { localWrite } });

    await interceptor.interceptRequest(post({ title: 'a' }));
    await interceptor.interceptRequest(post({ title: 'b' }));

    expect(localWrite).toHaveBeenCalledTimes(2);
  });

  it('respects the window declared by the operation', async () => {
    const localWrite = vi.fn(async () => ok);
    const { interceptor, duplicates } = build([op({ dedupWindowMs: 0 })], {
      createBlog: { localWrite },
    });

    await interceptor.interceptRequest(post({ title: 'a' }));
    await interceptor.interceptRequest(post({ title: 'a' }));

    // Zero window: nothing is ever considered a duplicate.
    expect(localWrite).toHaveBeenCalledTimes(2);
    expect(duplicates.size).toBe(1);
  });
});

describe('Interceptor -- online branch', () => {
  const onlineOp = op({ connectivity: 'online', handle: 'auth' });

  it('lets the handler call the network itself', async () => {
    const online = vi.fn(async () => ok);
    const { interceptor, send } = build([onlineOp], { auth: { online } });

    const out = await interceptor.interceptRequest(post({ password: 'x' }));

    expect(out).toBe(ok);
    // The Interceptor must NOT send it itself: otherwise the request would
    // go out twice, once from it and once from the handler.
    expect(send).not.toHaveBeenCalled();
    expect(online).toHaveBeenCalledTimes(1);
  });

  it('surfaces the failure to the application, classified, without queuing anything', async () => {
    const { interceptor } = build([onlineOp], {
      auth: {
        async online() {
          throw new Error('network unreachable');
        },
      },
    });

    const err = await interceptor
      .interceptRequest(post({ password: 'x' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClassifiedError);
    expect((err as ClassifiedError).kind).toBe('retry');
    expect((err as ClassifiedError).reason).toBe('network unreachable');
  });

  it('does not remember a failed online request', async () => {
    const online = vi.fn(async () => {
      throw new Error('outage');
    });
    const { interceptor } = build([onlineOp], { auth: { online } });

    await interceptor.interceptRequest(post()).catch(() => undefined);
    await interceptor.interceptRequest(post()).catch(() => undefined);

    // No response was produced, so there is nothing to replay: the second
    // attempt must go out for real.
    expect(online).toHaveBeenCalledTimes(2);
  });

  it('keeps the classification when the handler already throws a ClassifiedError', async () => {
    const { interceptor } = build([onlineOp], {
      auth: {
        async online() {
          throw new ClassifiedError('reject', 'invalid password');
        },
      },
    });

    const err = (await interceptor
      .interceptRequest(post())
      .catch((e: unknown) => e)) as ClassifiedError;

    expect(err.kind).toBe('reject');
    expect(err.reason).toBe('invalid password');
  });
});

describe('Interceptor -- request unknown to the map', () => {
  it('relays the request to the server rather than refusing it', async () => {
    const { interceptor, send } = build([op()], {
      createBlog: { localWrite: async () => ok },
    });

    const out = await interceptor.interceptRequest({
      method: 'GET',
      url: '/api/v1/not-declared',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: 'Success', entity: { relayed: true } });
  });

  it('marks a relayed response outside the 2xx range as Fail', async () => {
    const { interceptor } = build([], {}, {
      send: async () => ({ status: 404, headers: {}, body: { error: 'x' } }),
    });

    const out = await interceptor.interceptRequest({ method: 'GET', url: '/x' });
    expect(out.status).toBe('Fail');
  });

  it('classifies the transport failure of a relayed request', async () => {
    const { interceptor } = build([], {}, {
      send: async () => {
        throw new Error('no network');
      },
    });

    const err = await interceptor
      .interceptRequest({ method: 'GET', url: '/x' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClassifiedError);
  });
});

describe('Interceptor -- configuration defects', () => {
  it('reports a handle the handlers file does not know', async () => {
    const { interceptor } = build([op({ handle: 'missing' })], {
      createBlog: { localWrite: async () => ok },
    });

    await expect(interceptor.interceptRequest(post())).rejects.toThrow(
      HandlerMismatchError,
    );
    await expect(interceptor.interceptRequest(post())).rejects.toThrow(/"missing"/);
  });

  it('reports an offline operation whose handler does not write', async () => {
    const { interceptor } = build([op()], {
      createBlog: { online: async () => ok },
    });

    await expect(interceptor.interceptRequest(post())).rejects.toThrow(
      /declared "offline"/,
    );
  });

  it('reports an online operation whose handler does not call the network', async () => {
    const { interceptor } = build(
      [op({ connectivity: 'online' })],
      { createBlog: { localWrite: async () => ok } },
    );

    await expect(interceptor.interceptRequest(post())).rejects.toThrow(
      /declared "online"/,
    );
  });
});

describe('Interceptor -- logging', () => {
  it('logs every incoming request, and the discarded duplicate', async () => {
    const logger = new SilentLogger();
    const debug = vi.spyOn(logger, 'debug');
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');

    const requests = new RequestRegistry();
    requests.register('createBlog', { localWrite: async () => ok });
    const interceptor = new Interceptor({
      converter: Converter.fromOfflineMap({ operations: [op()] }),
      requests,
      db,
      http: { send: async () => ({ status: 200, headers: {}, body: null }) },
      logger,
    });

    await interceptor.interceptRequest(post({ t: 'a' }));
    await interceptor.interceptRequest(post({ t: 'a' }));

    expect(debug).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
