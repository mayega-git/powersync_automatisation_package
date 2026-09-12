import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRETS_FILE = '.env.sync';

export const ADMIN_TOKEN_KEY = 'PS_ADMIN_TOKEN';

const TEMPLATE = `# Secrets for @ksm/offline-sync -- DO NOT COMMIT.
# This file is ignored by git: "offline-sync init" added it there.
#
# The sync engine's admin token. It's one of the values declared under the
# "api.tokens" section of its configuration -- ask whoever runs the service.
#
# It has nothing to do with your users' applicative token: this one opens
# the engine's admin API, and must never leave this machine.
${ADMIN_TOKEN_KEY}=
`;

export interface SecretsWriteResult {
  path: string;
  written: boolean;
}

/** Never replaces an existing file: it may hold a secret pasted by hand. */
export function writeSecretsTemplate(cwd: string): SecretsWriteResult {
  const path = join(cwd, SECRETS_FILE);
  if (existsSync(path)) return { path: SECRETS_FILE, written: false };
  writeFileSync(path, TEMPLATE, 'utf8');
  return { path: SECRETS_FILE, written: true };
}

export function readAdminToken(cwd: string): string | undefined {
  const path = join(cwd, SECRETS_FILE);
  if (!existsSync(path)) return undefined;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator).trim() !== ADMIN_TOKEN_KEY) continue;

    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/** Order: an explicit argument, then the file, then the environment (CI has only that one). */
export function resolveAdminToken(cwd: string, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const fromFile = readAdminToken(cwd);
  if (fromFile !== undefined) return fromFile;

  const fromEnv = process.env[ADMIN_TOKEN_KEY];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

export const NO_TOKEN_MESSAGE =
  `No admin token found. Paste it into ${SECRETS_FILE}:\n` +
  `    ${ADMIN_TOKEN_KEY}=<the token>\n` +
  `This file is ignored by git. In CI, the ${ADMIN_TOKEN_KEY} environment ` +
  'variable works too.';
