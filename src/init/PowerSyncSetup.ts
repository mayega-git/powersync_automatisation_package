import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The engine's package, browser side. */
export const ENGINE_PACKAGE = '@powersync/web';

/** The version this module is tested against; the command ALIGNS to it even if another is installed. */
export const ENGINE_VERSION = '^2.1.0';

/** Where the engine drops its workers, and where the browser loads them from. */
export const ASSETS_DIR = 'public/@powersync';

export const SCRIPT_POSTINSTALL = 'powersync-web copy-assets -o public';

/** Marker in the bundler config file, so a second run doesn't add a second block. */
export const BUNDLER_MARKER = 'offline-sync:engine';

/** Variable carrying the engine's address, browser side. */
export const URL_VARIABLE = 'NEXT_PUBLIC_POWERSYNC_URL';

export type StepState = 'done' | 'already-set' | 'manual';

export interface Step {
  name: string;
  state: StepState;
  detail?: string;
}

export interface SetupOptions {
  cwd: string;
  /** Overridable in tests: no `npm install` should run during a test suite. */
  run?: (command: string, cwd: string) => void;
}

export interface SetupResult {
  steps: Step[];
  /** The block to paste, when the bundler file couldn't be modified. */
  bundlerBlock?: string;
}

const defaultRun = (command: string, cwd: string): void => {
  execSync(command, { cwd, stdio: 'inherit' });
};

export function setupPowerSync(options: SetupOptions): SetupResult {
  const cwd = options.cwd;
  const run = options.run ?? defaultRun;
  const steps: Step[] = [];

  steps.push(installEngine(cwd, run));
  steps.push(addScript(cwd));
  steps.push(dropWorkers(cwd, run));
  steps.push(ignoreWorkers(cwd));
  steps.push(declareVariable(cwd));

  const bundler = configureBundler(cwd);
  steps.push(bundler.step);

  return bundler.block !== undefined
    ? { steps, bundlerBlock: bundler.block }
    : { steps };
}

function installEngine(
  cwd: string,
  run: (c: string, cwd: string) => void,
): Step {
  const manifest = readManifest(cwd);
  const installed = (manifest['dependencies'] as Record<string, string> | undefined)?.[
    ENGINE_PACKAGE
  ];

  if (installed === ENGINE_VERSION) {
    return { name: ENGINE_PACKAGE, state: 'already-set', detail: installed };
  }

  run(`npm install ${ENGINE_PACKAGE}@${ENGINE_VERSION}`, cwd);
  return {
    name: ENGINE_PACKAGE,
    state: 'done',
    detail:
      installed === undefined
        ? ENGINE_VERSION
        : `${installed} aligned to ${ENGINE_VERSION} -- two engine versions ` +
          'would produce two distinct local databases',
  };
}

function addScript(cwd: string): Step {
  const manifest = readManifest(cwd);
  const scripts = (manifest['scripts'] ?? {}) as Record<string, string>;
  const existing = scripts['postinstall'];

  if (existing !== undefined && existing.includes('copy-assets')) {
    return { name: 'postinstall script', state: 'already-set', detail: existing };
  }

  if (existing !== undefined) {
    scripts['postinstall'] = `${existing} && ${SCRIPT_POSTINSTALL}`;
  } else {
    scripts['postinstall'] = SCRIPT_POSTINSTALL;
  }

  manifest['scripts'] = scripts;
  writeManifest(cwd, manifest);
  return { name: 'postinstall script', state: 'done', detail: scripts['postinstall'] };
}

function dropWorkers(
  cwd: string,
  run: (c: string, cwd: string) => void,
): Step {
  if (existsSync(join(cwd, ASSETS_DIR))) {
    return { name: ASSETS_DIR, state: 'already-set' };
  }
  run(`npx ${SCRIPT_POSTINSTALL}`, cwd);
  return { name: ASSETS_DIR, state: 'done' };
}

