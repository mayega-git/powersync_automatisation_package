import type { Detail, FunctionalStep, Outcome } from './types.js';
import { createTheme, detectColor, SYMBOL, type Theme } from './theme.js';

export interface RenderOptions {
  verbose: boolean;
  color?: boolean;
}

function stepSymbol(state: FunctionalStep['state'], theme: Theme): string {
  switch (state) {
    case 'done':
    case 'already-set':
      return theme.success(SYMBOL.success);
    case 'manual':
      return theme.warning(SYMBOL.warning);
    case 'running':
      return theme.dim(SYMBOL.running);
    case 'pending':
      return theme.dim(SYMBOL.pending);
  }
}

export function renderProgress(steps: readonly FunctionalStep[], theme: Theme): string[] {
  const completed = steps.filter((s) => s.state === 'done' || s.state === 'already-set').length;
  const lines: string[] = [`Progress: ${completed}/${steps.length} steps completed`];

  for (const step of steps) {
    lines.push(`  ${stepSymbol(step.state, theme)} ${step.name}`);
    if (step.state === 'manual' && step.detail !== undefined) {
      for (const line of step.detail.split('\n')) lines.push(`      - ${line}`);
    }
  }
  return lines;
}

function renderFixSteps(fix: NonNullable<Outcome['fix']>): string[] {
  const lines: string[] = [];
  if (fix.file !== undefined) {
    lines.push('Edit:', `  ${fix.file}`, '');
  }
  if (fix.key !== undefined) {
    lines.push('Set:', `  ${fix.key}`, '');
  }
  lines.push('What to do');
  fix.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  return lines;
}

export function renderSuccess(outcome: Outcome, theme: Theme): string[] {
  const lines = [`${theme.success(SYMBOL.success)} ${outcome.headline}`];
  if (outcome.steps !== undefined && outcome.steps.length > 0) {
    lines.push('', ...renderProgress(outcome.steps, theme));
  }
  if (outcome.summary !== undefined && outcome.summary.length > 0) {
    lines.push('', ...outcome.summary);
  }
  if (outcome.nextCommand !== undefined) {
    lines.push('', 'Next:', `  $ ${theme.command(outcome.nextCommand)}`);
  }
  return lines;
}

export function renderBlocked(outcome: Outcome, theme: Theme): string[] {
  const symbol = outcome.state === 'error' ? theme.error(SYMBOL.error) : theme.warning(SYMBOL.warning);
  const lines = [`${symbol} ${outcome.headline}`];

  if (outcome.steps !== undefined && outcome.steps.length > 0) {
    lines.push('', ...renderProgress(outcome.steps, theme));
  }

  if (outcome.fix?.key !== undefined) {
    lines.push('', 'Missing configuration', `  ${outcome.fix.key}`);
  }

  if (outcome.reason !== undefined) {
    lines.push('', 'Why?', outcome.reason);
  }

  if (outcome.fix !== undefined) {
    lines.push('', ...renderFixSteps(outcome.fix));
    if (outcome.nextCommand !== undefined) {
      lines.push(`  ${outcome.fix.steps.length + 1}. Run:`, `     $ ${theme.command(outcome.nextCommand)}`);
    }
  } else if (outcome.nextCommand !== undefined) {
    lines.push('', 'Next:', `  $ ${theme.command(outcome.nextCommand)}`);
  }

  if (outcome.resumable === true) {
    lines.push('', 'Your progress has been saved -- this picks up exactly where it left off.');
  }

  return lines;
}

export function renderError(outcome: Outcome, theme: Theme): string[] {
  const lines = [`${theme.error(SYMBOL.error)} ${outcome.headline}`];

  if (outcome.problem !== undefined) lines.push('', 'Problem', `  ${outcome.problem}`);
  if (outcome.reason !== undefined) lines.push('', 'Reason', `  ${outcome.reason}`);
  if (outcome.fix !== undefined && outcome.fix.steps.length > 0) {
    lines.push('', 'How to fix');
    for (const step of outcome.fix.steps) lines.push(`  ${step}`);
  }
  if (outcome.nextCommand !== undefined) {
    lines.push('', 'Command', `  $ ${theme.command(outcome.nextCommand)}`);
  }
  return lines;
}

export function renderInfo(outcome: Outcome, theme: Theme): string[] {
  const lines = [`${theme.info(SYMBOL.info)} ${outcome.headline}`];
  if (outcome.summary !== undefined && outcome.summary.length > 0) {
    lines.push('', ...outcome.summary);
  }
  if (outcome.nextCommand !== undefined) {
    lines.push('', 'Next:', `  $ ${theme.command(outcome.nextCommand)}`);
  }
  return lines;
}

function renderDetails(details: readonly Detail[], theme: Theme): string[] {
  if (details.length === 0) return [];
  const width = Math.max(...details.map((d) => d.label.length));
  return [
    '',
    theme.dim('Details'),
    ...details.map((d) => theme.dim(`  ${d.label.padEnd(width)}   ${d.value}`)),
  ];
}

/** The one entry point: an `Outcome` becomes terminal lines, in normal or verbose form. */
export function renderOutcome(outcome: Outcome, options: RenderOptions): string[] {
  const theme = createTheme(options.color ?? detectColor());

  const lines =
    outcome.state === 'success'
      ? renderSuccess(outcome, theme)
      : outcome.state === 'info'
        ? renderInfo(outcome, theme)
        : outcome.state === 'error'
          ? renderError(outcome, theme)
          : renderBlocked(outcome, theme); // 'warning' and 'blocked' share the same template

  if (options.verbose) lines.push(...renderDetails(outcome.details, theme));

  return lines;
}
