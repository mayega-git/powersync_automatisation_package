/**
 * An in-memory, bounded trail of what the module just did: a request handled
 * locally or forwarded to the network, a request that failed, a local write
 * queued for replay, a definitive rejection, a session that needs a fresh
 * login. Nothing here is persisted -- it exists so a UI (or a developer
 * console) can show what's happening right now, not as an audit log.
 *
 * Constructed once by the application (same pattern as `DeadLetterStore` and
 * `ErrorHandlerRegistry`) and handed to both `OfflineSyncConnector` and
 * `OfflineSync.create()` when the application wants one shared trail across
 * both. Neither requires it: an `OfflineSync` instance always has *an*
 * `ActivityLog` (it creates its own if none is given), so `activity()` and
 * `onActivity()` never throw.
 */

export type ActivityEventType =
  | 'request-handled'
  | 'request-failed'
  | 'local-write'
  | 'dead-letter'
  | 'reauth-required';

export interface ActivityEvent {
  type: ActivityEventType;
  /** ISO timestamp, set at record time. */
  at: string;
  detail: Readonly<Record<string, unknown>>;
}

export interface ActivityLogOptions {
  /** How many recent events to keep. Oldest drops first. Default 200. */
  maxEntries?: number;
  now?: () => string;
}

export class ActivityLog {
  private readonly maxEntries: number;
  private readonly now: () => string;
  private readonly entries: ActivityEvent[] = [];
  private readonly listeners = new Set<(event: ActivityEvent) => void>();

  constructor(options: ActivityLogOptions = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  record(type: ActivityEventType, detail: Readonly<Record<string, unknown>> = {}): void {
    const event: ActivityEvent = { type, at: this.now(), detail };
    this.entries.push(event);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    for (const listener of this.listeners) listener(event);
  }

  /** Most recent last. */
  list(): readonly ActivityEvent[] {
    return [...this.entries];
  }

  /** Called on every new event, from the moment of subscription onward. */
  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
