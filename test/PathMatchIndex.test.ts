import { describe, expect, it } from 'vitest';

import type { OperationMapping } from '../src/core/OperationMapping.js';
import { PathMatchIndex, splitPath } from '../src/core/PathMatchIndex.js';

function op(
  operationId: string,
  method: string,
  path: string,
): OperationMapping {
  return {
    operationId,
    method,
    path,
    serverPath: path,
    connectivity: 'offline',
    handle: operationId,
  };
}

const m = (index: PathMatchIndex, method: string, path: string) =>
  index.match(method, splitPath(path));

describe('PathMatchIndex', () => {
  it('finds an entirely fixed path', () => {
    const index = PathMatchIndex.build([op('list', 'GET', '/api/v1/blogs')]);
    const r = m(index, 'GET', '/api/v1/blogs');

    expect(r.status).toBe('Matched');
    expect(r.operation?.operationId).toBe('list');
    expect(r.pathParams).toEqual({});
  });

  it('captures the value taken by a named hole', () => {
    const index = PathMatchIndex.build([op('read', 'GET', '/api/v1/blogs/{id}')]);
    const r = m(index, 'GET', '/api/v1/blogs/42');

    expect(r.status).toBe('Matched');
    expect(r.pathParams).toEqual({ id: '42' });
  });

  it('captures several holes in the same path', () => {
    const index = PathMatchIndex.build([
      op('comment', 'GET', '/blogs/{blogId}/comments/{commentId}'),
    ]);
    const r = m(index, 'GET', '/blogs/7/comments/9');

    expect(r.pathParams).toEqual({ blogId: '7', commentId: '9' });
  });

  it('separates operations by HTTP method', () => {
    const index = PathMatchIndex.build([
      op('read', 'GET', '/blogs/{id}'),
      op('remove', 'DELETE', '/blogs/{id}'),
    ]);

    expect(m(index, 'GET', '/blogs/1').operation?.operationId).toBe('read');
    expect(m(index, 'DELETE', '/blogs/1').operation?.operationId).toBe('remove');
    expect(m(index, 'POST', '/blogs/1').status).toBe('NotFound');
  });

  it('ignores the method case', () => {
    const index = PathMatchIndex.build([op('read', 'get', '/blogs/{id}')]);
    expect(m(index, 'GET', '/blogs/1').status).toBe('Matched');
  });

  it('lets the fixed segment win over the variable one', () => {
    // The classic trap: /blogs/latest must not be read as an id of "latest".
    const index = PathMatchIndex.build([
      op('latest', 'GET', '/blogs/latest'),
      op('read', 'GET', '/blogs/{id}'),
    ]);

    expect(m(index, 'GET', '/blogs/latest').operation?.operationId).toBe('latest');
    expect(m(index, 'GET', '/blogs/42').operation?.operationId).toBe('read');
  });

  it('falls back to the variable segment when the fixed path leads nowhere', () => {
    // Without this fallback, the "latest" branch would be taken and then
    // abandoned, and the request would fail even though /blogs/{id}/comments exists.
    const index = PathMatchIndex.build([
      op('latest', 'GET', '/blogs/latest'),
      op('comments', 'GET', '/blogs/{id}/comments'),
    ]);
    const r = m(index, 'GET', '/blogs/latest/comments');

    expect(r.status).toBe('Matched');
    expect(r.operation?.operationId).toBe('comments');
    expect(r.pathParams).toEqual({ id: 'latest' });
  });

  it('shares the same branch when two operations name the hole differently', () => {
    // It's the POSITION that matters, not the name: each operation still
    // gets the name it declared.
    const index = PathMatchIndex.build([
      op('read', 'GET', '/blogs/{id}'),
      op('stats', 'GET', '/blogs/{blogId}/stats'),
    ]);

    expect(m(index, 'GET', '/blogs/5').pathParams).toEqual({ id: '5' });
    expect(m(index, 'GET', '/blogs/5/stats').pathParams).toEqual({ blogId: '5' });
  });

  it('finds nothing for a path longer than what is declared', () => {
    const index = PathMatchIndex.build([op('read', 'GET', '/blogs/{id}')]);
    expect(m(index, 'GET', '/blogs/1/comments').status).toBe('NotFound');
  });

  it('finds nothing for a shorter path', () => {
    const index = PathMatchIndex.build([op('read', 'GET', '/blogs/{id}')]);
    expect(m(index, 'GET', '/blogs').status).toBe('NotFound');
  });

  it('reports ambiguity rather than choosing, when the map declares the same thing twice', () => {
    const index = PathMatchIndex.build([
      op('a', 'GET', '/blogs/{id}'),
      op('b', 'GET', '/blogs/{other}'),
    ]);
    const r = m(index, 'GET', '/blogs/1');

    expect(r.status).toBe('Ambiguous');
    expect(r.candidates).toHaveLength(2);
    expect(r.pathParams).toEqual({});
  });

  it('does not treat empty braces as a named hole', () => {
    const index = PathMatchIndex.build([op('weird', 'GET', '/blogs/{}')]);
    expect(m(index, 'GET', '/blogs/42').status).toBe('NotFound');
    expect(m(index, 'GET', '/blogs/{}').status).toBe('Matched');
  });

  it('tolerates extra, leading, trailing, or doubled slashes', () => {
    const index = PathMatchIndex.build([op('list', 'GET', 'api/blogs/')]);
    expect(m(index, 'GET', '/api//blogs/').status).toBe('Matched');
  });
});
