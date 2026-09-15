import { ConfigError, MISSING_POWERSYNC_BLOCK_MESSAGE } from '../ConfigLoader.js';
import { EntitiesError } from '../EntitiesFile.js';
import type { EntitiesCheckResult } from '../EntitiesChecker.js';
import { ADMIN_TOKEN_KEY, NO_TOKEN_MESSAGE, SECRETS_FILE } from '../SecretsFile.js';
import { URL_VARIABLE, type SetupResult, type Step } from '../PowerSyncSetup.js';
import type { SchemaResult } from '../SchemaCommand.js';
import { SchemaError } from '../ReplicatedSchema.js';
import type { ScaffoldResult } from '../ScaffoldCommand.js';
import { powerSyncStepsToFunctional } from './steps.js';
import type { CommandName, Detail, Outcome } from './types.js';

/** Every internal `Step`, verbatim, for --verbose. */
function stepDetails(result: SetupResult): Detail[] {
  const details = result.steps.map((s) => ({
    label: s.name,
    value: s.detail !== undefined ? `${s.state} -- ${s.detail}` : s.state,
  }));
  if (result.bundlerBlock !== undefined) {
    details.push({ label: 'Bundler block to paste', value: result.bundlerBlock });
  }
  for (const output of result.commandOutput ?? []) {
    details.push({ label: 'Command output', value: output });
  }
  return details;
}

/** Turns one manual internal `Step` into a phrased action, for the "What to do" list. */
function actionForStep(step: Step): string {
  if (step.name === URL_VARIABLE) {
    return 'Copy NEXT_PUBLIC_POWERSYNC_URL from .env.sync into your real env file (commonly .env.local)';
  }
  if (step.detail === 'no next.config found') {
    return `Create ${step.name} and paste the webpack block (see --verbose)`;
  }
  return `Paste the webpack block into ${step.name} (see --verbose)`;
}

export function toPowersyncOutcome(result: SetupResult): Outcome {
  const steps = powerSyncStepsToFunctional(result.steps);
  const manualInternal = result.steps.filter((s) => s.state === 'manual');

  if (manualInternal.length === 0) {
    return {
      state: 'success',
      command: 'powersync',
      headline: 'Synchronization engine installed',
      steps,
      nextCommand: 'offline-sync init',
      details: stepDetails(result),
    };
  }

  return {
    state: 'warning',
    command: 'powersync',
    headline: 'Synchronization engine installed, application not fully wired yet',
    steps,
    fix: { steps: manualInternal.map(actionForStep) },
    nextCommand: 'offline-sync powersync',
    details: stepDetails(result),
  };
}

export interface InitResult {
  configPath: string;
  secretsPath: string;
  secretsWritten: boolean;
  gitignoreUpdated: boolean;
}

export function toInitOutcome(result: InitResult): Outcome {
  return {
    state: 'success',
    command: 'init',
    headline: 'Offline Sync configuration created',
    summary: [
      '✓ Created offline-sync.config.yaml',
      result.secretsWritten ? '✓ Created .env.sync' : '✓ Existing .env.sync preserved',
      'Set powersync.adminUrl in offline-sync.config.yaml when ready to fetch a schema.',
    ],
    nextCommand: 'offline-sync schema',
    details: [
      { label: 'Config file', value: result.configPath },
      { label: 'Secrets file', value: result.secretsPath },
      { label: '.gitignore updated', value: String(result.gitignoreUpdated) },
    ],
  };
}

export function toSchemaOutcome(result: SchemaResult): Outcome {
  const reduced = result.schema.analyzedBy === 'local-reader';
  const bucketCount = result.buckets.length;

  const details: Detail[] = [
    { label: 'Source', value: result.schema.source },
    { label: 'Schema file', value: `${result.schemaFile} (generated -- do not edit)` },
    { label: 'Analyzed by', value: result.schema.analyzedBy ?? 'library' },
    ...result.schema.tables.map((t) => ({
      label: t.name,
      value: `${t.columns.length} column(s), buckets: ${t.buckets.join(', ') || '(none)'}`,
    })),
  ];
  if (reduced) {
    details.push({
      label: 'Reduced accuracy',
      value:
        'The reference library failed to load (it requires a newer Node); the ' +
        'local reader was used instead. Unusual query shapes may slip past it.',
    });
  }

  return {
    state: reduced ? 'warning' : 'success',
    command: 'schema',
    headline: `Schema fetched${reduced ? ' with reduced accuracy' : ''}: ${result.schema.tables.length} tables, ${bucketCount} buckets`,
    reason: reduced ? 'Some unusual query shapes may not have been detected.' : undefined,
    nextCommand: 'offline-sync entities',
    details,
  };
}

export function toScaffoldOutcome(result: ScaffoldResult): Outcome {
  return {
    state: 'success',
    command: 'scaffold',
    headline: 'Application wired to the engine',
    summary: [
      'Edit tokens.ts -- where this application gets its tokens from.',
      'init.ts is generated automatically; only tokens.ts needs your input.',
    ],
    nextCommand: 'offline-sync entities',
    details: result.files.map((f) => ({
      label: f.path,
      value: f.written ? 'written' : (f.reason ?? 'already exists'),
    })),
  };
}

export interface EntitiesResult {
  written: boolean;
  tableCount: number;
  missing: string[];
}

