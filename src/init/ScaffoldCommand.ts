import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadConfig } from './ConfigLoader.js';
import { capturingRun, readManifest } from './PowerSyncSetup.js';
import { SCHEMA_FILE } from './ReplicatedSchema.js';
import { configureServiceWorkerBuild, writeServiceWorkerRoute } from './ServiceWorkerBuild.js';
import type { SyncConfig } from './types.js';

export const TOKENS_FILE = 'tokens.ts';
export const INIT_FILE = 'init.ts';
export const SW_FILE = 'sw.ts';

export const DEFAULT_TOKEN_ENDPOINT = '/api/auth/powersync-token';

/** What the generated sw.ts is written against. */
export const SW_PACKAGE = 'serwist';
export const SW_VERSION = '^9.5.12';

/**
 * Only needed to compile sw.ts into a real, servable Service Worker at
 * request time (the route written by writeServiceWorkerRoute) -- so only
 * installed when that route is actually generated.
 */
export const SW_BUILD_PACKAGE = '@serwist/turbopack';
export const SW_BUILD_VERSION = '^9.5.12';
export const SW_BUILD_ESBUILD_PACKAGE = 'esbuild-wasm';
export const SW_BUILD_ESBUILD_VERSION = '^0.28.2';

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
  /** Packages installed this run, e.g. ["serwist@^9.5.12"] -- empty when nothing new was generated or the packages were already there. */
  installed: string[];
  /** The block to paste, when the bundler config couldn't be modified. */
  bundlerBlock?: string;
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
    drop(cwd, join(dir, SW_FILE), serviceWorkerTemplate()),
  ];

  const toInstall: string[] = [];
  let bundlerBlock: string | undefined;
  const sw = files[2];
  if (sw?.written === true) {
    const dependencies = readManifest(cwd)['dependencies'] as Record<string, string> | undefined;
    if (dependencies?.[SW_PACKAGE] === undefined) {
      toInstall.push(`${SW_PACKAGE}@${SW_VERSION}`);
    }

    // Compiling sw.ts into something the browser can load, and telling it
    // to register -- neither happens just because the file exists.
    const route = writeServiceWorkerRoute(cwd, join(dir, SW_FILE));
    files.push(route);
    if (route.written) {
      if (dependencies?.[SW_BUILD_PACKAGE] === undefined) {
        toInstall.push(`${SW_BUILD_PACKAGE}@${SW_BUILD_VERSION}`);
      }
      if (dependencies?.[SW_BUILD_ESBUILD_PACKAGE] === undefined) {
        toInstall.push(`${SW_BUILD_ESBUILD_PACKAGE}@${SW_BUILD_ESBUILD_VERSION}`);
      }

      const bundler = configureServiceWorkerBuild(cwd);
      files.push({
        path: bundler.step.name,
        written: bundler.step.state === 'done',
        ...(bundler.step.detail !== undefined ? { reason: bundler.step.detail } : {}),
      });
      bundlerBlock = bundler.block;
    }
  }

  if (toInstall.length > 0) {
    run(`npm install ${toInstall.join(' ')}`, cwd);
  }

  return {
    dir,
    files,
    installed: toInstall,
    ...(bundlerBlock !== undefined ? { bundlerBlock } : {}),
    ...(captured.length > 0 ? { commandOutput: captured } : {}),
  };
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
} from '@ksm/offline-sync/powersync';

import { AppSchema } from './schema';
import { ApplicationTokens } from './tokens';

const DATABASE_FILE = 'offline-sync.db';

// initSync() is meant to run once, but the React provider's effect isn't
// guaranteed to call it only once: React Strict Mode (on by default in
// development) mounts every component, cleans it up, then mounts it again --
// and the cleanup can't undo an initSync() still in flight. Two full calls
// would build two independent PowerSyncDatabase engines, both staying
// connected. Caching the promise here makes a second call return the SAME
// engine instead of building another one; on failure the cache is cleared so
// a real retry (not a React remount) can still try again.
let syncPromise: Promise<OfflineSync> | null = null;

/** Called from the app's React provider. Safe to call more than once -- see above. */
export function initSync(): Promise<OfflineSync> {
  if (syncPromise !== null) return syncPromise;
  syncPromise = buildSync().catch((err: unknown) => {
    syncPromise = null;
    throw err;
  });
  return syncPromise;
}

