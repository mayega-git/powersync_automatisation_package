import { describe, expect, it } from 'vitest';

import type { DeadLetterEntry } from '../../src/core/DeadLetterStore.js';
import { renderPendingIssuesList } from '../../src/ui/PendingIssues.js';

function entry(over: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    id: '7',
    operationId: 'createBlog',
    payload: '{"title":"a"}',
    code: 422,
    reason: 'The server returned 422.',
    createdAt: Date.UTC(2026, 0, 1),
    ...over,
  };
}

describe('renderPendingIssuesList', () => {
  it('renders a message when there is nothing to show', () => {
    const html = renderPendingIssuesList([]);

    expect(html).toContain('No rejected write.');
    expect(html).not.toContain('<ul>');
  });

  it('renders one item per entry, most fields included', () => {
    const html = renderPendingIssuesList([entry()]);

    expect(html).toContain('createBlog');
    expect(html).toContain('422');
    expect(html).toContain('The server returned 422.');
    expect(html).toContain('2026-01-01T00:00:00.000Z');
  });

  it('renders every entry it is given, in order', () => {
    const html = renderPendingIssuesList([
      entry({ id: '1', operationId: 'createBlog' }),
      entry({ id: '2', operationId: 'updateProfile' }),
    ]);

    const first = html.indexOf('createBlog');
    const second = html.indexOf('updateProfile');

    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
  });

  it('escapes text pulled from the server so it cannot inject markup', () => {
    const html = renderPendingIssuesList([
      entry({ reason: '<script>alert(1)</script>' }),
    ]);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