export function toEntitiesOutcome(result: EntitiesResult): Outcome {
  if (result.written) {
    return {
      state: 'success',
      command: 'entities',
      headline: 'Entity declaration created',
      summary: [`${result.tableCount} table(s) added, ready to fill in paths.`],
      nextCommand: 'offline-sync check-entities',
      details: [],
    };
  }

  if (result.missing.length === 0) {
    return {
      state: 'success',
      command: 'entities',
      headline: 'Entity declaration already exists',
      nextCommand: 'offline-sync check-entities',
      details: [],
    };
  }

  return {
    state: 'warning',
    command: 'entities',
    headline: 'Entity declaration is missing tables',
    reason:
      `${result.missing.length} replicated table(s) never appear in it. A missing ` +
      'table is never intercepted, and nothing says so at runtime.',
    fix: { file: 'offline-sync.entities.yaml', steps: result.missing.map((t) => `Add a path for "${t}"`) },
    nextCommand: 'offline-sync check-entities',
    details: [],
  };
}

export function toCheckEntitiesOutcome(result: EntitiesCheckResult): Outcome {
  if (result.ok) {
    return {
      state: 'success',
      command: 'check-entities',
      headline: 'Entity declaration is valid',
      summary: [`${result.tables.length} table(s), ${result.paths.length} path(s) confirmed.`],
      details: [],
    };
  }

  return {
    state: 'error',
    command: 'check-entities',
    headline: 'Entity declaration has problems',
    problem: `${result.errors.length} problem(s) found in the declaration.`,
    reason: result.errors.map((e) => `- ${e.subject}: ${e.message}`).join('\n'),
    fix: { file: 'offline-sync.entities.yaml', steps: ['Fix the issues listed above.'] },
    nextCommand: 'offline-sync check-entities',
    details: [],
  };
}

export interface ErrorContext {
  command: CommandName;
  nextCommand?: string;
}

/**
 * Every service still throws a plain `Error` subclass with a hand-written
 * message -- unchanged by this refactor (see the plan). This is the one
 * place that turns those into a structured `Outcome`, by type first, by a
 * couple of known messages second, and a generic fallback last -- so an
 * error type this function has never heard of still renders cleanly
 * instead of crashing the presenter.
 */
export function errorToOutcome(err: unknown, context: ErrorContext): Outcome {
  const nextCommand = context.nextCommand ?? `offline-sync ${context.command}`;

  if ((err instanceof ConfigError || err instanceof SchemaError) && err.message === MISSING_POWERSYNC_BLOCK_MESSAGE) {
    return {
      state: 'blocked',
      command: context.command,
      headline: 'Setup incomplete',
      reason:
        'Offline Sync needs to know where to reach the sync engine before it ' +
        'can ask it for tables.',
      fix: { file: 'offline-sync.config.yaml', key: 'powersync.adminUrl', steps: [] },
      nextCommand,
      resumable: true,
      details: [],
    };
  }

  if (err instanceof ConfigError) {
    return {
      state: 'blocked',
      command: context.command,
      headline: 'Setup incomplete',
      reason: err.message,
      fix: { file: 'offline-sync.config.yaml', steps: [] },
      nextCommand,
      resumable: true,
      details: [],
    };
  }

  if (err instanceof SchemaError) {
    if (err.message === NO_TOKEN_MESSAGE) {
      return {
        state: 'blocked',
        command: context.command,
        headline: 'Setup incomplete',
        reason:
          'Offline Sync needs an admin token to authenticate against the sync ' +
          'engine and download its schema. It is only read from .env.sync ' +
          '(gitignored), never from the tracked config file.',
        fix: { file: SECRETS_FILE, key: ADMIN_TOKEN_KEY, steps: [] },
        nextCommand,
        resumable: true,
        details: [],
      };
    }
    // A wrong/expired token is a refusal (401/403), not a missing one (that
    // case is handled above): it isn't in offline-sync.config.yaml either,
    // it's the PS_ADMIN_TOKEN value in .env.sync that doesn't match.
    if (err.message.includes('refused the token')) {
      return {
        state: 'blocked',
        command: context.command,
        headline: 'Setup incomplete',
        reason: err.message,
        fix: { file: SECRETS_FILE, key: ADMIN_TOKEN_KEY, steps: [] },
        nextCommand,
        resumable: true,
        details: [],
      };
    }

    return {
      state: 'blocked',
      command: context.command,
      headline: 'Unable to fetch the schema',
      reason: err.message,
      fix: { file: 'offline-sync.config.yaml', key: 'powersync.adminUrl', steps: [] },
      nextCommand,
      resumable: true,
      details: [],
    };
  }

  if (err instanceof EntitiesError) {
    return {
      state: 'blocked',
      command: context.command,
      headline: 'Entity declaration problem',
      reason: err.message,
      fix: { file: 'offline-sync.entities.yaml', steps: [] },
      nextCommand,
      resumable: true,
      details: [],
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    state: 'error',
    command: context.command,
    headline: `Unable to run "offline-sync ${context.command}"`,
    problem: 'Something unexpected happened.',
    reason: message,
    nextCommand,
    details: err instanceof Error && err.stack !== undefined ? [{ label: 'Stack', value: err.stack }] : [],
  };
}
