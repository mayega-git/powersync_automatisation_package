import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ASSETS_DIR,
  BUNDLER_MARKER,
  ENGINE_PACKAGE,
  ENGINE_VERSION,
  setupPowerSync,
  URL_VARIABLE,
} from '../../src/init/PowerSyncSetup.js';

function project(manifest: Record<string, unknown> = {}): {
  cwd: string;
  ran: string[];
} {
  const cwd = mkdtempSync(join(tmpdir(), 'offline-sync-ps-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { cwd, ran: [] };
}

function run(cwd: string, ran: string[]) {
  return setupPowerSync({ cwd, run: (c) => ran.push(c) });
}

function step(r: ReturnType<typeof setupPowerSync>, name: string) {
  return r.steps.find((e) => e.name === name || e.name.includes(name));
}

const NEXT_CONFIG = `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
};

export default nextConfig;
`;

describe('installing the engine', () => {
  it('installs it when absent', () => {
    const { cwd, ran } = project();
    const r = run(cwd, ran);
    expect(ran[0]).toBe(`npm install ${ENGINE_PACKAGE}@${ENGINE_VERSION}`);
    expect(step(r, ENGINE_PACKAGE)?.state).toBe('done');
  });

  it('does nothing if the right version is already there', () => {
    const { cwd, ran } = project({ dependencies: { [ENGINE_PACKAGE]: ENGINE_VERSION } });
    const r = run(cwd, ran);
    expect(ran.some((c) => c.startsWith('npm install'))).toBe(false);
    expect(step(r, ENGINE_PACKAGE)?.state).toBe('already-set');
  });

  it('aligns a different version, saying why', () => {
    // Two engine versions produce two distinct local databases, and the
    // application sees an empty one with no error at all.
    const { cwd, ran } = project({ dependencies: { [ENGINE_PACKAGE]: '^1.0.0' } });
    const r = run(cwd, ran);
    expect(ran[0]).toContain(ENGINE_VERSION);
    expect(step(r, ENGINE_PACKAGE)?.detail).toMatch(/distinct local databases/);
  });
});

describe('the postinstall script', () => {
  it('adds it when there is none', () => {
    const { cwd, ran } = project();
    run(cwd, ran);
    const m = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    expect(m.scripts.postinstall).toBe('powersync-web copy-assets -o public');
  });

  it('never overwrites an existing postinstall: it chains after it', () => {
    const { cwd, ran } = project({ scripts: { postinstall: 'husky install' } });
    run(cwd, ran);
    const m = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    expect(m.scripts.postinstall).toBe('husky install && powersync-web copy-assets -o public');
  });

  it('is replayable without duplicating itself', () => {
    const { cwd, ran } = project();
    run(cwd, ran);
    const r = run(cwd, ran);
    const m = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    expect(m.scripts.postinstall).toBe('powersync-web copy-assets -o public');
    expect(step(r, 'postinstall script')?.state).toBe('already-set');
  });
});

describe('the workers', () => {
  it('drops them right away, without waiting for the next install', () => {
    const { cwd, ran } = project();
    run(cwd, ran);
    expect(ran).toContain('npx powersync-web copy-assets -o public');
  });

  it('does not redrop them if the folder exists', () => {
    const { cwd, ran } = project();
    mkdirSync(join(cwd, ASSETS_DIR), { recursive: true });
    const r = run(cwd, ran);
    expect(ran.some((c) => c.includes('copy-assets'))).toBe(false);
    expect(step(r, ASSETS_DIR)?.state).toBe('already-set');
  });

  it('has git ignore them: they are generated', () => {
    const { cwd, ran } = project();
    writeFileSync(join(cwd, '.gitignore'), 'node_modules\n', 'utf8');
    run(cwd, ran);
    expect(readFileSync(join(cwd, '.gitignore'), 'utf8')).toMatch(/public\/@powersync\/$/m);
  });
});

describe('the bundler setting', () => {
  it('inserts it into the configuration object', () => {
    const { cwd, ran } = project();
    writeFileSync(join(cwd, 'next.config.ts'), NEXT_CONFIG, 'utf8');
    const r = run(cwd, ran);

    const written = readFileSync(join(cwd, 'next.config.ts'), 'utf8');
    expect(written).toContain(BUNDLER_MARKER);
    expect(written).toContain('asyncWebAssembly: true');
    // What was there stays there, in its place.
    expect(written).toContain('remotePatterns');
    expect(written.indexOf('webpack:')).toBeLessThan(written.indexOf('export default'));
    expect(r.bundlerBlock).toBeUndefined();
  });

  it('is replayable: the marker prevents a second block', () => {
    const { cwd, ran } = project();
    writeFileSync(join(cwd, 'next.config.ts'), NEXT_CONFIG, 'utf8');
    run(cwd, ran);
    const r = run(cwd, ran);

    const written = readFileSync(join(cwd, 'next.config.ts'), 'utf8');
    expect(written.split(BUNDLER_MARKER)).toHaveLength(2);
    expect(step(r, 'next.config.ts')?.state).toBe('already-set');
  });

  it('does not touch an existing webpack setting, and returns the block to paste', () => {
    // It may do something else; merging it would require understanding its code.
    const { cwd, ran } = project();
    writeFileSync(
      join(cwd, 'next.config.ts'),
      'const c = {\n  webpack: (config) => config,\n};\nexport default c;\n',
      'utf8',
    );
    const r = run(cwd, ran);

    expect(readFileSync(join(cwd, 'next.config.ts'), 'utf8')).not.toContain(BUNDLER_MARKER);
    expect(step(r, 'next.config.ts')?.state).toBe('manual');
    expect(r.bundlerBlock).toContain('asyncWebAssembly');
  });

  it('does not corrupt a file whose shape is not recognized', () => {
    const { cwd, ran } = project();
    const weird = 'export default require("./elsewhere")(\n  { images: {} }\n);\n';
    writeFileSync(join(cwd, 'next.config.ts'), weird, 'utf8');
    const r = run(cwd, ran);

    expect(readFileSync(join(cwd, 'next.config.ts'), 'utf8')).toBe(weird);
    expect(step(r, 'next.config.ts')?.detail).toMatch(/not recognized/);
    expect(r.bundlerBlock).toBeDefined();
  });

  it('returns the block when there is no next.config at all', () => {
    const { cwd, ran } = project();
    const r = run(cwd, ran);
    expect(r.bundlerBlock).toBeDefined();
    expect(step(r, 'bundler configuration')?.state).toBe('manual');
  });
});

describe('the engine address', () => {
  it('declares it in the example, with no value', () => {
    const { cwd, ran } = project();
    writeFileSync(join(cwd, '.env.example'), 'ALREADY=1\n', 'utf8');
    run(cwd, ran);
    const written = readFileSync(join(cwd, '.env.example'), 'utf8');
    expect(written).toContain(`${URL_VARIABLE}=`);
    expect(written).toContain('ALREADY=1');
  });

  it('reports it when there is no example, rather than creating one', () => {
    const { cwd, ran } = project();
    const r = run(cwd, ran);
    expect(step(r, URL_VARIABLE)?.state).toBe('manual');
  });
});

describe('from the wrong directory', () => {
  it('refuses, saying where to stand', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'offline-sync-empty-'));
    expect(() => setupPowerSync({ cwd, run: () => {} })).toThrow(/ROOT/);
  });
});
