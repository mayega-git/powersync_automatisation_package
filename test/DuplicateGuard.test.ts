import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEDUP_WINDOW_MS,
  DuplicateGuard,
  fingerprint,
} from '../src/core/DuplicateGuard.js';
import type { Response } from '../src/core/Handler.js';
import type { HttpRequest } from '../src/core/HttpRequest.js';

const ok: Response = { status: 'Success', entity: { id: 'c-1' } };

/** Manually driven clock: tests don't have to wait 5 real seconds. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const post = (body?: unknown): HttpRequest => ({
  method: 'POST',
  url: '/api/v1/blogs',
  body,
});

describe('DuplicateGuard', () => {
  it('finds nothing until something has been remembered', () => {
    expect(new DuplicateGuard().findRecent(post())).toBeUndefined();
  });

  it('returns the response already produced for an identical request', () => {
    const g = new DuplicateGuard();
    g.remember(post({ title: 'a' }), ok);

    expect(g.findRecent(post({ title: 'a' }))).toBe(ok);
  });

  it('does not confuse two requests whose body differs by one field', () => {
    const g = new DuplicateGuard();
    g.remember(post({ title: 'a' }), ok);

    expect(g.findRecent(post({ title: 'b' }))).toBeUndefined();
  });

  it('recognizes the same body written with keys in a different order', () => {
    // Without sorting the keys, two identical objects would produce two
    // different fingerprints and the duplicate would slip through.
    const g = new DuplicateGuard();
    g.remember(post({ a: 1, b: 2 }), ok);

    expect(g.findRecent(post({ b: 2, a: 1 }))).toBe(ok);
  });

  it('also sorts the keys of nested objects', () => {
    const g = new DuplicateGuard();
    g.remember(post({ author: { name: 'x', id: 1 } }), ok);

    expect(g.findRecent(post({ author: { id: 1, name: 'x' } }))).toBe(ok);
  });

  it('does not confuse two requests with different methods', () => {
    const g = new DuplicateGuard();
    g.remember({ method: 'POST', url: '/a' }, ok);

    expect(g.findRecent({ method: 'PUT', url: '/a' })).toBeUndefined();
  });

  it('does not confuse two requests with different paths', () => {
    const g = new DuplicateGuard();
    g.remember({ method: 'POST', url: '/a' }, ok);

    expect(g.findRecent({ method: 'POST', url: '/b' })).toBeUndefined();
  });

  it('distinguishes two different query strings on the same path', () => {
    const g = new DuplicateGuard();
    g.remember({ method: 'GET', url: '/a?page=1' }, ok);

    expect(g.findRecent({ method: 'GET', url: '/a?page=2' })).toBeUndefined();
  });

  it('forgets past the window', () => {
    const c = clock();
    const g = new DuplicateGuard({ now: c.now });
    g.remember(post(), ok);

    c.advance(DEFAULT_DEDUP_WINDOW_MS - 1);
    expect(g.findRecent(post())).toBe(ok);

    c.advance(1);
    expect(g.findRecent(post())).toBeUndefined();
  });

  it('uses the operation window when it declares one', () => {
    const c = clock();
    const g = new DuplicateGuard({ now: c.now });
    g.remember(post(), ok);

    c.advance(30_000);
    // Outside the default window, but within this operation's own window.
    expect(g.findRecent(post(), 60_000)).toBe(ok);
  });

  it('evicts an expired fingerprint instead of keeping it forever', () => {
    const c = clock();
    const g = new DuplicateGuard({ now: c.now });
    g.remember(post(), ok);
    c.advance(DEFAULT_DEDUP_WINDOW_MS);

    g.findRecent(post());
    expect(g.size).toBe(0);
  });

  it('restarts the window from the last hit when the same request returns', () => {
    const c = clock();
    const g = new DuplicateGuard({ now: c.now });
    g.remember(post(), ok);

    c.advance(4_000);
    g.remember(post(), ok);
    c.advance(4_000);

    // 8 seconds since the first hit, 4 since the second.
    expect(g.findRecent(post())).toBe(ok);
    expect(g.size).toBe(1);
  });

  it('does not let memory grow without bound', () => {
    const g = new DuplicateGuard({ maxEntries: 3 });
    for (let i = 0; i < 10; i += 1) {
      g.remember({ method: 'POST', url: `/a/${i}` }, ok);
    }

    expect(g.size).toBe(3);
    expect(g.findRecent({ method: 'POST', url: '/a/0' })).toBeUndefined();
    expect(g.findRecent({ method: 'POST', url: '/a/9' })).toBe(ok);
  });

  it('distinguishes a missing body from an empty one', () => {
    const g = new DuplicateGuard();
    g.remember(post(), ok);

    expect(g.findRecent(post({}))).toBeUndefined();
  });

  it('forgets everything on request', () => {
    const g = new DuplicateGuard();
    g.remember(post(), ok);
    g.clear();

    expect(g.findRecent(post())).toBeUndefined();
  });
});

describe('DuplicateGuard -- body signature', () => {
  it('keeps a constant-size fingerprint regardless of the body', () => {
    // The whole point of signing rather than storing: a 50KB article must not
    // occupy 50KB in memory for 5 seconds.
    const small = fingerprint(post({ t: 'a' }));
    const big = fingerprint(post({ t: 'x'.repeat(50_000) }));
    const huge = fingerprint(post({ t: 'x'.repeat(500_000) }));

    // The fingerprint only grows by the length digits: a ten-times-bigger
    // body adds ONE character, not ten times more.
    expect(big.length - small.length).toBeLessThanOrEqual(5);
    expect(huge.length - big.length).toBe(1);
    expect(huge.length).toBeLessThan(80);
  });

  it('always gives the same fingerprint for the same request', () => {
    const req = post({ title: 'a', body: 'long text' });
    expect(fingerprint(req)).toBe(fingerprint(req));
  });

  it('detects a one-character change in the middle of a long body', () => {
    const a = 'x'.repeat(20_000) + 'a' + 'y'.repeat(20_000);
    const b = 'x'.repeat(20_000) + 'b' + 'y'.repeat(20_000);

    expect(fingerprint(post({ t: a }))).not.toBe(fingerprint(post({ t: b })));
  });

  it('detects two same-length bodies with two swapped characters', () => {
    expect(fingerprint(post({ t: 'ab' }))).not.toBe(fingerprint(post({ t: 'ba' })));
  });

  it('produces no collision across 20,000 different bodies', () => {
    // A collision here would silently drop a legitimate write and hand the
    // user the response of an ANOTHER request.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      seen.add(fingerprint(post({ title: `article ${i}`, body: 'x'.repeat(i % 97) })));
    }
    expect(seen.size).toBe(20_000);
  });

  it('produces no collision across bodies that differ by a single bit', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) {
      seen.add(fingerprint(post({ n: i })));
    }
    expect(seen.size).toBe(5_000);
  });

  it('spreads the signature across four independent quarters', () => {
    // If two seeds produced the same thing, there would be 32 useful bits,
    // not 128, and collisions would become possible again.
    const sig = fingerprint(post({ t: 'control' })).split('\n').pop()!;
    const quarters = [
      sig.slice(0, 8),
      sig.slice(8, 16),
      sig.slice(16, 24),
      sig.slice(24, 32),
    ];
    expect(sig).toHaveLength(32);
    expect(new Set(quarters).size).toBe(4);
  });

  it('still distinguishes a missing body from an empty one', () => {
    expect(fingerprint(post())).not.toBe(fingerprint(post({})));
  });
});
