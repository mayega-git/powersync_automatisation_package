import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/init/ConfigLoader.js';
import { SchemaError } from '../../src/init/ReplicatedSchema.js';
import { NO_TOKEN_MESSAGE } from '../../src/init/SecretsFile.js';
import { errorToOutcome } from '../../src/init/presentation/outcomes.js';

describe('errorToOutcome -- schema errors', () => {
  it('points to .env.sync when there is no token at all', () => {
    const outcome = errorToOutcome(new SchemaError(NO_TOKEN_MESSAGE), { command: 'setup' });
    expect(outcome.fix).toMatchObject({ file: '.env.sync', key: 'PS_ADMIN_TOKEN' });
  });

  it('points to .env.sync, not offline-sync.config.yaml, when the engine refuses the token (401/403)', () => {
    // Regression: this case used to fall into the generic branch and wrongly
    // told the user to edit offline-sync.config.yaml -- the token lives in
    // .env.sync, this file has nothing to do with the problem.
    const err = new SchemaError(
      'The engine\'s admin API refused the token (401). Check that PS_ADMIN_TOKEN ' +
        'matches one of the values declared under "api.tokens" in the engine\'s configuration.',
    );
    const outcome = errorToOutcome(err, { command: 'setup' });
    expect(outcome.fix).toMatchObject({ file: '.env.sync', key: 'PS_ADMIN_TOKEN' });
  });

  it('still points to the config file for a genuinely different schema problem', () => {
    const outcome = errorToOutcome(new SchemaError("The engine's admin API returned 500 on /schema."), {
      command: 'setup',
    });
    expect(outcome.fix?.file).toBe('offline-sync.config.yaml');
  });
});

describe('errorToOutcome -- config errors', () => {
  it('names the missing key for a missing powersync block', () => {
    const outcome = errorToOutcome(
      new ConfigError(
        'The "powersync" block is missing from the configuration. Set at least ' +
          "powersync.adminUrl -- the sync engine's admin API URL. Without it, " +
          'there is nobody to ask for the tables.',
      ),
      { command: 'setup' },
    );
    expect(outcome.fix).toMatchObject({ file: 'offline-sync.config.yaml', key: 'powersync.adminUrl' });
  });
});

describe('errorToOutcome -- unknown errors', () => {
  it('never crashes, and never leaks a raw stack outside details', () => {
    const outcome = errorToOutcome(new Error('boom'), { command: 'schema' });
    expect(outcome.state).toBe('error');
    expect(outcome.reason).toBe('boom');
  });
});
