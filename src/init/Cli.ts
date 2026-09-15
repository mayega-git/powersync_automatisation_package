import { dirname, isAbsolute, join } from 'node:path';

import { ConfigError, loadConfig, MISSING_POWERSYNC_BLOCK_MESSAGE, writeConfigTemplate } from './ConfigLoader.js';
import { checkEntities } from './EntitiesChecker.js';
import { loadEntities, writeEntitiesModule, writeEntitiesTemplate } from './EntitiesFile.js';
import { readSchemaFile, SCHEMA_FILE, SchemaError } from './ReplicatedSchema.js';
import { generateSchema, type SchemaOptions, type SchemaResult } from './SchemaCommand.js';
import {
  addToGitignore,
  setupPowerSync,
  type SetupOptions,
  type SetupResult,
} from './PowerSyncSetup.js';
import { NO_TOKEN_MESSAGE, resolveAdminToken, SECRETS_FILE, writeSecretsTemplate } from './SecretsFile.js';
import { scaffold, type ScaffoldOptions, type ScaffoldResult } from './ScaffoldCommand.js';
import type { SyncConfig } from './types.js';
import { consoleOutput, print, type CliOutput } from './presentation/printer.js';
import { renderOutcome } from './presentation/render.js';
import { powerSyncStepsToFunctional } from './presentation/steps.js';
import type { FunctionalStep, Outcome } from './presentation/types.js';
import {
  errorToOutcome,
  toCheckEntitiesOutcome,
  toEntitiesOutcome,
  toInitOutcome,
  toPowersyncOutcome,
  toScaffoldOutcome,
  toSchemaOutcome,
  type InitResult,
} from './presentation/outcomes.js';

export type { CliOutput };

/** Next to the schema: both generated, never touched by hand, imported by the same wiring. */
function modulePath(cwd: string, schemaFile: string): string {
  const dir = dirname(isAbsolute(schemaFile) ? schemaFile : join(cwd, schemaFile));
  return join(dir, 'entities.ts');
}

/** Shared by the standalone `init` command and the `setup` chain. */
function runInit(cwd: string): InitResult {
  const configPath = writeConfigTemplate(cwd); // throws ConfigError if the file already exists
  const secrets = writeSecretsTemplate(cwd);
  const ignore = addToGitignore(cwd, SECRETS_FILE, 'Secrets for @ksm/offline-sync -- never commit');
  return {
    configPath,
    secretsPath: secrets.path,
    secretsWritten: secrets.written,
    gitignoreUpdated: ignore.state === 'done',
  };
}

function runEntities(cwd: string, path?: string): Outcome {
  const config = loadConfig(cwd);
  const schemaFile = config.powersync?.schemaFile ?? SCHEMA_FILE;
  const schema = readSchemaFile(cwd, schemaFile);

  if (schema === undefined) {
    throw new ConfigError(
      `${schemaFile} was not found: without it there's no way to know which ` +
        'tables the engine replicates, and the template would be empty. Run ' +
        '"offline-sync schema" first.',
    );
  }

  const r = writeEntitiesTemplate(cwd, schema, path);

  if (!r.written) {
    writeEntitiesModule(loadEntities(cwd, path), modulePath(cwd, schemaFile), new Date().toISOString());
  }

  return toEntitiesOutcome({ written: r.written, tableCount: schema.tables.length, missing: r.missing });
}

function runCheckEntities(cwd: string, path?: string): Outcome {
  const config = loadConfig(cwd);
  const schemaFile = config.powersync?.schemaFile ?? SCHEMA_FILE;
  const declaration = loadEntities(cwd, path);

  const r = checkEntities({ declaration, schema: readSchemaFile(cwd, schemaFile) });
  writeEntitiesModule(declaration, modulePath(cwd, schemaFile), new Date().toISOString());

  return toCheckEntitiesOutcome(r);
}

export interface ChainOptions {
  cwd: string;
  loadConfigFn?: (cwd: string) => SyncConfig;
  run?: (command: string, cwd: string) => void;
  fetchSchemaFn?: SchemaOptions['fetchSchemaFn'];
  token?: string;
}

const CHAIN_STEP_NAMES = [
  'Install synchronization engine',
  'Configure application',
  'Fetch schema from the sync engine',
  'Wire the application to it',
] as const;

function pendingChainSteps(): FunctionalStep[] {
  return CHAIN_STEP_NAMES.map((name) => ({ name, state: 'pending' }));
}

