import { describe, expect, it } from 'vitest';

import type { Handler, Request } from '../src/core/Handler.js';
import { isOnlineHandler, isRequestHandler } from '../src/core/Handler.js';
import {
  HandlerRegistrationError,
  RequestRegistry,
} from '../src/core/RequestRegistry.js';

const offline: Handler = {
  async localWrite() {
    return { status: 'Success', entity: null };
  },
};

const online: Handler = {
  async online() {
    return { status: 'Success', entity: null };
  },
};

describe('RequestRegistry', () => {
  it('stores a handler and returns it under its name', () => {
    const r = new RequestRegistry();
    r.register('createBlog', offline);

    expect(r.get('createBlog')).toBe(offline);
    expect(r.size).toBe(1);
  });

  it('returns undefined for an unknown name, without throwing', () => {
    // The deferred upload depends on this: throwing would replay the
    // transaction forever instead of discarding the write to the dead-letter store.
    expect(new RequestRegistry().get('missing')).toBeUndefined();
  });

  it('refuses two handlers under the same name rather than silently overwriting', () => {
    const r = new RequestRegistry();
    r.register('createBlog', offline);

    expect(() => r.register('createBlog', online)).toThrow(HandlerRegistrationError);
    expect(() => r.register('createBlog', online)).toThrow(/"createBlog"/);
    expect(r.get('createBlog')).toBe(offline);
  });

  it('registers a whole handlers file at once', () => {
    const r = new RequestRegistry();
    r.registerAll({ createBlog: offline, authenticate: online });

    expect(r.names().sort()).toEqual(['authenticate', 'createBlog']);
  });

  it('accepts both kinds of handler without distinguishing them', () => {
    // The registry doesn't sort: the operations map decides the branch,
    // never the shape of the object.
    const r = new RequestRegistry();
    r.registerAll({ a: offline, b: online });

    expect(isRequestHandler(r.get('a')!)).toBe(true);
    expect(isOnlineHandler(r.get('b')!)).toBe(true);
    expect(isOnlineHandler(r.get('a')!)).toBe(false);
  });

  it('keeps the handler as-is, without copying or wrapping it', () => {
    const stateful: Request = {
      calls: 0,
      async localWrite() {
        this.calls += 1;
        return { status: 'Success', entity: null };
      },
    } as Request & { calls: number };

    const r = new RequestRegistry();
    r.register('h', stateful);
    expect(r.get('h')).toBe(stateful);
  });
});
