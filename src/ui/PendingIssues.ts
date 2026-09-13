import type { DeadLetterEntry } from '../core/DeadLetterStore.js';

/**
 * Structural port: anything shaped this way can feed the element. In
 * practice this is an `OfflineSync` instance, but the element never imports
 * that class -- same reasoning as the connector ports in `src/core`.
 */
export interface PendingIssuesSource {
  pendingIssues(): Promise<readonly DeadLetterEntry[]>;
}

const STYLE = `
  :host {
    display: block;
    font-family: system-ui, sans-serif;
    font-size: 0.875rem;
    color: #1f2933;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.5rem 0;
    border-bottom: 1px solid #e4e7eb;
  }
  li:last-child {
    border-bottom: none;
  }
  .operation {
    font-weight: 600;
  }
  .code {
    color: #b91c1c;
  }
  time {
    color: #7b8794;
  }
  .reason {
    flex: 1 1 100%;
    color: #52606d;
  }
  .empty {
    color: #52606d;
    font-style: italic;
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pure rendering: no DOM involved, so this function is testable under plain
 * Node. The element below only wires the returned string into a shadow
 * root -- it adds no logic of its own worth testing separately.
 */
export function renderPendingIssuesList(entries: readonly DeadLetterEntry[]): string {
  if (entries.length === 0) {
    return '<p class="empty">No rejected write.</p>';
  }

  const items = entries
    .map((entry) => {
      const when = new Date(entry.createdAt);
      return `
        <li>
          <span class="operation">${escapeHtml(entry.operationId)}</span>
          <span class="code">${entry.code}</span>
          <time datetime="${when.toISOString()}">${escapeHtml(when.toLocaleString())}</time>
          <span class="reason">${escapeHtml(entry.reason)}</span>
        </li>`;
    })
    .join('');

  return `<ul>${items}</ul>`;
}

export const ELEMENT_NAME = 'offline-sync-issues';

/**
 * Built lazily so that importing this module never touches `HTMLElement`: a
 * host that loads "@ksm/offline-sync/ui" outside a browser (a Node test, a
 * server component) does not crash just by importing it.
 */
function buildElementClass(): CustomElementConstructor {
  return class extends HTMLElement {
    private source: PendingIssuesSource | undefined;
    private entries: readonly DeadLetterEntry[] = [];
    private readonly root: ShadowRoot;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
    }

    /**
     * Wire this once, right after `OfflineSync.create(...)`. Display only:
     * this element never resolves or deletes an entry, it only shows what
     * the dead-letter store holds.
     */
    set sync(source: PendingIssuesSource) {
      this.source = source;
      void this.refresh();
    }

    connectedCallback(): void {
      this.paint();
    }

    /**
     * Re-reads the dead-letter store and repaints. Call it from the
     * module's own `onDeadLetter` callback so the list stays current
     * without polling.
     */
    async refresh(): Promise<void> {
      if (this.source === undefined) return;
      this.entries = await this.source.pendingIssues();
      this.paint();
    }

    private paint(): void {
      this.root.innerHTML = `<style>${STYLE}</style>${renderPendingIssuesList(this.entries)}`;
    }
  };
}

let elementClass: CustomElementConstructor | undefined;

/**
 * Registers `<offline-sync-issues>`. Call once, in the browser, before the
 * tag is used anywhere in the page. A second call is a no-op, so it is safe
 * to call again under hot reload.
 */
export function registerPendingIssuesElement(
  registry: CustomElementRegistry = globalThis.customElements,
): void {
  if (typeof HTMLElement === 'undefined') {
    throw new Error(
      '"@ksm/offline-sync/ui" needs a browser: HTMLElement is not defined ' +
        'in this environment.',
    );
  }
  if (registry.get(ELEMENT_NAME) !== undefined) return;
  elementClass ??= buildElementClass();
  registry.define(ELEMENT_NAME, elementClass);
}
