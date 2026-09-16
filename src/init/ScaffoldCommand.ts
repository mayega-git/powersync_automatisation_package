import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig } from './ConfigLoader.js';
import { capturingRun, readManifest } from './PowerSyncSetup.js';
import { SCHEMA_FILE } from './ReplicatedSchema.js';
import type { SyncConfig } from './types.js';

export const TOKENS_FILE = 'tokens.ts';
export const INIT_FILE = 'init.ts';
export const PONT_FILE = 'pont.ts';
export const SW_FILE = 'sw.ts';

export const DEFAULT_TOKEN_ENDPOINT = '/api/auth/powersync-token';

/** What the generated sw.ts is written against; the same package @serwist/turbopack and @serwist/next build on top of. */
export const SW_PACKAGE = 'serwist';
export const SW_VERSION = '^9.5.12';

export interface ScaffoldOptions {
  cwd: string;
  loadConfigFn?: (cwd: string) => SyncConfig;
  /** Overridable in tests: no `npm install` should run during a test suite. */
  run?: (command: string, cwd: string) => void;
}

export interface WrittenFile {
  path: string;
  written: boolean;
  reason?: string;
}

export interface ScaffoldResult {
  files: WrittenFile[];
  /** Directory everything was dropped into. */
  dir: string;
  /** Packages installed this run, e.g. ["serwist@^9.5.12"] -- empty when sw.ts wasn't written or the package was already there. */
  installed: string[];
  /** Raw npm output, one entry per command run -- for --verbose only. */
  commandOutput?: string[];
}

export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const cwd = options.cwd;
  const config = (options.loadConfigFn ?? loadConfig)(cwd);
  const captured: string[] = [];
  const run = options.run ?? capturingRun(captured);

  const dir = dirname(config.powersync?.schemaFile ?? SCHEMA_FILE);
  const endpoint = config.powersync?.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;

  mkdirSync(join(cwd, dir), { recursive: true });

  const files = [
    drop(cwd, join(dir, TOKENS_FILE), tokensTemplate(endpoint)),
    drop(cwd, join(dir, INIT_FILE), initTemplate()),
    drop(cwd, join(dir, PONT_FILE), pontTemplate()),
    drop(cwd, join(dir, SW_FILE), serviceWorkerTemplate()),
  ];

  const installed: string[] = [];
  const sw = files[3];
  if (sw?.written === true) {
    const dependencies = readManifest(cwd)['dependencies'] as Record<string, string> | undefined;
    if (dependencies?.[SW_PACKAGE] === undefined) {
      run(`npm install ${SW_PACKAGE}@${SW_VERSION}`, cwd);
      installed.push(`${SW_PACKAGE}@${SW_VERSION}`);
    }
  }

  return { dir, files, installed, ...(captured.length > 0 ? { commandOutput: captured } : {}) };
}

/** Writes a file, unless it exists: it may hold work done by hand. */
function drop(cwd: string, path: string, content: string): WrittenFile {
  const fullPath = join(cwd, path);
  if (existsSync(fullPath)) {
    return { path, written: false, reason: 'already exists -- nothing was touched' };
  }
  writeFileSync(fullPath, content, 'utf8');
  return { path, written: true };
}

