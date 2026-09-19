import type { ActivityEvent } from '../core/ActivityLog.js';

/**
 * Structural port: anything shaped this way can feed the element. In
 * practice this is an `OfflineSync` instance, but the element never imports
 * that class -- same reasoning as `PendingIssuesSource`.
 */
export interface ActivitySource {
  activity(): readonly ActivityEvent[];
  onActivity(listener: (event: ActivityEvent) => void): () => void;
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
    max-height: 20rem;
    overflow-y: auto;
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
  .type {
    font-weight: 600;
    text-transform: uppercase;
    font-size: 0.75rem;
    letter-spacing: 0.02em;
  }
  .type-request-failed, .type-dead-letter, .type-reauth-required {
    color: #b91c1c;
  }
  .type-request-handled {
    color: #1f6f43;
  }
  .type-local-write {
    color: #2563eb;
  }
  time {
    color: #7b8794;
  }
  .detail {
    flex: 1 1 100%;
    color: #52606d;
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
    white-space: pre-wrap;
    word-break: break-all;
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

function formatDetail(detail: Readonly<Record<string, unknown>>): string {
  const parts = Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(' ');
}

/**
 * Pure rendering: no DOM involved, so this function is testable under plain
 * Node. Most recent event first -- a live feed reads top to bottom.
 */
export function renderActivityFeed(events: readonly ActivityEvent[]): string {
  if (events.length === 0) {
    return '<p class="empty">No activity yet.</p>';
  }

  const items = [...events]
    .reverse()
    .map((event) => {
      const when = new Date(event.at);
      return `
        <li>
          <span class="type type-${event.type}">${escapeHtml(event.type)}</span>
          <time datetime="${when.toISOString()}">${escapeHtml(when.toLocaleString())}</time>
          <span class="detail">${escapeHtml(formatDetail(event.detail))}</span>
        </li>`;
    })
    .join('');

  return `<ul>${items}</ul>`;
}

export const ELEMENT_NAME = 'offline-sync-activity';

/**
 * Built lazily so that importing this module never touches `HTMLElement`: a
 * host that loads "@ksm/offline-sync/ui" outside a browser (a Node test, a
 * server component) does not crash just by importing it.
 */
function buildElementClass(): CustomElementConstructor {
  return class extends HTMLElement {
    private source: ActivitySource | undefined;
    private events: readonly ActivityEvent[] = [];
    private unsubscribe: (() => void) | undefined;
    private readonly root: ShadowRoot;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: 'open' });
    }

    /**
     * Wire this once, right after `OfflineSync.create(...)`. Display only:
     * this element takes no action, it only shows what the module just did.
     * Updates live (subscribes to `onActivity`); no polling, no manual
     * `refresh()` needed.
     */
    set sync(source: ActivitySource) {
      this.unsubscribe?.();
      this.source = source;
      this.events = source.activity();
      this.paint();
      this.unsubscribe = source.onActivity((event) => {
        this.events = [...this.events, event];
        this.paint();
      });
    }

    connectedCallback(): void {
      this.paint();
    }

    disconnectedCallback(): void {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }

    private paint(): void {
      this.root.innerHTML = `<style>${STYLE}</style>${renderActivityFeed(this.events)}`;
    }
  };
}

let elementClass: CustomElementConstructor | undefined;

/**
 * Registers `<offline-sync-activity>`. Call once, in the browser, before the
 * tag is used anywhere in the page. A second call is a no-op, so it is safe
 * to call again under hot reload.
 */
export function registerActivityElement(
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
