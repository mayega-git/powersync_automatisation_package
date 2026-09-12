import { describe, expect, it } from 'vitest';

import { Converter } from '../src/core/Converter.js';
import type { OperationMapping } from '../src/core/OperationMapping.js';

function op(id: string, method: string, path: string): OperationMapping {
  return {
    operationId: id,
    method,
    path,
    serverPath: path,
    connectivity: 'offline',
    handle: id,
  };
}

const converter = Converter.fromOfflineMap({
  operations: [
    op('listBlogs', 'GET', '/api/v1/blogs'),
    op('readBlog', 'GET', '/api/v1/blogs/{id}'),
    op('addComment', 'POST', '/api/v1/blogs/{blogId}/comments'),
  ],
});

describe('Converter.resolve', () => {
  it('finds the operation and the path values', () => {
    const r = converter.resolve({ method: 'GET', url: '/api/v1/blogs/42' });

    expect(r?.operation.operationId).toBe('readBlog');
    expect(r?.pathParams).toEqual({ id: '42' });
  });

  it('accepts an absolute URL just like a relative one', () => {
    const abs = converter.resolve({
      method: 'GET',
      url: 'https://kernel-core.yowyob.com/api/v1/blogs/42?page=2',
    });
    expect(abs?.operation.operationId).toBe('readBlog');
  });

  it('ignores the query string to identify the operation', () => {
    const r = converter.resolve({ method: 'GET', url: '/api/v1/blogs?page=2' });
    expect(r?.operation.operationId).toBe('listBlogs');
  });

  it('decodes the encoded characters of an identifier', () => {
    const r = converter.resolve({ method: 'GET', url: '/api/v1/blogs/a%20b' });
    expect(r?.pathParams).toEqual({ id: 'a b' });
  });

  it('returns undefined for a request the module has nothing to do with', () => {
    expect(converter.resolve({ method: 'GET', url: '/something/else' })).toBeUndefined();
  });

  it('returns undefined for a method not declared on this path', () => {
    expect(
      converter.resolve({ method: 'DELETE', url: '/api/v1/blogs/42' }),
    ).toBeUndefined();
  });
});

describe('Converter.extractParams', () => {
  const req = {
    method: 'POST',
    url: '/api/v1/blogs/7/comments?draft=true',
    body: { text: 'hello', pinned: false },
  };
  const resolved = converter.resolve(req)!;

  it('merges path, query string and body into one object', () => {
    expect(converter.extractParams(req, resolved.pathParams)).toEqual({
      blogId: '7',
      draft: 'true',
      text: 'hello',
      pinned: false,
    });
  });

  it('lets the path win over the body on a shared name', () => {
    // Otherwise a malicious body could modify a resource other than the one
    // the URL designates.
    const r = {
      method: 'POST',
      url: '/api/v1/blogs/7/comments',
      body: { blogId: '999', text: 'x' },
    };
    const out = converter.extractParams(r, converter.resolve(r)!.pathParams);
    expect(out.blogId).toBe('7');
  });

  it('lets the path win over the query string', () => {
    const r = { method: 'POST', url: '/api/v1/blogs/7/comments?blogId=999' };
    const out = converter.extractParams(r, converter.resolve(r)!.pathParams);
    expect(out.blogId).toBe('7');
  });

  it('keeps the first value of a repeated query string key', () => {
    const r = { method: 'GET', url: '/api/v1/blogs?tag=a&tag=b' };
    expect(converter.extractParams(r, {}).tag).toBe('a');
  });

  it('ignores body values that cannot be bound to a SQL query', () => {
    const r = {
      method: 'POST',
      url: '/api/v1/blogs/7/comments',
      body: { text: 'ok', tags: ['a'], author: { id: 1 } },
    };
    const out = converter.extractParams(r, {});
    expect(out).toEqual({ text: 'ok' });
  });

  it('accepts a missing body, a null body, or a body that is not an object', () => {
    const base = { method: 'GET', url: '/api/v1/blogs' };
    expect(converter.extractParams(base, {})).toEqual({});
    expect(converter.extractParams({ ...base, body: null }, {})).toEqual({});
    expect(converter.extractParams({ ...base, body: 'text' }, {})).toEqual({});
    expect(converter.extractParams({ ...base, body: [1, 2] }, {})).toEqual({});
  });

  it('keeps null as a body value', () => {
    const r = { method: 'GET', url: '/api/v1/blogs', body: { note: null } };
    expect(converter.extractParams(r, {})).toEqual({ note: null });
  });
});
