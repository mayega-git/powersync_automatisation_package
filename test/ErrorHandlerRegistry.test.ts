import { describe, expect, it, vi } from 'vitest';

import { ClassifiedError } from '../src/core/ClassifiedError.js';
import {
  ErrorHandlerRegistrationError,
  ErrorHandlerRegistry,
  type ErrorContext,
  type ErrorHandler,
} from '../src/core/ErrorHandlerRegistry.js';
import { SilentLogger } from '../src/core/Logger.js';

function ctx(over: Partial<ErrorContext> = {}): ErrorContext {
  return {
    operationId: 'createBlog',
    entryId: 'crud-1',
    payload: '{"title":"a"}',
    error: new ClassifiedError('reject', 'missing title'),
    ...over,
  };
}

function build() {
  const logger = new SilentLogger();
  return { logger, registry: new ErrorHandlerRegistry({ logger }) };
}

describe('ErrorHandlerRegistry', () => {
  it('stores a handler and returns it under its name', () => {
    const { registry } = build();
    const handler: ErrorHandler = async () => undefined;
    registry.register('createBlog', handler);

    expect(registry.get('createBlog')).toBe(handler);
  });

  it('refuses two handlers under the same name', () => {
    const { registry } = build();
    registry.register('createBlog', async () => undefined);

    expect(() =>
      registry.register('createBlog', async () => undefined),
    ).toThrow(ErrorHandlerRegistrationError);
  });

  it('registers a whole handlers file at once', () => {
    const { registry } = build();
    registry.registerAll({
      createBlog: async () => undefined,
      addComment: async () => undefined,
    });

    expect(registry.names().sort()).toEqual(['addComment', 'createBlog']);
    expect(registry.size).toBe(2);
  });

  it('returns undefined for an unknown name via get()', () => {
    expect(build().registry.get('missing')).toBeUndefined();
  });

  it('always returns something via getHandler(), even without a declared handler', () => {
    // The caller is in the middle of a failure: returning undefined would
    // force it to decide what to do at the worst possible moment.
    expect(typeof build().registry.getHandler('missing')).toBe('function');
  });

  it('calls the declared handler, with the failure context', async () => {
    const { registry } = build();
    const handler = vi.fn(async () => undefined);
    registry.register('createBlog', handler);

    const c = ctx();
    await registry.apply(c);

    expect(handler).toHaveBeenCalledWith(c);
  });

  it('logs a warning when nothing was declared', async () => {
    const { logger, registry } = build();
    const warn = vi.spyOn(logger, 'warn');

    await registry.apply(ctx({ operationId: 'never-declared' }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      operationId: 'never-declared',
    });
  });

  it('does not just swallow the handler error: it logs it', async () => {
    const { logger, registry } = build();
    const error = vi.spyOn(logger, 'error');
    registry.register('createBlog', async () => {
      throw new Error('screen already closed');
    });

    await registry.apply(ctx());

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ reason: 'screen already closed' });
  });

  it('NEVER lets what the handler throws escape', async () => {
    // The critical point: apply() runs in the middle of a deferred upload,
    // where a rethrown exception means "retry". A bug in the developer's
    // error handler would replay a rejected write forever, and block the
    // whole queue behind it.
    const { registry } = build();
    registry.register('createBlog', async () => {
      throw new Error('typo');
    });

    await expect(registry.apply(ctx())).resolves.toBeUndefined();
  });

  it('also does not let a rejected non-Error value escape', async () => {
    const { registry } = build();
    registry.register('createBlog', async () => {
      throw 'plain text';
    });

    await expect(registry.apply(ctx())).resolves.toBeUndefined();
  });

  it('writes nothing to the dead-letter store', async () => {
    // Deliberate: that write is made by the caller for EVERY rejection.
    // Making it depend on the handler would lose the trace for any
    // application that declares one and forgets to record.
    const { registry } = build();
    expect(Object.keys(registry)).not.toContain('deadLetters');
  });
});
