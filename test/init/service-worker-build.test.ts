import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  appRouterRoot,
  configureServiceWorkerBuild,
  PWA_BUNDLER_MARKER,
  writeServiceWorkerRoute,
} from '../../src/init/ServiceWorkerBuild.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'offline-sync-swbuild-'));
}

describe('configureServiceWorkerBuild', () => {
  it('says so, without touching anything, when no next.config is found', () => {
    const cwd = project();
    const { step, block } = configureServiceWorkerBuild(cwd);
    expect(step.state).toBe('manual');
    expect(step.detail).toBe('no next.config found');
    expect(block).toContain('withSerwist');
  });

  it('wraps a bare default export', () => {
    const cwd = project();
    writeFileSync(
      join(cwd, 'next.config.ts'),
      `import type { NextConfig } from 'next';\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`,
      'utf8',
    );

    const { step } = configureServiceWorkerBuild(cwd);
    expect(step.state).toBe('done');
    const text = readFileSync(join(cwd, 'next.config.ts'), 'utf8');
    expect(text).toContain("import { withSerwist } from '@serwist/turbopack';");
    expect(text).toContain('export default withSerwist(nextConfig);');
    expect(text).toContain(PWA_BUNDLER_MARKER);
  });

  it('composes with an export already wrapped by another plugin', () => {
    const cwd = project();
    writeFileSync(
      join(cwd, 'next.config.ts'),
      `const nextConfig = {};\n\nexport default withNextIntl(nextConfig);\n`,
      'utf8',
    );

    configureServiceWorkerBuild(cwd);
    const text = readFileSync(join(cwd, 'next.config.ts'), 'utf8');
    expect(text).toContain('export default withSerwist(withNextIntl(nextConfig));');
  });

  it('wraps module.exports too', () => {
    const cwd = project();
    writeFileSync(join(cwd, 'next.config.js'), `const nextConfig = {};\n\nmodule.exports = nextConfig;\n`, 'utf8');

    configureServiceWorkerBuild(cwd);
    const text = readFileSync(join(cwd, 'next.config.js'), 'utf8');
    expect(text).toContain('module.exports = withSerwist(nextConfig);');
  });

  it('never runs twice: the marker stops a second pass', () => {
    const cwd = project();
    writeFileSync(
      join(cwd, 'next.config.ts'),
      `// ${PWA_BUNDLER_MARKER}\nexport default withSerwist(nextConfig);\n`,
      'utf8',
    );

    const { step } = configureServiceWorkerBuild(cwd);
    expect(step.state).toBe('already-set');
  });
});

describe('appRouterRoot', () => {
  it('prefers src/app over app', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'src/app'), { recursive: true });
    mkdirSync(join(cwd, 'app'), { recursive: true });
    expect(appRouterRoot(cwd)).toBe('src/app');
  });

  it('falls back to app', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'app'), { recursive: true });
    expect(appRouterRoot(cwd)).toBe('app');
  });

  it('is undefined for a Pages Router project', () => {
    const cwd = project();
    expect(appRouterRoot(cwd)).toBeUndefined();
  });
});

describe('writeServiceWorkerRoute', () => {
  it('writes the route under the detected App Router root', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'app'), { recursive: true });

    const result = writeServiceWorkerRoute(cwd, 'app/services/offline/sw.ts');
    expect(result.written).toBe(true);
    expect(result.path).toBe(join('app', 'serwist', '[path]', 'route.ts'));
    const text = readFileSync(join(cwd, result.path), 'utf8');
    expect(text).toContain('createSerwistRoute');
    expect(text).toContain("swSrc: 'app/services/offline/sw.ts'");
  });

  it('says so, without writing, when there is no App Router', () => {
    const cwd = project();
    const result = writeServiceWorkerRoute(cwd, 'app/services/offline/sw.ts');
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/App Router/);
  });

  it('never overwrites one already there', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'app/serwist/[path]'), { recursive: true });
    writeFileSync(join(cwd, 'app/serwist/[path]/route.ts'), 'mine\n', 'utf8');

    const result = writeServiceWorkerRoute(cwd, 'app/services/offline/sw.ts');
    expect(result.written).toBe(false);
    expect(readFileSync(join(cwd, 'app/serwist/[path]/route.ts'), 'utf8')).toBe('mine\n');
  });
});
