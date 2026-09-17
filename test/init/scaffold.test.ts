import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { INIT_FILE, PONT_FILE, scaffold, SW_FILE, TOKENS_FILE } from '../../src/init/ScaffoldCommand.js';
import type { SyncConfig } from '../../src/init/types.js';

const config: SyncConfig = {
  powersync: {
    adminUrl: 'http://engine.test',
    buckets: [],
    schemaFile: 'src/services/offline/schema.ts',
    tokenEndpoint: '/api/auth/powersync-token',
  },
};

function project(dependencies: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'offline-sync-scaffold-'));
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'test-project', dependencies }, null, 2),
    'utf8',
  );
  return cwd;
}

function run(cwd: string, c: SyncConfig = config, ranCommands: string[] = []) {
  return scaffold({ cwd, loadConfigFn: () => c, run: (command) => ranCommands.push(command) });
}

function read(cwd: string, name: string): string {
  return readFileSync(join(cwd, 'src/services/offline', name), 'utf8');
}

describe('the wiring files', () => {
  it('drops tokens.ts, init.ts, pont.ts and sw.ts next to the schema: the engine folder already exists', () => {
    const cwd = project();
    const r = run(cwd);
    expect(r.dir).toBe('src/services/offline');
    expect(
      r.files
        .filter(
          (f) =>
            f.path.endsWith(TOKENS_FILE) ||
            f.path.endsWith(INIT_FILE) ||
            f.path.endsWith(PONT_FILE) ||
            f.path.endsWith(SW_FILE),
        )
        .map((f) => f.written),
    ).toEqual([true, true, true, true]);
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
    // The other ones are still dropped: each file is independent.
    expect(r.files.find((f) => f.path.endsWith(INIT_FILE))?.written).toBe(true);
    expect(r.files.find((f) => f.path.endsWith(PONT_FILE))?.written).toBe(true);
    expect(r.files.find((f) => f.path.endsWith(SW_FILE))?.written).toBe(true);
  });
});

describe('the Service Worker', () => {
  it('is written next to the other generated files, no configuration needed', () => {
    const cwd = project();
    const r = run(cwd);
    const sw = r.files.find((f) => f.path.endsWith(SW_FILE));
    expect(sw?.written).toBe(true);
    const text = read(cwd, SW_FILE);
    expect(text).toContain('CacheRules');
    expect(text).toContain('serveFromPage');
    expect(text).toContain("from './entities'");
    // The concrete "TO FILL IN" the user asked for: a place to list pages
    // that must be available offline before anyone has visited them.
    expect(text).toContain('PAGES_TO_PRECACHE');
    expect(text).toMatch(/request\.mode === 'navigate'/);
    // Without this, the file can't be typechecked on its own: the project's
    // own tsconfig has "dom", not "webworker" (the two can't coexist there).
    expect(text).toContain('/// <reference lib="webworker" />');
  });

  it('never overwrites one already there: a stray file is a safety net, not the documented way to reuse an existing Service Worker', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'src/services/offline'), { recursive: true });
    writeFileSync(join(cwd, 'src/services/offline', SW_FILE), 'mine\n', 'utf8');

    const r = run(cwd);
    expect(read(cwd, SW_FILE)).toBe('mine\n');
    expect(r.files.find((f) => f.path.endsWith(SW_FILE))?.written).toBe(false);
  });
});

describe('the serwist dependency', () => {
  it('is installed when sw.ts is written and serwist is missing from package.json', () => {
    const cwd = project();
    const ran: string[] = [];
    const r = run(cwd, config, ran);
    expect(r.installed).toEqual(['serwist@^9.5.12']);
    expect(ran.some((c) => c.startsWith('npm install serwist@'))).toBe(true);
  });

  it('is left alone when already declared in package.json', () => {
    const cwd = project({ serwist: '^9.0.0' });
    const ran: string[] = [];
    const r = run(cwd, config, ran);
    expect(r.installed).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('is not installed when sw.ts already existed: nothing new was generated', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'src/services/offline'), { recursive: true });
    writeFileSync(join(cwd, 'src/services/offline', SW_FILE), 'mine\n', 'utf8');

    const ran: string[] = [];
    const r = run(cwd, config, ran);
    expect(r.installed).toEqual([]);
    expect(ran).toEqual([]);
  });
});

describe('the Service Worker build (App Router wiring)', () => {
  it('generates the Serwist route and installs its build dependencies when app/ exists', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'app'), { recursive: true });

    const ran: string[] = [];
    const r = run(cwd, config, ran);

    const route = r.files.find((f) => f.path.includes('serwist'));
    expect(route?.written).toBe(true);
    expect(r.installed).toEqual(
      expect.arrayContaining(['serwist@^9.5.12', '@serwist/turbopack@^9.5.12', 'esbuild-wasm@^0.28.2']),
    );
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain('npm install');
    expect(ran[0]).toContain('@serwist/turbopack@');
    expect(ran[0]).toContain('esbuild-wasm@');
  });

  it('skips the route, without installing the build dependencies, when there is no App Router', () => {
    const cwd = project();
    const ran: string[] = [];
    const r = run(cwd, config, ran);

    expect(r.installed).toEqual(['serwist@^9.5.12']);
    expect(r.installed.some((p) => p.startsWith('@serwist/turbopack'))).toBe(false);
  });

  it('does not force the build dependencies when the project already declares them', () => {
    const cwd = project({ '@serwist/turbopack': '^9.0.0', 'esbuild-wasm': '^0.25.0' });
    mkdirSync(join(cwd, 'app'), { recursive: true });

    const ran: string[] = [];
    const r = run(cwd, config, ran);
    expect(r.installed).toEqual(['serwist@^9.5.12']);
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
  it('imports entities and the schema as same-directory siblings', () => {
    const cwd = project();
    run(cwd);
    const text = read(cwd, INIT_FILE);
    expect(text).toContain("from './entities'");
    expect(text).toContain("from './schema'");
    expect(text).toContain('tableColumnsFromSchema(AppSchema)');
  });

  it('keeps importing them as siblings regardless of the schema folder depth', () => {
    const cwd = project();
    run(cwd, {
      ...config,
      powersync: { ...config.powersync!, schemaFile: 'app/offline/schema.ts' },
    });
    const text = readFileSync(join(cwd, 'app/offline', INIT_FILE), 'utf8');
    expect(text).toContain("from './entities'");
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
