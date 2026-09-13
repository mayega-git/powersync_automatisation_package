import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runSetup } from '../../src/init/Cli.js';
import type { SyncConfig } from '../../src/init/types.js';
import type { ReplicatedSchema } from '../../src/init/ReplicatedSchema.js';

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'offline-sync-cli-setup-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'app', version: '0.0.0' }), 'utf8');
  return cwd;
}

const CONFIG: SyncConfig = {
  powersync: {
    adminUrl: 'https://engine.test',
    buckets: [],
    schemaFile: 'schema.ts',
  },
};

const SCHEMA: ReplicatedSchema = {
  source: CONFIG.powersync!.adminUrl,
  tables: [{ name: 'tag_entity', columns: [{ name: 'name', type: 'text' }], buckets: [] }],
};

describe('runSetup -- the chain behind "offline-sync setup"', () => {
  it('reflects a real manual remainder from powersync, instead of always reporting it done', async () => {
    // Regression test: setup() used to discard PowerSyncSetup's own
    // SetupResult and hardcode { name: 'powersync', state: 'done' }, even
    // when real manual steps (env variable, bundler config) were left
    // outstanding. On a fresh project, neither .env.sync nor next.config.*
    // exist yet, so both remain manual -- the chain must say so.
    const cwd = project();

    const outcome = await runSetup({
      cwd,
      run: () => {}, // no real npm install in a test
      loadConfigFn: () => CONFIG,
      token: 'test-token',
      fetchSchemaFn: async () => SCHEMA,
    });

    expect(outcome.state).toBe('success');
    expect(outcome.steps?.[0]).toMatchObject({
      name: 'Install synchronization engine',
      state: 'manual',
    });
  });

  it('reports the install step done when nothing is left manual', async () => {
    const cwd = project();
    // Pre-fill what powersync would otherwise leave manual, so this run has
    // nothing outstanding.
    writeFileSync(join(cwd, '.env.sync'), 'NEXT_PUBLIC_POWERSYNC_URL=https://engine.test\n', 'utf8');
    writeFileSync(
      join(cwd, 'next.config.ts'),
      'const c = {\n  // offline-sync:engine\n};\nexport default c;\n',
      'utf8',
    );

    const outcome = await runSetup({
      cwd,
      run: () => {},
      loadConfigFn: () => CONFIG,
      token: 'test-token',
      fetchSchemaFn: async () => SCHEMA,
    });

    expect(outcome.steps?.[0]).toMatchObject({
      name: 'Install synchronization engine',
      state: 'done',
    });
  });

  it('stops before schema, keeping the steps already done, when powersync.adminUrl is missing', async () => {
    const cwd = project();

    const outcome = await runSetup({
      cwd,
      run: () => {},
      loadConfigFn: () => ({}),
    });

    expect(outcome.state).toBe('blocked');
    expect(outcome.steps?.[1]).toMatchObject({ name: 'Configure application', state: 'done' });
    expect(outcome.steps?.[2]).toMatchObject({ name: 'Fetch schema from the sync engine', state: 'pending' });
    expect(outcome.resumable).toBe(true);
  });
});