/** Exported: both `powersync` (generated workers) and `init` (secrets file) need it. */
export function addToGitignore(cwd: string, line: string, comment: string): Step {
  const path = join(cwd, '.gitignore');
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';

  if (content.split('\n').some((l) => l.trim() === line)) {
    return { name: '.gitignore', state: 'already-set', detail: line };
  }

  writeFileSync(
    path,
    content.replace(/\n*$/, '') + `\n# ${comment}\n${line}\n`,
    'utf8',
  );
  return { name: '.gitignore', state: 'done', detail: line };
}

function ignoreWorkers(cwd: string): Step {
  return addToGitignore(
    cwd,
    `${ASSETS_DIR}/`,
    'Sync engine workers, redropped on every install',
  );
}

/** Declares the variable in the environment EXAMPLE, not the real file, which holds real values. */
function declareVariable(cwd: string): Step {
  const path = join(cwd, '.env.example');
  if (!existsSync(path)) {
    return {
      name: URL_VARIABLE,
      state: 'manual',
      detail: 'no .env.example in this project',
    };
  }

  const content = readFileSync(path, 'utf8');
  if (content.includes(URL_VARIABLE)) {
    return { name: URL_VARIABLE, state: 'already-set' };
  }

  const addition =
    `\n# Sync engine address, read by the browser.\n` +
    `${URL_VARIABLE}=\n`;
  writeFileSync(path, content.replace(/\n*$/, '') + addition, 'utf8');
  return { name: URL_VARIABLE, state: 'done' };
}

export const BUNDLER_BLOCK = `  // ${BUNDLER_MARKER} -- the engine runs on WASM and Web Workers.
  webpack: (config, { isServer }) => {
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    if (!isServer) config.module.rules.push({ test: /\\.wasm$/, type: 'asset/resource' });
    return config;
  },`;

/**
 * The only place this command modifies a file written by the developer, and
 * it follows three rules: a marker so it never rewrites twice; an existing
 * `webpack:` block is left untouched; an unrecognized shape isn't forced --
 * the block is handed back to the caller to paste by hand.
 */
function configureBundler(cwd: string): { step: Step; block?: string } {
  const path = ['next.config.ts', 'next.config.mjs', 'next.config.js']
    .map((n) => join(cwd, n))
    .find((p) => existsSync(p));

  if (path === undefined) {
    return {
      step: {
        name: 'bundler configuration',
        state: 'manual',
        detail: 'no next.config found',
      },
      block: BUNDLER_BLOCK,
    };
  }

  const content = readFileSync(path, 'utf8');
  const name = path.split('/').pop() ?? path;

  if (content.includes(BUNDLER_MARKER)) {
    return { step: { name, state: 'already-set' } };
  }

  if (/\bwebpack\s*:/.test(content)) {
    return {
      step: {
        name,
        state: 'manual',
        detail: 'a webpack setting already exists -- not touched',
      },
      block: BUNDLER_BLOCK,
    };
  }

  const opening =
    /^(?:(?:const|let|var)\s+\w+(?:\s*:\s*[\w.<>[\]]+)?\s*=|module\.exports\s*=|export\s+default)\s*\{[ \t]*$/m.exec(
      content,
    );

  if (opening === null || opening.index === undefined) {
    return {
      step: {
        name,
        state: 'manual',
        detail: "file shape not recognized -- nothing was modified",
      },
      block: BUNDLER_BLOCK,
    };
  }

  const end = opening.index + opening[0].length;
  const modified = content.slice(0, end) + '\n' + BUNDLER_BLOCK + content.slice(end);
  writeFileSync(path, modified, 'utf8');
  return { step: { name, state: 'done' } };
}

function readManifest(cwd: string): Record<string, unknown> {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) {
    throw new Error(
      `No package.json in ${cwd}. Run this command from the ROOT of the ` +
        "application project, not from the module's folder.",
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeManifest(cwd: string, manifest: Record<string, unknown>): void {
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  );
}
