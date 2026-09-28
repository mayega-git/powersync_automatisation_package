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
