import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';

import { SCHEMA_FILE } from './ReplicatedSchema.js';
import type { PowerSyncAdminSpec, SyncConfig } from './types.js';

export const CONFIG_FILE_NAME = 'offline-sync.config.yaml';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const CONFIG_TEMPLATE = `# Configuration for @ksm/offline-sync. Versioned.
# The admin token is NOT here: it lives in .env.sync, ignored by git.

# Where browser calls live -- the only face "check-entites" can compare
# offline-sync.entites.yaml against.
routes:
  browser: []      # e.g. ["src/lib/api"]

# Where to reach the sync engine, and what belongs to this platform.
# OPTIONAL -- only used by the "schema" command.
powersync:
  adminUrl: ""                    # e.g. "http://localhost:8080"
  buckets: []                     # e.g. ["yownews_*"] -- empty = all buckets
  schemaFile: "${SCHEMA_FILE}"    # where to write the generated schema
  tokenEndpoint: ""               # e.g. "/api/auth/powersync-token" -- the
                                  # channel token, distinct from the user session
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

  const rawRoutes = (o['routes'] ?? {}) as Record<string, unknown>;
  const routes = {
    browser: toStringArray(rawRoutes['browser']),
  };
  if (routes.browser.length === 0) {
    throw new ConfigError(
      'routes.browser is empty: it is where browser calls live, the only ones ' +
        'the module can intercept offline. Without them, "check-entites" has ' +
        'nothing to compare the declaration against.',
    );
  }

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

  return { routes, ...(powersync !== undefined ? { powersync } : {}) };
}

/** Keys that can only legitimately live under another one -- used to catch a lost indentation level. */
const EXPECTED_PARENT: Record<string, string> = {
  browser: 'routes',
  adminUrl: 'powersync',
  buckets: 'powersync',
  schemaFile: 'powersync',
  tokenEndpoint: 'powersync',
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
