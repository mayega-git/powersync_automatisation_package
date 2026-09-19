import { describe, expect, it } from 'vitest';

import type { ActivityEvent } from '../../src/core/ActivityLog.js';
import { renderActivityFeed } from '../../src/ui/Activity.js';

function event(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    type: 'request-handled',
    at: '2026-01-01T00:00:00.000Z',
    detail: { table: 'product', method: 'GET' },
    ...over,
  };
}

describe('renderActivityFeed', () => {
  it('renders a message when there is nothing to show', () => {
    const html = renderActivityFeed([]);
    expect(html).toContain('No activity yet.');
    expect(html).not.toContain('<ul>');
  });

  it('renders one item per event, type and detail included', () => {
    const html = renderActivityFeed([event()]);
    expect(html).toContain('request-handled');
    expect(html).toContain('table=product');
    expect(html).toContain('method=GET');
    expect(html).toContain('2026-01-01T00:00:00.000Z');
  });

  it('renders the most recent event first', () => {
    const html = renderActivityFeed([
      event({ type: 'request-handled', detail: { n: 1 } }),
      event({ type: 'request-failed', detail: { n: 2 } }),
    ]);
    const first = html.indexOf('request-failed');
    const second = html.indexOf('request-handled');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it('escapes text pulled from event detail so it cannot inject markup', () => {
    const html = renderActivityFeed([
      event({ detail: { reason: '<script>alert(1)</script>' } }),
    ]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
