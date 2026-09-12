import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

import { SCHEMA_FILE } from './ReplicatedSchema.js';
import type { PowerSyncAdminSpec, ScopeFilter, SyncConfig, WrapperSpec } from './types.js';

export const CONFIG_FILE_NAME = 'offline-sync.config.yaml';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const CONFIG_TEMPLATE = `# Configuration for the Initialization phase of @ksm/offline-sync.
# Used only by the "discover" and "check" commands -- never read while the
# application is running.

# Where calls live, on each side.
#
# An operation has two faces: the one the browser calls -- the only one
# interceptable offline, so the only one the module replays -- and the one
# the BFF calls to the remote server, which leads to the documented response.
routes:
  browser: []      # e.g. ["src/lib/api"]
  server: []       # e.g. ["src/server/ksm"] -- optional

# The operations table: THE source of truth.
# Written once by an agent, reviewed by a human, versioned. What's not in it
# is not intercepted.
operations: "offline-sync.operations.md"

# The marker that designates server calls. Used only by "check", to find
# calls in the code that the table doesn't declare.
#
# Placed IN FRONT OF THE PATH, right next to it:
#     apiFetch(/** @offlineSyncCall */\`/api/blogs/\${id}\`, { method: 'DELETE' })
#
# It's the path that's marked, not the function: a function containing two
# calls stays readable this way, each one carrying its own marker.
#
# In front of the FUNCTION only when there's no literal path to annotate --
# a path stored in a constant, or built by a helper.
httpWrapper:
  jsDocTag: ""

# Where to reach the sync engine, and what belongs to this platform.
# OPTIONAL -- only used by the "schema" command.
#
# The token is NOT here: "init" wrote .env.sync for it, and added it to
# .gitignore. A secret that opens the engine's admin API has no business in
# a versioned file.
powersync:
  adminUrl: ""                    # e.g. "http://localhost:8080"
  buckets: []                     # e.g. ["yownews_*"] -- empty = all buckets
  schemaFile: "${SCHEMA_FILE}"    # where to write the generated schema
  tokenEndpoint: ""               # e.g. "/api/auth/powersync-token" -- the
                                  # channel token, distinct from the user session

# Where to find the server documentation. OPTIONAL.
# No longer used for matching -- the table already did that -- only to give
# the drafts the shape their response should have.
docSource: ""

# Which calls to keep. These criteria apply to BROWSER paths.
# An empty pathPrefixes means "all", never "none".
scope:
  pathPrefixes: []
  onlineOnlyPathPrefixes: []       # e.g. ["/auth"] -- stays online no matter what
`;

export function writeConfigTemplate(cwd: string): string {
  const path = join(cwd, CONFIG_FILE_NAME);
  if (existsSync(path)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} already exists. It is not replaced: it probably ` +
        'holds work done by hand.',
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, CONFIG_TEMPLATE, 'utf8');
  return path;
}

export function loadConfig(cwd: string): SyncConfig {
  const path = join(cwd, CONFIG_FILE_NAME);
  if (!existsSync(path)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME} was not found in ${cwd}. Run "offline-sync init" ` +
        'first to write a template.',
    );
  }

  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError(`${CONFIG_FILE_NAME} is empty or malformed.`);
  }
  const o = raw as Record<string, unknown>;
  checkIndentation(o);

  const docSource = typeof o['docSource'] === 'string' ? o['docSource'] : '';

  const rawRoutes = (o['routes'] ?? {}) as Record<string, unknown>;
  const routes = {
    browser: toStringArray(rawRoutes['browser']),
    server: toStringArray(rawRoutes['server']),
  };
  if (routes.browser.length === 0) {
    throw new ConfigError(
      'routes.browser is empty: it is where browser calls live, the only ones ' +
        'the module can intercept offline. Without them, "check" has nothing ' +
        'to compare against the operations table.',
    );
  }

  const operations =
    typeof o['operations'] === 'string' && o['operations'].length > 0
      ? o['operations']
      : undefined;

  const wrapper = o['httpWrapper'];
  const jsDocTag =
    typeof wrapper === 'object' && wrapper !== null
      ? String((wrapper as Record<string, unknown>)['jsDocTag'] ?? '')
      : '';
  if (jsDocTag.length === 0) {
    throw new ConfigError(
      'httpWrapper.jsDocTag is empty: this marker designates the functions to ' +
        'inspect. Without it, "check" can\'t find calls in the code that the ' +
        "table doesn't declare.",
    );
  }
  const httpWrapper: WrapperSpec = { jsDocTag };

  const rawScope = (o['scope'] ?? {}) as Record<string, unknown>;
  const scope: ScopeFilter = {
    pathPrefixes: toStringArray(rawScope['pathPrefixes']),
    onlineOnlyPathPrefixes: toStringArray(rawScope['onlineOnlyPathPrefixes']),
  };

  const rawPowersync = (o['powersync'] ?? {}) as Record<string, unknown>;
  const adminUrl = typeof rawPowersync['adminUrl'] === 'string' ? rawPowersync['adminUrl'] : '';
  const powersync: PowerSyncAdminSpec | undefined =
    adminUrl.length > 0
      ? {
          adminUrl,
          buckets: toStringArray(rawPowersync['buckets']),
          schemaFile:
            typeof rawPowersync['schemaFile'] === 'string' &&
            rawPowersync['schemaFile'].length > 0
              ? rawPowersync['schemaFile']
              : SCHEMA_FILE,
          ...(typeof rawPowersync['tokenEndpoint'] === 'string' &&
          rawPowersync['tokenEndpoint'].length > 0
            ? { tokenEndpoint: rawPowersync['tokenEndpoint'] }
            : {}),
        }
      : undefined;

  const base = { routes, httpWrapper, scope, ...(powersync !== undefined ? { powersync } : {}) };
  const withOperations = operations !== undefined ? { ...base, operations } : base;
  return docSource.length > 0 ? { ...withOperations, docSource } : withOperations;
}

/** Keys that can only legitimately live under another one -- used to catch a lost indentation level. */
const EXPECTED_PARENT: Record<string, string> = {
  browser: 'routes',
  server: 'routes',
  jsDocTag: 'httpWrapper',
  adminUrl: 'powersync',
  buckets: 'powersync',
  schemaFile: 'powersync',
  tokenEndpoint: 'powersync',
  pathPrefixes: 'scope',
  onlineOnlyPathPrefixes: 'scope',
};

function checkIndentation(o: Record<string, unknown>): void {
  const stray = Object.keys(o).filter((key) => EXPECTED_PARENT[key] !== undefined);
  if (stray.length === 0) return;

  const detail = stray.map((key) => `  ${key}  ->  under "${EXPECTED_PARENT[key]}"`).join('\n');
  throw new ConfigError(
    `${CONFIG_FILE_NAME}: ${stray.length} key(s) are at the root when they ` +
      'should be indented under another one. This is valid YAML, which is why ' +
      `nothing caught it before.\n${detail}\nTwo spaces is enough.`,
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
