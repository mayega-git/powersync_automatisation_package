import { describe, expect, it } from 'vitest';

import { CacheRules } from '../../src/pwa/CacheRules.js';

const declaration = {
  tag_entity: '/api/education/tags',
  category_entity: [
    'GET /api/education/categories',
    'POST /api/education/categories',
    'PUT /api/education/categories/{id}',
  ],
};

const rules = CacheRules.create({ entities: declaration });

describe('FORBIDDEN 1: what stays online no matter what', () => {
  it('refuses to keep anything from /api/auth', () => {
    expect(rules.isAlwaysOnline('/api/auth')).toBe(true);
    expect(rules.isAlwaysOnline('/api/auth/me')).toBe(true);
    expect(rules.isForbidden('GET', '/api/auth/me')).toBe(true);
  });

  it('does not confuse /api/authors with /api/auth', () => {
    // The overflowing-prefix trap: "authors" starts with "auth" without
    // being it. Without cutting on "/", every /api/authors would be blocked.
    expect(rules.isAlwaysOnline('/api/authors')).toBe(false);
    expect(rules.isForbidden('GET', '/api/authors')).toBe(false);
  });

  it('accepts a list other than the default', () => {
    const other = CacheRules.create({
      entities: declaration,
      onlineOnly: ['/api/session'],
    });
    expect(other.isAlwaysOnline('/api/session/me')).toBe(true);
    expect(other.isAlwaysOnline('/api/auth/me')).toBe(false);
  });
});

describe('FORBIDDEN 2: what belongs to the module', () => {
  it('recognizes a path covered by a declared prefix', () => {
    expect(rules.belongsToModule('GET', '/api/education/tags')).toBe(true);
    expect(rules.belongsToModule('GET', '/api/education/tags/42')).toBe(true);
    expect(rules.belongsToModule('POST', '/api/education/tags')).toBe(true);
  });

  it('recognizes a path ranked under a table, hole included', () => {
    expect(rules.belongsToModule('PUT', '/api/education/categories/7')).toBe(true);
  });

  it('does not recognize a sub-resource: it is not a row of the table', () => {
    expect(rules.belongsToModule('GET', '/api/education/tags/42/stats')).toBe(false);
  });

  it('recognizes nothing that is not declared', () => {
    expect(rules.belongsToModule('GET', '/api/education/blogs')).toBe(false);
    expect(rules.isForbidden('GET', '/api/education/blogs')).toBe(false);
  });

  it('forbids keeping what belongs to the module', () => {
    // Otherwise the cache and the local database would contradict each
    // other on the same data.
    expect(rules.isForbidden('GET', '/api/education/tags')).toBe(true);
  });
});

describe('FORBIDDEN 3: writes', () => {
  it('refuses to keep any write, even an undeclared one', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(rules.isForbidden(method, '/api/education/blogs')).toBe(true);
    }
  });

  it('lets GET and HEAD through', () => {
    expect(rules.isWrite('GET')).toBe(false);
    expect(rules.isWrite('head')).toBe(false);
  });
});

describe('a bad declaration does not kill the Service Worker', () => {
  it('does not throw, and behaves as if nothing belonged to the module', () => {
    // Throwing here would kill the Service Worker at load time, and with it
    // the shell, and the whole application: a blank screen. Degrade instead
    // of breaking.
    const broken = CacheRules.create({ entities: { a: '/', b: '/' } });
    expect(broken.belongsToModule('GET', '/api/education/tags')).toBe(false);
    expect(broken.paths()).toEqual([]);
    // The other two forbidden rules still hold.
    expect(broken.isForbidden('POST', '/api/education/tags')).toBe(true);
    expect(broken.isForbidden('GET', '/api/auth/me')).toBe(true);
  });
});

describe('the list of declared paths', () => {
  it('returns both kinds, under their rule\'s name', () => {
    expect(rules.paths()).toEqual([
      { kind: 'prefix', path: '/api/education/tags' },
      { kind: 'path', path: '/api/education/categories' },
      { kind: 'path', path: '/api/education/categories/{id}' },
    ]);
  });
});

describe('a replay sent by the module itself', () => {
  it('is recognized and must be let through', () => {
    // Without this guard, the Service Worker would hand the replay back to
    // the page, which would write it back to the local database: the queue
    // would empty with nothing reaching the server. Observed in the browser
    // before being fixed.
    const headers = new Map([['X-Offline-Sync-Replay', '1']]);
    expect(rules.isReplay({ get: (n) => headers.get(n) ?? null })).toBe(true);
  });

  it('an ordinary request is not one', () => {
    expect(rules.isReplay({ get: () => null })).toBe(false);
    expect(rules.isReplay(undefined)).toBe(false);
  });
});