/** Exported for tests: builds the same `Outcome` `Cli.run(['setup'], ...)` renders, with every service call injectable. */
export async function runSetup(options: ChainOptions): Promise<Outcome> {
  const cwd = options.cwd;
  const steps = pendingChainSteps();

  let powersyncResult: SetupResult;
  try {
    powersyncResult = setupPowerSync({
      cwd,
      ...(options.run !== undefined ? { run: options.run } : {}),
    });
  } catch (err) {
    return { ...errorToOutcome(err, { command: 'setup', nextCommand: 'offline-sync setup' }), steps };
  }

  const powersyncFunctional = powerSyncStepsToFunctional(powersyncResult.steps);
  const powersyncManual = powersyncFunctional.filter((s) => s.state === 'manual');
  steps[0] = {
    name: CHAIN_STEP_NAMES[0],
    state: powersyncManual.length > 0 ? 'manual' : 'done',
    ...(powersyncManual.length > 0
      ? { detail: powersyncManual.flatMap((s) => (s.detail ?? '').split('\n')).join('\n') }
      : {}),
  };

  try {
    runInit(cwd);
  } catch (err) {
    if (!(err instanceof ConfigError)) {
      return { ...errorToOutcome(err, { command: 'setup', nextCommand: 'offline-sync setup' }), steps };
    }
    // Already exists: not a failure, the chain proceeds with what's there.
  }
  steps[1] = { name: CHAIN_STEP_NAMES[1], state: 'done' };

  let config: SyncConfig;
  try {
    config = (options.loadConfigFn ?? loadConfig)(cwd);
  } catch (err) {
    return { ...errorToOutcome(err, { command: 'setup', nextCommand: 'offline-sync setup' }), steps };
  }

  if (config.powersync === undefined) {
    const missingPowersync = new ConfigError(MISSING_POWERSYNC_BLOCK_MESSAGE);
    return { ...errorToOutcome(missingPowersync, { command: 'setup', nextCommand: 'offline-sync setup' }), steps };
  }

  const token = resolveAdminToken(cwd, options.token);
  if (token === undefined) {
    return {
      ...errorToOutcome(new SchemaError(NO_TOKEN_MESSAGE), { command: 'setup', nextCommand: 'offline-sync setup' }),
      steps,
    };
  }

  let schemaResult: SchemaResult;
  try {
    schemaResult = await generateSchema({
      cwd,
      ...(options.loadConfigFn !== undefined ? { loadConfigFn: options.loadConfigFn } : {}),
      ...(options.fetchSchemaFn !== undefined ? { fetchSchemaFn: options.fetchSchemaFn } : {}),
      token,
    });
  } catch (err) {
    return { ...errorToOutcome(err, { command: 'setup', nextCommand: 'offline-sync setup' }), steps };
  }
  steps[2] = { name: CHAIN_STEP_NAMES[2], state: 'done' };

  const scaffoldResult = scaffold({
    cwd,
    ...(options.loadConfigFn !== undefined ? { loadConfigFn: options.loadConfigFn } : {}),
  });
  steps[3] = { name: CHAIN_STEP_NAMES[3], state: 'done' };

  const schemaDetails = toSchemaOutcome(schemaResult).details;
  const scaffoldDetails = toScaffoldOutcome(scaffoldResult).details;

  return {
    state: 'success',
    command: 'setup',
    headline: 'Setup complete',
    steps,
    summary: ['Edit tokens.ts -- where this application gets its tokens from.'],
    nextCommand: 'offline-sync entities',
    details: [...schemaDetails, ...scaffoldDetails],
  };
}

export interface RunOptions {
  verbose?: boolean;
  color?: boolean;
}

export class Cli {
  constructor(private readonly out: CliOutput = consoleOutput) {}

  async run(argv: readonly string[], cwd: string = process.cwd(), options: RunOptions = {}): Promise<number> {
    const command = argv[0];
    const renderOpts = { verbose: options.verbose ?? false, ...(options.color !== undefined ? { color: options.color } : {}) };

    let outcome: Outcome;
    try {
      outcome = await this.build(command, argv, cwd);
    } catch (err) {
      outcome = errorToOutcome(err, {
        command: (command as Outcome['command']) ?? 'setup',
      });
    }

    const toStderr = outcome.state === 'error' || outcome.state === 'blocked';
    print(renderOutcome(outcome, renderOpts), this.out, toStderr);

    return outcome.state === 'error' || outcome.state === 'blocked' ? 1 : 0;
  }

  private async build(command: string | undefined, argv: readonly string[], cwd: string): Promise<Outcome> {
    switch (command) {
      case 'init':
        return toInitOutcome(runInit(cwd));
      case 'setup':
        return runSetup({ cwd });
      case 'powersync': {
        const options: SetupOptions = { cwd };
        return toPowersyncOutcome(setupPowerSync(options));
      }
      case 'schema':
        return toSchemaOutcome(await generateSchema({ cwd }));
      case 'scaffold':
        return toScaffoldOutcome(scaffold({ cwd }));
      case 'entities':
        return runEntities(cwd);
      case 'check-entities':
        return runCheckEntities(cwd);
      default:
        return {
          state: 'error',
          command: 'setup',
          headline: command === undefined ? 'No command given' : `Unknown command: "${command}"`,
          problem: 'Expected one of: setup, powersync, init, schema, scaffold, entities, check-entities.',
          nextCommand: 'offline-sync setup',
          details: [{ label: 'argv', value: argv.join(' ') }],
        };
    }
  }
}
