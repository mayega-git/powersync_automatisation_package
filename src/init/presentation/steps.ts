import type { Step } from '../PowerSyncSetup.js';
import type { FunctionalStep } from './types.js';

/**
 * `setupPowerSync()` always pushes its six internal steps in this fixed
 * order (engine, postinstall, workers, gitignore, env var, bundler) -- see
 * `PowerSyncSetup.ts`. Grouped by position, not by name, because the
 * bundler step's name is the host's config filename, which varies.
 */
const INSTALL_GROUP = [0, 1, 2, 3];
const CONFIGURE_GROUP = [4, 5];

function aggregate(name: string, indices: number[], steps: readonly Step[]): FunctionalStep {
  const group = indices.map((i) => steps[i]).filter((s): s is Step => s !== undefined);
  const manual = group.filter((s) => s.state === 'manual');

  if (manual.length > 0) {
    return {
      name,
      state: 'manual',
      detail: manual.map((s) => `${s.name}: ${s.detail ?? 'needs your input'}`).join('\n'),
    };
  }

  const allAlreadySet = group.every((s) => s.state === 'already-set');
  return { name, state: allAlreadySet ? 'already-set' : 'done' };
}

/** The 6 internal `Step`s of `powersync` -> the 2 functional steps a user sees. */
export function powerSyncStepsToFunctional(steps: readonly Step[]): FunctionalStep[] {
  return [
    aggregate('Install synchronization engine', INSTALL_GROUP, steps),
    aggregate('Configure application to load it', CONFIGURE_GROUP, steps),
  ];
}
