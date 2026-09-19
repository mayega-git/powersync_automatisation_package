import { describe, expect, it, vi } from 'vitest';

import { registerServiceWorker, warnIfNeverControlled } from '../../src/pwa/Register.js';

describe('registerServiceWorker', () => {
  it('defaults scope to "/" so the worker can control the whole app', async () => {
    const register = vi.fn().mockResolvedValue({ scope: 'http://localhost/', active: null, installing: null, waiting: null });
    await registerServiceWorker('/serwist/sw.js', {
      navigator: { serviceWorker: { controller: null, register } },
    });

    expect(register).toHaveBeenCalledWith('/serwist/sw.js', { scope: '/' });
  });

  it('honors an explicit narrower scope when the caller really wants one', async () => {
    const register = vi.fn().mockResolvedValue({ scope: 'http://localhost/admin/', active: null, installing: null, waiting: null });
    await registerServiceWorker('/admin/sw.js', {
      scope: '/admin/',
      navigator: { serviceWorker: { controller: null, register } },
    });

    expect(register).toHaveBeenCalledWith('/admin/sw.js', { scope: '/admin/' });
  });

  it('logs and returns undefined when navigator.serviceWorker is unavailable', async () => {
    const error = vi.fn();
    const result = await registerServiceWorker('/serwist/sw.js', {
      navigator: {},
      logger: { error },
    });

    expect(result).toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('logs and returns undefined when register() rejects', async () => {
    const error = vi.fn();
    const register = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await registerServiceWorker('/serwist/sw.js', {
      navigator: { serviceWorker: { controller: null, register } },
      logger: { error },
    });

    expect(result).toBeUndefined();
    expect(error).toHaveBeenCalledWith('registerServiceWorker: registration failed', expect.any(Error));
  });
});

describe('warnIfNeverControlled', () => {
  it('warns once the timeout passes if no controller ever appeared', () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    warnIfNeverControlled({
      navigator: { serviceWorker: { controller: null } },
      timeoutMs: 1000,
      logger: { warn },
    });

    vi.advanceTimersByTime(999);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('stays silent when a controller is already present at the deadline', () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    warnIfNeverControlled({
      navigator: { serviceWorker: { controller: {} } },
      timeoutMs: 1000,
      logger: { warn },
    });

    vi.advanceTimersByTime(1000);
    expect(warn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('the returned cleanup cancels the pending check', () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const stop = warnIfNeverControlled({
      navigator: { serviceWorker: { controller: null } },
      timeoutMs: 1000,
      logger: { warn },
    });

    stop();
    vi.advanceTimersByTime(1000);
    expect(warn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