function tokensTemplate(endpoint: string): string {
  return `/**
 * Where this application gets its tokens from.
 *
 * GENERATED once by "offline-sync scaffold", then TO BE FILLED IN: it's the
 * only file in the wiring that knows the project's authentication. Never
 * rewritten.
 *
 * TWO TOKENS, AND THEY DON'T COINCIDE:
 *   - the CHANNEL token authorizes only one thing, opening the sync stream.
 *     Short, minted by a dedicated endpoint, meant for the engine;
 *   - the APPLICATIVE token is the ordinary session, sent to the business
 *     server.
 *
 * Confusing them works until the day one expires before the other.
 */
import type { TokenProvider } from '@ksm/offline-sync';

const CHANNEL_ENDPOINT = '${endpoint}';

export class ApplicationTokens implements TokenProvider {
  /**
   * RETURNING null AND THROWING DON'T MEAN THE SAME THING:
   *   - null  -> the user isn't signed in. The engine opens no channel, and
   *              doesn't retry. A valid answer;
   *   - throw -> a failure. The engine will retry.
   * Returning null on a failure would make a network outage look like a
   * sign-out, and sync would never resume on its own.
   */
  async getStreamToken(): Promise<string | null> {
    const response = await fetch(CHANNEL_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      // TO FILL IN if your server requires other headers.
    });

    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) {
      throw new Error(\`channel token refused (\${response.status})\`);
    }

    const body: unknown = await response.json();
    // TO CHECK: your server's response envelope. Here { data: { token } }.
    return (body as { data?: { token?: string } })?.data?.token ?? null;
  }

  /** The channel token is short-lived; asking for a new one is simpler than refreshing it. */
  async refreshStreamToken(): Promise<string | null> {
    return this.getStreamToken();
  }

  /** Sent to the business server in the Authorization header. */
  async getApplicativeToken(): Promise<string | null> {
    // TO FILL IN: wherever your application keeps the user's session.
    return null;
  }

  async refreshApplicativeToken(): Promise<string | null> {
    // TO FILL IN: your session renewal mechanism.
    return this.getApplicativeToken();
  }
}
`;
}

/** The order is imposed, not a preference: nothing to decide here, but plenty to get wrong. */
function initTemplate(): string {
  return `/**
 * Module wiring. GENERATED by "offline-sync scaffold".
 *
 * There's NOTHING to decide here -- which is why it can be generated. What
 * belongs to your application lives in tokens.ts, next to this file.
 *
 * THE ORDER OF THE SIX CONSTRUCTIONS IS IMPOSED, and a mistake doesn't show
 * right away: a module wired in the wrong order starts, then misbehaves
 * later. That's this file's reason to exist.
 *
 * REGENERATE when the module changes version. Since tokens.ts is never
 * touched, that costs nothing.
 */
'use client';

import { PowerSyncDatabase } from '@powersync/web';
import {
  ConsoleLogger,
  DeadLetterStore,
  ErrorHandlerRegistry,
  FetchClient,
  OfflineSync,
  OfflineSyncConnector,
} from '@ksm/offline-sync';
import {
  PowerSyncConnector,
  PowerSyncLocalDatabase,
  tableColumnsFromSchema,
} from '@ksm/offline-sync/powersync';

import { entities } from './entities';
import { AppSchema } from './schema';
import { ApplicationTokens } from './tokens';

const DATABASE_FILE = 'offline-sync.db';

/** Called ONCE, at startup. This is exactly what the app's React provider imports. */
export async function initSync(): Promise<OfflineSync> {
  const engineUrl = process.env.NEXT_PUBLIC_POWERSYNC_URL;
  if (engineUrl === undefined || engineUrl.length === 0) {
    throw new Error(
      'NEXT_PUBLIC_POWERSYNC_URL is empty: the browser has nowhere to reach ' +
        'the sync engine.',
    );
  }

  // 1. The engine. The application builds it, NEVER the module.
  const engine = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: DATABASE_FILE },
  });

  // 2. The local database, seen through the module's port.
  const db = new PowerSyncLocalDatabase(engine);

  const logger = new ConsoleLogger();

  // 3. What happens to definitively rejected writes.
  const deadLetters = new DeadLetterStore({ db });
  const errors = new ErrorHandlerRegistry({ logger });

  // 4. Deferred-upload logic, neutral with respect to the engine.
  const connector = new OfflineSyncConnector({
    http: new FetchClient({}),
    tokens: new ApplicationTokens(),
    deadLetters,
    errors,
    logger,
    syncEndpoint: engineUrl,
    db,
    onReauthRequired: () => {
      logger.error(
        'session expired: pending writes are kept, sign in again for them to go out',
      );
    },
    // Called each time a write is definitively rejected (not a network
    // hiccup: the server said no). Push the news to your own UI here, or to
    // the display-only element from "@ksm/offline-sync/ui".
    onDeadLetter: (entry) => {
      logger.error('write rejected, kept in the dead-letter store', {
        operationId: entry.operationId,
        reason: entry.reason,
      });
    },
  });

  // 5. The bridge: the only object that knows the shape of the engine's writes.
  const bridge = new PowerSyncConnector({ db: engine, connector });

  // 6. The module. It asks the bridge for the database -- the application
  //    never gives it directly.
  //
  //    "entities" says which table for which requests; "tableColumns" says
  //    what columns those tables really carry. With both, the module
  //    composes its own SQL at request time -- no handlers to write, no
  //    operations map to keep in sync.
  const sync = await OfflineSync.create({
    connector: bridge,
    entities,
    tableColumns: tableColumnsFromSchema(AppSchema),
    logger,
  });

  // The channel opens LAST: any earlier, a downstream update would reach a
  // module not yet ready to route it.
  await engine.connect(bridge);

  return sync;
}
`;
}

