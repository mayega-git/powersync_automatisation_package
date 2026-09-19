import { describe, expect, it, vi } from 'vitest';

import { ActivityLog } from '../../src/core/ActivityLog.js';

describe('ActivityLog', () => {
  it('starts empty', () => {
    expect(new ActivityLog().list()).toEqual([]);
  });

  it('records an event with its type and detail', () => {
    const log = new ActivityLog({ now: () => '2026-01-01T00:00:00.000Z' });
    log.record('request-handled', { table: 'product', method: 'GET' });

    expect(log.list()).toEqual([
      { type: 'request-handled', at: '2026-01-01T00:00:00.000Z', detail: { table: 'product', method: 'GET' } },
    ]);
  });

  it('defaults detail to an empty object', () => {
    const log = new ActivityLog();
    log.record('reauth-required');
    expect(log.list()[0]!.detail).toEqual({});
  });

  it('keeps events in the order recorded (oldest first)', () => {
    const log = new ActivityLog();
    log.record('request-handled', { n: 1 });
    log.record('request-failed', { n: 2 });
    expect(log.list().map((e) => e.detail['n'])).toEqual([1, 2]);
  });

  it('drops the oldest event once past the configured bound', () => {
    const log = new ActivityLog({ maxEntries: 2 });
    log.record('request-handled', { n: 1 });
    log.record('request-handled', { n: 2 });
    log.record('request-handled', { n: 3 });
    expect(log.list().map((e) => e.detail['n'])).toEqual([2, 3]);
  });

  it('defaults the bound to 200', () => {
    const log = new ActivityLog();
    for (let i = 0; i < 250; i += 1) log.record('request-handled', { n: i });
    expect(log.list()).toHaveLength(200);
    expect(log.list()[0]!.detail['n']).toBe(50);
  });

  it('notifies a subscriber of every new event', () => {
    const log = new ActivityLog();
    const listener = vi.fn();
    log.subscribe(listener);

    log.record('local-write', { table: 'product' });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({ type: 'local-write' });
  });

  it('does not notify a subscriber for events recorded before it subscribed', () => {
    const log = new ActivityLog();
    log.record('request-handled', {});
    const listener = vi.fn();
    log.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('the returned unsubscribe function stops further notifications', () => {
    const log = new ActivityLog();
    const listener = vi.fn();
    const stop = log.subscribe(listener);
    stop();
    log.record('request-handled', {});
    expect(listener).not.toHaveBeenCalled();
  });

  it('list() returns a snapshot: later mutation does not change it', () => {
    const log = new ActivityLog();
    log.record('request-handled', {});
    const snapshot = log.list();
    log.record('request-failed', {});
    expect(snapshot).toHaveLength(1);
  });
});
