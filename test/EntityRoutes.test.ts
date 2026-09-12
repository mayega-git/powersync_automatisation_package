import { describe, expect, it } from 'vitest';

import {
  EntityRoutes,
  EntityRoutesError,
  type EntitiesDeclaration,
} from '../src/core/EntityRoutes.js';

/** yownews's real declaration: two tables, two lines. */
const YOWNEWS: EntitiesDeclaration = {
  tag_entity: '/api/education/tags',
  category_entity: '/api/education/categories',
};

describe('rule 1: by prefix', () => {
  const r = EntityRoutes.build(YOWNEWS);

  it('recognizes the collection', () => {
    expect(r.resolve('GET', '/api/education/tags')).toEqual({
      table: 'tag_entity',
      pathParams: {},
      rule: 1,
    });
  });

  it('recognizes one row, and names the segment after it "id"', () => {
    expect(r.resolve('DELETE', '/api/education/tags/t-1')).toEqual({
      table: 'tag_entity',
      pathParams: { id: 't-1' },
      rule: 1,
    });
  });

  it('covers the five requests of a table with a single line', () => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    for (const m of methods) {
      expect(r.resolve(m, '/api/education/tags/t-1')?.table).toBe('tag_entity');
    }
  });

  it('correctly separates the two tables', () => {
    expect(r.resolve('GET', '/api/education/categories')?.table).toBe(
      'category_entity',
    );
  });

  it('lets through what is not declared', () => {
    // This is what makes the module adoptable: what isn't declared isn't
    // broken, it goes to the network as before.
    expect(r.resolve('GET', '/api/education/courses')).toBeUndefined();
    expect(r.resolve('POST', '/api/auth/login')).toBeUndefined();
  });

  it('lets through a sub-resource: it is not a row of the table', () => {
    expect(r.resolve('GET', '/api/education/tags/t-1/stats')).toBeUndefined();
  });

  it('decodes the segment that designates the row', () => {
    expect(r.resolve('GET', '/api/education/tags/a%20b')?.pathParams).toEqual({
      id: 'a b',
    });
  });

  it('gives priority to the longest prefix', () => {
    const r2 = EntityRoutes.build({
      education: '/api/education',
      tag_entity: '/api/education/tags',
    });
    expect(r2.resolve('GET', '/api/education/tags')?.table).toBe('tag_entity');
    expect(r2.resolve('GET', '/api/education/blogs')?.table).toBe('education');
  });
});

describe('rule 2: by placement', () => {
  const r = EntityRoutes.build({
    tag_entity: [
      'GET    /api/education/tags',
      'POST   /api/education/tags',
      'PUT    /api/education/tags/{id}',
      'DELETE /api/education/tags/{id}',
    ],
  });

  it('recognizes a declared request', () => {
    expect(r.resolve('POST', '/api/education/tags')).toEqual({
      table: 'tag_entity',
      pathParams: {},
      rule: 2,
    });
  });

  it('returns holes under their declared name', () => {
    const rr = EntityRoutes.build({
      comment: ['GET /api/blogs/{blogId}/comments/{id}'],
    });
    expect(rr.resolve('GET', '/api/blogs/b-1/comments/c-2')?.pathParams).toEqual({
      blogId: 'b-1',
      id: 'c-2',
    });
  });

  it('does not recognize an undeclared method on a declared path', () => {
    // Nothing covered by a prefix here: what isn't written doesn't exist.
    expect(r.resolve('PATCH', '/api/education/tags/t-1')).toBeUndefined();
  });

  it('can never compete with rule 1', () => {
    // The two rules are never arbitrated at runtime: the case is refused at
    // startup instead. Safer than a priority, which would require remembering
    // which one wins.
    expect(() =>
      EntityRoutes.build({
        education: '/api/education',
        tag_entity: ['GET /api/education/tags'],
      }),
    ).toThrow(/covers/);
  });
});

describe('what the declaration refuses', () => {
  it('refuses two tables on the same prefix', () => {
    expect(() =>
      EntityRoutes.build({ a: '/api/x', b: '/api/x' }),
    ).toThrow(EntityRoutesError);
  });

  it('refuses two tables on the same request', () => {
    expect(() =>
      EntityRoutes.build({
        a: ['POST /api/x'],
        b: ['POST /api/x'],
      }),
    ).toThrow(/twice/);
  });

  it('refuses a prefix that swallows another table\'s path', () => {
    // The /api/education/{kind} trap: too wide a prefix silently takes
    // courses, blogs and podcasts.
    expect(() =>
      EntityRoutes.build({
        education: '/api/education',
        course_entity: ['GET /api/education/courses'],
      }),
    ).toThrow(/covers/);
  });

  it('refuses a prefix that does not start with /', () => {
    expect(() => EntityRoutes.build({ a: 'api/x' })).toThrow(/doesn't start with/);
  });

  it('refuses the "/" prefix: it would cover the whole application', () => {
    expect(() => EntityRoutes.build({ a: '/' })).toThrow(/whole/);
  });

  it('refuses a line that is not "METHOD /path"', () => {
    expect(() => EntityRoutes.build({ a: ['/api/x'] })).toThrow(/isn't a request/);
  });

  it('refuses a method with no SQL equivalent', () => {
    expect(() => EntityRoutes.build({ a: ['OPTIONS /api/x'] })).toThrow(
      /composable HTTP method/,
    );
  });
});

describe('what the declaration can say about itself', () => {
  it('lists its tables, so check can compare them against the schema', () => {
    const r = EntityRoutes.build({
      tag_entity: '/api/education/tags',
      category_entity: ['GET /api/education/categories'],
    });
    expect(r.tables()).toEqual(['category_entity', 'tag_entity']);
  });
});

describe('declared paths, for the Service Worker', () => {
  it('returns prefixes and ranked requests, each under its own kind', () => {
    const r = EntityRoutes.build({
      tag_entity: '/api/education/tags',
      category_entity: [
        'GET /api/education/categories',
        'PUT /api/education/categories/{id}',
      ],
    });
    expect(r.paths()).toEqual([
      { kind: 'prefix', path: '/api/education/tags' },
      { kind: 'path', path: '/api/education/categories' },
      { kind: 'path', path: '/api/education/categories/{id}' },
    ]);
  });

  it('returns a path declared under several methods only once', () => {
    const r = EntityRoutes.build({
      category_entity: [
        'GET /api/education/categories',
        'POST /api/education/categories',
      ],
    });
    expect(r.paths()).toEqual([
      { kind: 'path', path: '/api/education/categories' },
    ]);
  });

  // What the Service Worker must ignore, it ignores by what this list says --
  // not by what it guesses from the path.
  it('returns an empty list when nothing is declared', () => {
    expect(EntityRoutes.build({}).paths()).toEqual([]);
  });
});