/** Nothing here depends on how the application handles authentication -- unlike tokens.ts, nothing to fill in. */
function pontTemplate(): string {
  return `/**
 * Bridge between the Service Worker and the page. GENERATED by
 * "offline-sync scaffold". Nothing to fill in: unlike tokens.ts, nothing
 * here depends on how your application handles authentication.
 *
 * TWO GESTURES, CALLED FROM YOUR OWN STARTUP CODE (never from here):
 *   1. connectBridge(sync) -- once initSync() resolves, so the Service
 *      Worker can have the page answer from the local database instead of
 *      the network. Returns the function that unplugs it.
 *   2. catchUpFirstVisit() -- once, at startup, before the app does
 *      anything else. On the very first visit the Service Worker installs
 *      WHILE the page is loading: the requests already in flight missed it.
 *      One reload, before the user has touched anything, settles it.
 */
'use client';

import type { OfflineSync } from '@ksm/offline-sync';
import { bridgeServiceWorker, reloadOnce } from '@ksm/offline-sync/pwa';

const alreadyControlledOnLoad =
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  navigator.serviceWorker.controller !== null;

function available(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator;
}

function whenItTakesOver(): Promise<void> {
  return new Promise((resolve) => {
    if (navigator.serviceWorker.controller !== null) {
      resolve();
      return;
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
  });
}

/** Call once initSync() has resolved. Returns the function that unplugs the bridge. */
export function connectBridge(sync: OfflineSync): () => void {
  if (!available()) return () => {};
  return bridgeServiceWorker({
    handles: (req) => sync.handles(req),
    respond: (req) => sync.interceptRequest(req),
    source: navigator.serviceWorker,
    logger: { error: (msg, ctx) => console.error(\`[offline-sync/bridge] \${msg}\`, ctx ?? '') },
  });
}

/** Call once, at startup, before anything else. */
export async function catchUpFirstVisit(): Promise<void> {
  if (!available()) return;
  await reloadOnce({
    controlled: whenItTakesOver(),
    session: window.sessionStorage,
    reload: () => window.location.reload(),
    alreadyControlled: alreadyControlledOnLoad,
    logger: { info: (msg) => console.info(\`[offline-sync/pwa] \${msg}\`) },
  });
}
`;
}

/**
 * A minimal, working Serwist Service Worker -- written next to the other
 * three generated files, same rule: only when nothing is there yet.
 * Already have an active Service Worker elsewhere in the project? See
 * docs/pwa.md: it documents exactly what to copy from this file into
 * yours -- this one is then a reference to consult, not something to keep.
 */
