import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { findBundlerConfig } from './PowerSyncSetup.js';

export type ServiceWorkerBuildState = 'done' | 'already-set' | 'manual';

export interface ServiceWorkerBuildStep {
  name: string;
  state: ServiceWorkerBuildState;
  detail?: string;
}

/** Marker so a second run never wraps the export twice. */
export const PWA_BUNDLER_MARKER = 'offline-sync:pwa';

export const WITH_SERWIST_IMPORT = `import { withSerwist } from '@serwist/turbopack'; // ${PWA_BUNDLER_MARKER} -- compiles sw.ts into a real Service Worker.`;

/**
 * Finds `export default <expr>;` or `module.exports = <expr>;` at the end
 * of the file and wraps `<expr>` in `withSerwist(...)`. Composes correctly
 * with an export already wrapped by another plugin
 * (`withSerwist(withNextIntl(nextConfig))`), since it wraps whatever is
 * there, not just a bare identifier.
 */
function wrapDefaultExport(content: string): string | undefined {
  const match = /(export\s+default\s+|module\.exports\s*=\s*)([\s\S]+?);?\s*$/.exec(content);
  if (match === null) return undefined;
  const [, prefix, expr] = match;
  return content.slice(0, match.index) + `${prefix}withSerwist(${expr});\n`;
}

/**
 * Wires `withSerwist` into the bundler config, the same way
 * `configureBundler` (PowerSyncSetup.ts) wires the WASM webpack block:
 * a marker so it never runs twice, an unrecognized shape handed back to
 * paste by hand rather than forced.
 */
export function configureServiceWorkerBuild(cwd: string): { step: ServiceWorkerBuildStep; block?: string } {
  const path = findBundlerConfig(cwd);
  const block = `${WITH_SERWIST_IMPORT}\n\n// Wrap your existing default export: export default withSerwist(<your config>);`;

  if (path === undefined) {
    return {
      step: { name: 'bundler configuration', state: 'manual', detail: 'no next.config found' },
      block,
    };
  }

  const content = readFileSync(path, 'utf8');
  const name = path.split('/').pop() ?? path;

  if (content.includes(PWA_BUNDLER_MARKER)) {
    return { step: { name, state: 'already-set' } };
  }

  const modified = wrapDefaultExport(content);
  if (modified === undefined) {
    return {
      step: { name, state: 'manual', detail: 'file shape not recognized -- nothing was modified' },
      block,
    };
  }

  const withImport = `${WITH_SERWIST_IMPORT}\n` + modified;
  writeFileSync(path, withImport, 'utf8');
  return { step: { name, state: 'done' } };
}

export const SERWIST_ROUTE_FILE = 'route.ts';

function serwistRouteTemplate(swSrc: string): string {
  return `/**
 * Where the built Service Worker is served: /serwist/sw.js
 *
 * Serwist takes ${swSrc}, bundles it, and injects the list of build files
 * into it.
 */
import { createSerwistRoute } from '@serwist/turbopack';

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    swSrc: '${swSrc}',
  });
`;
}

/**
 * The App Router's root, so the route lands at src/app/serwist or
 * app/serwist depending on the project's own layout. Returns undefined
 * for a Pages Router project (or one that hasn't created app/ yet) --
 * nothing is guessed there, see docs/pwa.md for what to add by hand.
 */
export function appRouterRoot(cwd: string): string | undefined {
  if (existsSync(join(cwd, 'src/app'))) return 'src/app';
  if (existsSync(join(cwd, 'app'))) return 'app';
  return undefined;
}

export interface RouteResult {
  path: string;
  written: boolean;
  reason?: string;
}

/** Writes the Serwist route, unless one exists (it may hold work done by hand) or there's no App Router to put it in. */
export function writeServiceWorkerRoute(cwd: string, swSrc: string): RouteResult {
  const root = appRouterRoot(cwd);
  if (root === undefined) {
    return {
      path: '(app/serwist/[path]/route.ts)',
      written: false,
      reason: 'no app/ (App Router) directory found -- see docs/pwa.md for what to wire by hand',
    };
  }

  const routePath = join(root, 'serwist', '[path]', SERWIST_ROUTE_FILE);
  const fullPath = join(cwd, routePath);
  if (existsSync(fullPath)) {
    return { path: routePath, written: false, reason: 'already exists -- nothing was touched' };
  }

  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, serwistRouteTemplate(swSrc), 'utf8');
  return { path: routePath, written: true };
}
