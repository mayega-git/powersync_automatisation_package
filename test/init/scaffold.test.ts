import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { INIT_FILE, scaffold, TOKENS_FILE } from '../../src/init/ScaffoldCommand.js';
import type { SyncConfig } from '../../src/init/types.js';

const config: SyncConfig = {
  routes: { browser: ['src/lib/api'], server: [] },
  httpWrapper: { jsDocTag: '@offlineSyncCall' },
  scope: { pathPrefixes: [], onlineOnlyPathPrefixes: [] },
  powersync: {
    adminUrl: 'http://engine.test',
    buckets: [],
    schemaFile: 'src/services/offline/schema.ts',
    tokenEndpoint: '/api/auth/powersync-token',
  },
};

function project(): string {
  return mkdtempSync(join(tmpdir(), 'offline-sync-scaffold-'));
}

function run(cwd: string, c: SyncConfig = config) {
  return scaffold({ cwd, loadConfigFn: () => c });
}

function read(cwd: string, name: string): string {
  return readFileSync(join(cwd, 'src/services/offline', name), 'utf8');
}

describe('the two wiring files', () => {
  it('drops them next to the schema: the engine folder already exists', () => {
    const cwd = project();
    const r = run(cwd);
    expect(r.dir).toBe('src/services/offline');
    expect(r.files.map((f) => f.written)).toEqual([true, true]);
  });

  it('never overwrites an existing file: it holds work done by hand', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'src/services/offline'), { recursive: true });
    writeFileSync(join(cwd, 'src/services/offline', TOKENS_FILE), 'mine\n', 'utf8');

    const r = run(cwd);
    expect(read(cwd, TOKENS_FILE)).toBe('mine\n');
    const tokens = r.files.find((f) => f.path.endsWith(TOKENS_FILE));
    expect(tokens?.written).toBe(false);
    expect(tokens?.reason).toMatch(/already exists/);
    // The other one is still dropped: the two are independent.
    expect(r.files.find((f) => f.path.endsWith(INIT_FILE))?.written).toBe(true);
  });
});

describe('the token provider', () => {
  it('sets the endpoint declared in the configuration', () => {
    const cwd = project();
    run(cwd);
    expect(read(cwd, TOKENS_FILE)).toContain("'/api/auth/powersync-token'");
  });

  it('falls back to the usual endpoint when nothing is declared', () => {
    const cwd = project();
    const withoutEndpoint: SyncConfig = {
      ...config,
      powersync: { ...config.powersync!, tokenEndpoint: undefined },
    };
    run(cwd, withoutEndpoint);
    expect(read(cwd, TOKENS_FILE)).toContain('/api/auth/powersync-token');
  });

  it('distinguishes "not signed in" from "failed": the difference decides the retry', () => {
    // Returning null on a failure would make a network outage look like a
    // sign-out, and sync would never resume on its own.
    const cwd = project();
    run(cwd);
    const text = read(cwd, TOKENS_FILE);
    expect(text).toMatch(/status === 401 \|\| response\.status === 403\) return null/);
    expect(text).toMatch(/throw new Error/);
  });

  it('carries the four methods of the contract', () => {
    const cwd = project();
    run(cwd);
    const text = read(cwd, TOKENS_FILE);
    for (const m of [
      'getStreamToken',
      'refreshStreamToken',
      'getApplicativeToken',
      'refreshApplicativeToken',
    ]) {
      expect(text).toContain(m);
    }
  });
});

describe('the wiring', () => {
  it('correctly resolves back to the files generated at the root', () => {
    const cwd = project();
    run(cwd);
    const text = read(cwd, INIT_FILE);
    expect(text).toContain("from '../../../offline-map.stub'");
    expect(text).toContain("from '../../../offline-handlers.stub'");
  });

  it('recomputes that path when the folder depth changes', () => {
    const cwd = project();
    run(cwd, {
      ...config,
      powersync: { ...config.powersync!, schemaFile: 'app/offline/schema.ts' },
    });
    const text = readFileSync(join(cwd, 'app/offline', INIT_FILE), 'utf8');
    expect(text).toContain("from '../../offline-map.stub'");
  });

  it('opens the channel LAST', () => {
    // Any earlier, a downstream update would reach a module not yet ready to route it.
    const cwd = project();
    run(cwd);
    const text = read(cwd, INIT_FILE);
    expect(text.indexOf('OfflineSync.create')).toBeLessThan(text.indexOf('engine.connect'));
  });

  it('builds the database before the dead-letter store, which relies on it', () => {
    const cwd = project();
    run(cwd);
    const text = read(cwd, INIT_FILE);
    expect(text.indexOf('new PowerSyncLocalDatabase')).toBeLessThan(
      text.indexOf('new DeadLetterStore'),
    );
  });

  it('refuses to start without the engine address, rather than failing later', () => {
    const cwd = project();
    run(cwd);
    expect(read(cwd, INIT_FILE)).toMatch(/NEXT_PUBLIC_POWERSYNC_URL is empty/);
  });

  it('exports initSync, the name the React provider imports', () => {
    const cwd = project();
    run(cwd);
    expect(read(cwd, INIT_FILE)).toContain('export async function initSync()');
  });
});
