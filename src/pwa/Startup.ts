import type { HttpRequest } from '../core/HttpRequest.js';
import { REPLAY_HEADER } from '../core/OfflineSyncConnector.js';

/** Guards against a reload loop. */
export const RELOAD_FLAG = 'offline-sync:reload';

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ReloadOptions {
  /** Resolves once the Service Worker controls the page. */
  controlled: Promise<unknown>;
  /** `window.sessionStorage`. */
  session: SessionStorageLike;
  /** `() => window.location.reload()`. */
  reload: () => void;
  /** True when a Service Worker already controlled the page on open. */
  alreadyControlled: boolean;
  logger?: { info: (msg: string, ctx?: unknown) => void };
}

/** Reloads the page once the Service Worker takes over, and only once. */
export async function reloadOnce(options: ReloadOptions): Promise<void> {
  if (options.alreadyControlled) return;
  if (options.session.getItem(RELOAD_FLAG) === '1') return;

  await options.controlled;

  if (options.session.getItem(RELOAD_FLAG) === '1') return;
  options.session.setItem(RELOAD_FLAG, '1');

  options.logger?.info(
    'the Service Worker controls the page: reloading once so everything goes through it',
  );
  options.reload();
}

interface FetchHolder {
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
}

export interface PatchFetchOptions {
  /** `globalThis` in a page. */
  holder: FetchHolder;
  handles: (req: HttpRequest) => boolean;
  respond: (req: HttpRequest) => Promise<{ status: string; entity: unknown }>;
  buildResponse: (body: string, init: { status: number; headers: Record<string, string> }) => unknown;
  readRequest: (input: unknown, init: unknown) => Promise<HttpRequest | undefined>;
  logger?: { error: (msg: string, ctx?: unknown) => void };
}

/**
 * Replaces `fetch` to catch what leaves the page. Returns a function that
 * restores the original. Use only when there is no Service Worker.
 */
export function patchFetch(options: PatchFetchOptions): () => void {
  const original = options.holder.fetch;
  const callOriginal = (input: unknown, init?: unknown): Promise<unknown> =>
    original.call(options.holder, input, init);

  options.holder.fetch = async (input: unknown, init?: unknown): Promise<unknown> => {
    let req: HttpRequest | undefined;
    try {
      req = await options.readRequest(input, init);
    } catch (cause) {
      options.logger?.error('fetch: unreadable request, letting it through', cause);
      return callOriginal(input, init);
    }

    if (req === undefined) {
      return callOriginal(input, init);
    }

    if (req.headers?.[REPLAY_HEADER] !== undefined) {
      return callOriginal(input, init);
    }

    if (!options.handles(req)) {
      return callOriginal(input, init);
    }

    try {
      const response = await options.respond(req);
      return options.buildResponse(JSON.stringify(response.entity ?? null), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Offline-Sync': 'local-database' },
      });
    } catch (cause) {
      options.logger?.error('fetch: the local database did not answer', cause);
      return callOriginal(input, init);
    }
  };

  return () => {
    options.holder.fetch = original;
  };
}
