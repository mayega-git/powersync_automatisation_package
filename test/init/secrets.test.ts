import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExecuteCliCommand, type CliOutput } from '../../src/init/Cli.js';
import {
  ADMIN_TOKEN_KEY,
  readAdminToken,
  resolveAdminToken,
  SECRETS_FILE,
  writeSecretsTemplate,
} from '../../src/init/SecretsFile.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'offline-sync-secrets-'));
}

function put(cwd: string, content: string): void {
  writeFileSync(join(cwd, SECRETS_FILE), content, 'utf8');
}

let before: string | undefined;
beforeEach(() => {
  before = process.env[ADMIN_TOKEN_KEY];
  delete process.env[ADMIN_TOKEN_KEY];
});
afterEach(() => {
  if (before === undefined) delete process.env[ADMIN_TOKEN_KEY];
  else process.env[ADMIN_TOKEN_KEY] = before;
});

describe('the template', () => {
  it('writes it with the key, empty', () => {
    const cwd = project();
    expect(writeSecretsTemplate(cwd).written).toBe(true);
    const text = readFileSync(join(cwd, SECRETS_FILE), 'utf8');
    expect(text).toContain(`${ADMIN_TOKEN_KEY}=`);
    expect(text).toContain('DO NOT COMMIT');
    expect(readAdminToken(cwd)).toBeUndefined();
  });

  it('never replaces an existing file: it may hold a secret pasted by hand', () => {
    const cwd = project();
    put(cwd, `${ADMIN_TOKEN_KEY}=mine\n`);
    expect(writeSecretsTemplate(cwd).written).toBe(false);
    expect(readAdminToken(cwd)).toBe('mine');
  });
});

describe('reading', () => {
  it('skips comments and empty lines', () => {
    const cwd = project();
    put(cwd, `# a comment\n\n${ADMIN_TOKEN_KEY}=abc123\n`);
    expect(readAdminToken(cwd)).toBe('abc123');
  });

  it('strips quotes: pasting them must not break reading', () => {
    const cwd = project();
    put(cwd, `${ADMIN_TOKEN_KEY}="abc123"\n`);
    expect(readAdminToken(cwd)).toBe('abc123');
  });

  it('ignores other keys', () => {
    const cwd = project();
    put(cwd, `OTHER=xyz\n${ADMIN_TOKEN_KEY}=abc123\n`);
    expect(readAdminToken(cwd)).toBe('abc123');
  });

  it('an empty value means absent, not an empty string', () => {
    // Otherwise the module would query the engine with an empty token, and
    // the error would be a 401 instead of a message that says what to do.
    const cwd = project();
    put(cwd, `${ADMIN_TOKEN_KEY}=\n`);
    expect(readAdminToken(cwd)).toBeUndefined();
  });

  it('a missing file is not an error', () => {
    expect(readAdminToken(project())).toBeUndefined();
  });
});

describe('resolution order', () => {
  it('the argument wins over everything: that is the tests\' path', () => {
    const cwd = project();
    put(cwd, `${ADMIN_TOKEN_KEY}=from-file\n`);
    expect(resolveAdminToken(cwd, 'explicit')).toBe('explicit');
  });

  it('the file wins over the environment', () => {
    // When both exist, the one the developer just edited must win.
    const cwd = project();
    put(cwd, `${ADMIN_TOKEN_KEY}=from-file\n`);
    process.env[ADMIN_TOKEN_KEY] = 'from-environment';
    expect(resolveAdminToken(cwd)).toBe('from-file');
  });

  it('the environment is the fallback, for CI', () => {
    // There, no file ignored by git exists: it's the only mechanism CI has.
    const cwd = project();
    process.env[ADMIN_TOKEN_KEY] = 'from-environment';
    expect(resolveAdminToken(cwd)).toBe('from-environment');
  });

  it('returns undefined when there is nothing anywhere', () => {
    expect(resolveAdminToken(project())).toBeUndefined();
  });
});

describe('init', () => {
  function output(): { out: CliOutput; lines: string[] } {
    const lines: string[] = [];
    return { out: { log: (m) => lines.push(m), error: (m) => lines.push(m) }, lines };
  }

  it('writes both files and has the one carrying the secret ignored', () => {
    const cwd = project();
    const { out, lines } = output();
    new ExecuteCliCommand(out).init(cwd);

    expect(readFileSync(join(cwd, SECRETS_FILE), 'utf8')).toContain(ADMIN_TOKEN_KEY);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toContain(SECRETS_FILE);
    expect(lines.join('\n')).toContain(SECRETS_FILE);
  });

  it('does not add the line to .gitignore twice', () => {
    const cwd = project();
    const { out } = output();
    new ExecuteCliCommand(out).init(cwd);
    // The configuration already exists: init throws, but .gitignore must not
    // receive a second line because of it.
    try {
      new ExecuteCliCommand(out).init(cwd);
    } catch {
      /* expected */
    }
    const lines = readFileSync(join(cwd, '.gitignore'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === SECRETS_FILE);
    expect(lines).toHaveLength(1);
  });
});