function serviceWorkerTemplate(): string {
  return `/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Service Worker. GENERATED once by "offline-sync scaffold", then yours:
 * never rewritten afterward.
 *
 * ALREADY HAVE AN ACTIVE SERVICE WORKER ELSEWHERE? Only one Service Worker
 * controls a given page (see docs/pwa.md). Copy the two calls below
 * (CacheRules.create / serveFromPage) and the runtime-caching rules into
 * your own Service Worker instead of running two, then delete this file.
 *
 * TO ADAPT: this assumes Serwist (serwist.pages.dev). Using something
 * else? Keep the two calls below and wire them into your own
 * runtime-caching mechanism.
 *
 * ORDER MATTERS below: the first rule that matches a request wins. Keep
 * the module's rules BEFORE anything you add (precaching, page caching, an
 * offline fallback...) -- TO FILL IN.
 */

import { CacheRules, serveFromPage } from '@ksm/offline-sync/pwa';
import {
  NetworkFirst,
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type RuntimeCaching,
  type SerwistGlobalConfig,
} from 'serwist';

import { entities } from './entities';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

// The rules the module needs -- the same in any application.
const moduleRules = CacheRules.create({ entities });

const askThePage = serveFromPage({
  clients: self.clients,
  openChannel: () => new MessageChannel(),
  buildResponse: (body, init) => new Response(body, init),
  goToNetwork: (req) => fetch(req as Request),
});

async function readRequest(req: Request, url: URL) {
  const method = req.method.toUpperCase();
  const address = \`\${url.pathname}\${url.search}\`;
  if (method === 'GET' || method === 'HEAD') return { method, url: address };
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    body = undefined;
  }
  return { method, url: address, ...(body !== undefined ? { body } : {}) };
}

const BRIDGE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const PAGES_CACHE = 'offline-sync-pages';

/**
 * TO FILL IN: list here the pages that must be available offline even
 * BEFORE a user has ever opened them -- typically the ones behind a
 * login, which a first-time visitor can't reach to "warm" the cache
 * naturally. Anything a user has actually visited is cached automatically
 * by the "pages" rule below; this list is only for pages nobody has
 * opened yet on this device. Leave empty if that doesn't apply to you.
 *
 * Example: ['/dashboard', '/account'].
 */
const PAGES_TO_PRECACHE: string[] = [];

async function precachePages(): Promise<void> {
  if (PAGES_TO_PRECACHE.length === 0) return;
  const cache = await caches.open(PAGES_CACHE);
  await Promise.all(
    PAGES_TO_PRECACHE.map(async (path) => {
      try {
        const response = await fetch(path, { credentials: 'include' });
        if (response.ok) await cache.put(path, response);
      } catch {
        // No network right now: try again next time the worker activates.
      }
    }),
  );
}

const RUNTIME_CACHING: RuntimeCaching[] = [
  {
    matcher: ({ url }) => moduleRules.isAlwaysOnline(url.pathname),
    handler: new NetworkOnly(),
  },
  ...BRIDGE_METHODS.map(
    (method): RuntimeCaching => ({
      method,
      matcher: ({ request, url }) =>
        !moduleRules.isReplay(request.headers) &&
        moduleRules.belongsToModule(request.method, url.pathname),
      handler: async ({ request, url, event }) =>
        (await askThePage({
          raw: request,
          clientId: (event as FetchEvent).clientId ?? '',
          request: await readRequest(request, url),
        })) as Response,
    }),
  ),
  {
    // Pages: network first to stay current, last known version once
    // offline. A page visited once stays available -- PAGES_TO_PRECACHE
    // above is only for pages nobody has opened yet.
    matcher: ({ request }) => request.mode === 'navigate',
    handler: new NetworkFirst({ cacheName: PAGES_CACHE, networkTimeoutSeconds: 5 }),
  },
  // TO FILL IN: anything else specific to your application (an offline
  // fallback page, long-lived static assets...).
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: RUNTIME_CACHING,
});

serwist.addEventListeners();

self.addEventListener('activate', (event) => {
  event.waitUntil(precachePages());
});
`;
}
