import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

function files(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...files(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** Template literals are stripped before analysis: a schema-writer file's own generated code must not self-report. */
function imports(source: string): string[] {
  const withoutTemplates = source.replace(/`[^`]*`/g, '``');
  return [...withoutTemplates.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('the core / adapter boundary', () => {
  it('src/core knows no sync engine', () => {
    const offenders: string[] = [];

    for (const file of files(join(root, 'core'))) {
      for (const target of imports(readFileSync(file, 'utf8'))) {
        if (target.includes('powersync') || target.startsWith('@powersync/')) {
          offenders.push(`${file} imports ${target}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the main entry point names no engine', () => {
    // An application on a different engine imports "@ksm/offline-sync" and
    // must get nothing PowerSync-specific. The adapter has its own subpath:
    // "@ksm/offline-sync/powersync".
    const index = readFileSync(join(root, 'index.ts'), 'utf8');
    const offenders = imports(index).filter((c) => c.includes('powersync'));

    expect(offenders).toEqual([]);
  });

  it('the Initialization phase links no engine at compile time', () => {
    // `schema` needs the sync-rules-analysis library -- but ON DEMAND, never
    // as a static import. A static import would make it mandatory for
    // everyone, and the module would stop being a single npm package.
    const offenders: string[] = [];

    for (const file of files(join(root, 'init'))) {
      for (const target of imports(readFileSync(file, 'utf8'))) {
        if (target.startsWith('@powersync/')) {
          offenders.push(`${file} statically imports ${target}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('src/core does not know the PWA layer', () => {
    // Same rule, same reason: the core must run in a Node test, with no
    // Service Worker and no browser. The PWA depends on the core, not the other way.
    const offenders: string[] = [];

    for (const file of files(join(root, 'core'))) {
      for (const target of imports(readFileSync(file, 'utf8'))) {
        if (target.includes('/pwa/')) offenders.push(`${file} imports ${target}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the PWA layer names no framework and no cache library', () => {
    // The module hands out RULES, not files. The day it imported serwist,
    // workbox or next, it would stop installing anywhere else.
    const forbidden = ['serwist', 'workbox', 'next', 'react', '@powersync/'];
    const offenders: string[] = [];

    for (const file of files(join(root, 'pwa'))) {
      for (const target of imports(readFileSync(file, 'utf8'))) {
        if (target.startsWith('.')) continue;
        if (forbidden.some((name) => target === name || target.startsWith(name))) {
          offenders.push(`${file} imports ${target}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the main entry point does not name the PWA layer either', () => {
    // An application with no Service Worker imports "@ksm/offline-sync" and
    // must get none of that. The layer has its own subpath: "@ksm/offline-sync/pwa".
    const index = readFileSync(join(root, 'index.ts'), 'utf8');
    const offenders = imports(index).filter((c) => c.includes('/pwa/'));

    expect(offenders).toEqual([]);
  });

  it('the adapter is allowed to import the core', () => {
    // The allowed direction: the adapter implements the ports. This test
    // states the rule is one-directional, so it doesn't get tightened by
    // mistake later.
    const adapter = files(join(root, 'powersync'));
    const toCore = adapter.flatMap((f) =>
      imports(readFileSync(f, 'utf8')).filter((c) => c.includes('../core/')),
    );

    expect(toCore.length).toBeGreaterThan(0);
  });
});
