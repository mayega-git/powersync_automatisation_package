import { describe, expect, it, vi } from 'vitest';

import {
  RELOAD_FLAG,
  reloadOnce,
} from '../../src/pwa/Startup.js';

/** A sessionStorage reduced to its two useful methods. */
function session(start: Record<string, string> = {}) {
  const content = { ...start };
  return {
    getItem: (k: string) => content[k] ?? null,
    setItem: (k: string, v: string) => {
      content[k] = v;
    },
    content,
  };
}

describe('one-time reload after taking control', () => {
  it('reloads once when the Service Worker just took over', async () => {
    const reload = vi.fn();
    const s = session();

    await reloadOnce({
      controlled: Promise.resolve(),
      session: s,
      reload,
      alreadyControlled: false,
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(s.content[RELOAD_FLAG]).toBe('1');
  });

  it('does not reload when a Service Worker already controlled the page', async () => {
    // Nothing to catch up on: every request from this page already went through it.
    const reload = vi.fn();
    await reloadOnce({
      controlled: Promise.resolve(),
      session: session(),
      reload,
      alreadyControlled: true,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads twice: that is the loop to avoid', async () => {
    const reload = vi.fn();
    const s = session({ [RELOAD_FLAG]: '1' });
    await reloadOnce({
      controlled: Promise.resolve(),
      session: s,
      reload,
      alreadyControlled: false,
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('re-reads the flag AFTER waiting, in case another tab set it', async () => {
    const reload = vi.fn();
    const s = session();
    let release: () => void = () => {};
    const controlled = new Promise<void>((f) => {
      release = f;
    });

    const promise = reloadOnce({
      controlled,
      session: s,
      reload,
      alreadyControlled: false,
    });

    s.setItem(RELOAD_FLAG, '1');
    release();
    await promise;

    expect(reload).not.toHaveBeenCalled();
  });
});
