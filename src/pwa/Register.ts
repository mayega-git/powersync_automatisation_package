/**
 * Registering the Service Worker is the one step the module always left to the host
 * application (see the doc comment on `OfflineSyncProvider`) -- on purpose, since the
 * module hands out rules, not files, and different hosts build/serve the worker
 * differently. But a hand-rolled `navigator.serviceWorker.register(url)` call has a
 * well-documented, easy-to-miss footgun: the browser defaults `scope` to the *directory*
 * the script was served from, not to the whole origin. A worker served from
 * `/serwist/sw.js` with no explicit `scope` therefore only ever controls pages under
 * `/serwist/` -- it registers successfully, `navigator.serviceWorker.controller` stays
 * `null` on every real page, and the bridge this module wires up (`connectBridge`,
 * `bridgeServiceWorker`) is never reached. Offline then fails everywhere, silently:
 * no error, no rejected promise, just every request falling through to the network.
 *
 * `registerServiceWorker` exists so integrators get the correct default (`scope: '/'`)
 * without having to already know this browser detail.
 */

export interface ServiceWorkerRegistrationLike {
  scope: string;
  active: unknown;
  installing: unknown;
  waiting: unknown;
}

export interface ServiceWorkerContainerLike {
  controller: unknown;
  register(url: string, options?: { scope?: string }): Promise<ServiceWorkerRegistrationLike>;
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
}

export interface RegisterServiceWorkerOptions {
  /** `navigator` in a page. */
  navigator: { serviceWorker?: ServiceWorkerContainerLike };
  /**
   * Defaults to `'/'`. Pass a narrower scope only if the app genuinely wants the
   * worker to control just part of the origin -- that's rare, and the bridge this
   * module wires up won't be reached outside whatever scope is chosen.
   */
  scope?: string;
  logger?: {
    info?: (msg: string, ctx?: unknown) => void;
    error: (msg: string, ctx?: unknown) => void;
  };
}

/** Registers the Service Worker at `swUrl` with a safe default scope. */
export async function registerServiceWorker(
  swUrl: string,
  options: RegisterServiceWorkerOptions,
): Promise<ServiceWorkerRegistrationLike | undefined> {
  const container = options.navigator.serviceWorker;
  if (container === undefined) {
    options.logger?.error(
      'registerServiceWorker: navigator.serviceWorker is unavailable (insecure context, or unsupported browser)',
    );
    return undefined;
  }

  try {
    const scope = options.scope ?? '/';
    const registration = await container.register(swUrl, { scope });
    options.logger?.info?.('registerServiceWorker: registered', { scope: registration.scope });
    return registration;
  } catch (cause) {
    options.logger?.error('registerServiceWorker: registration failed', cause);
    return undefined;
  }
}

export interface WarnIfNeverControlledOptions {
  navigator: { serviceWorker?: { controller: unknown } };
  /** How long to wait before deciding the page will never be controlled. Default 5000ms. */
  timeoutMs?: number;
  logger?: { warn: (msg: string, ctx?: unknown) => void };
}

/**
 * Warns once, after a short delay, if the page still has no controlling Service Worker.
 * A registered-but-uncontrolling worker is the single most common reason the bridge this
 * module wires up never gets a chance to answer anything -- and it produces no exception
 * to catch, so without this check it fails silently. Call it once, right after wiring the
 * bridge (`connectBridge` already does this by default).
 */
export function warnIfNeverControlled(options: WarnIfNeverControlledOptions): () => void {
  const timeoutMs = options.timeoutMs ?? 5000;
  const handle = setTimeout(() => {
    const controller = options.navigator.serviceWorker?.controller;
    if (controller === null || controller === undefined) {
      options.logger?.warn(
        'offline-sync: no Service Worker controls this page. The bridge will never be ' +
          'reached -- every request falls through to the network, online or not. Usual ' +
          'cause: the Service Worker was registered with a scope narrower than the pages ' +
          "that need it (see registerServiceWorker's `scope` option, default '/').",
      );
    }
  }, timeoutMs);
  return () => clearTimeout(handle);
}