async function buildSync(): Promise<OfflineSync> {
  const engineUrl = process.env.NEXT_PUBLIC_POWERSYNC_URL;
  if (engineUrl === undefined || engineUrl.length === 0) {
    throw new Error(
      'NEXT_PUBLIC_POWERSYNC_URL is empty: the browser has nowhere to reach ' +
        'the sync engine.',
    );
  }

  // 1. The engine. The application builds it, NEVER the module.
  //
  //    "worker" is NOT optional under Turbopack: @powersync/web's default
  //    worker resolution (new URL('./worker.js', import.meta.url)) relies on
  //    Vite/Webpack rewriting that URL at build time. Turbopack doesn't do
  //    this, so the worker silently fails to spawn -- no SharedWorker ever
  //    appears, no connection to the sync engine, no error either. The
  //    postinstall step ("powersync-web copy-assets -o public") exists
  //    exactly for this: it drops a working worker.js in public/@powersync/,
  //    and both options below point at it explicitly.
  const engine = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: DATABASE_FILE, worker: '/@powersync/worker.js' },
    sync: { worker: '/@powersync/worker.js' },
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
  //    never gives it directly. Use sync.write()/sync.read() directly at
  //    the one place your application calls fetch() -- see docs/OfflineSync.md.
  const sync = await OfflineSync.create({
    connector: bridge,
    logger,
  });

  // The channel opens LAST, but NOT awaited: an earlier connect() call would
  // reach a module not yet ready to route a downstream update, so it's
  // still started only now, after "sync" exists -- but local reads/writes
  // never needed the network, and awaiting a slow or failed connection
  // attempt here (offline, most of all) would delay the page's readiness for
  // no reason. The connection is best-effort: it proceeds in the background,
  // and a failure is logged, never thrown.
  engine.connect(bridge).catch((err: unknown) => {
    logger.error('sync connection failed to establish', { error: String(err) });
  });

  return sync;
}
`;
}

/**
 * A minimal, working Serwist Service Worker -- written next to the other
 * two generated files, same rule: only when nothing is there yet.
 * Already have an active Service Worker elsewhere in the project? See
 * docs/pwa.md: it documents exactly what to copy from this file into
 * yours -- this one is then a reference to consult, not something to keep.
 *
 * This worker never sees a business request: `sync.write()`/`sync.read()`
 * already answer those before `fetch()` is ever called (see init.ts and
 * docs/OfflineSync.md). Its only job is caching navigation and static
 * assets, so the application still loads with no network at all.
 */
function serviceWorkerTemplate(): string {
  return `/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Service Worker. GENERATED once by "offline-sync scaffold", then yours:
 * never rewritten afterward.
 *
 * ALREADY HAVE AN ACTIVE SERVICE WORKER ELSEWHERE? Only one Service Worker
 * controls a given page (see docs/pwa.md). Copy the runtime-caching rules
 * below into your own Service Worker instead of running two, then delete
 * this file.
 *
 * TO ADAPT: this assumes Serwist (serwist.pages.dev). Using something
 * else? Keep the rules below and wire them into your own runtime-caching
 * mechanism.
 *
 * This worker carries no business logic on purpose: sync.write()/sync.read()
 * (see init.ts) already answer those requests before fetch() is ever
 * called, so this worker only ever sees navigation and static assets.
 */

import {
  NetworkFirst,
  StaleWhileRevalidate,
  Serwist,
  type PrecacheEntry,
  type RuntimeCaching,
  type SerwistGlobalConfig,
} from 'serwist';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const RUNTIME_CACHING: RuntimeCaching[] = [
  // 1. Pages (navigate requests): Network first, fallback to cache
  {
    matcher: ({ request, url }) => request.mode === 'navigate' && url.origin === self.location.origin,
    handler: new NetworkFirst({
      cacheName: 'app-pages',
      networkTimeoutSeconds: 5,
    }),
  },

  // 2. Static assets (CSS, JS, fonts, images, etc.)
  {
    matcher: ({ request }) =>
      ['style', 'script', 'worker', 'image', 'font'].includes(request.destination),
    handler: new StaleWhileRevalidate({
      cacheName: 'app-static-assets',
    }),
  }
];

const PAGES_TO_PRECACHE: string[] = [
  // Ex: '/dashboard', '/inventory/movements'
];

self.addEventListener('install', (event) => {
  if (PAGES_TO_PRECACHE.length > 0) {
    event.waitUntil(
      caches.open('app-pages').then((cache) => cache.addAll(PAGES_TO_PRECACHE))
    );
  }
});

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: RUNTIME_CACHING,
});

serwist.addEventListeners();
`;
}
