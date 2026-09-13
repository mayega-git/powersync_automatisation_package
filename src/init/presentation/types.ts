/** One of six user-facing states. Everything the CLI shows reduces to one of these. */
export type OutcomeState = 'success' | 'warning' | 'blocked' | 'error' | 'info';

export type CommandName =
  | 'init'
  | 'powersync'
  | 'schema'
  | 'scaffold'
  | 'entites'
  | 'check-entites'
  | 'setup';

/** State of one user-meaningful step, never a 1:1 mirror of an internal operation. */
export interface FunctionalStep {
  name: string;
  state: 'done' | 'already-set' | 'manual' | 'pending' | 'running';
  /** Shown inline when `state === 'manual'`, and always in --verbose. */
  detail?: string;
}

/** Only rendered under --verbose: paths, raw command output, versions, internal URLs. */
export interface Detail {
  label: string;
  value: string;
}

/**
 * The single shape that crosses the command/presenter boundary. Every
 * command reduces to the same rendering grammar: optional progress, then a
 * success/warning/blocked/error message, then a next action. No terminal
 * concept (color, ANSI, line width) belongs here.
 */
export interface Outcome {
  state: OutcomeState;
  command: CommandName;
  /** One line, always present. */
  headline: string;
  /** Present for multi-step commands (powersync, setup). */
  steps?: FunctionalStep[];
  /** 1-3 short lines for a success/info screen. */
  summary?: string[];
  /** BLOCKED/ERROR: WHAT. */
  problem?: string;
  /** BLOCKED/ERROR: WHY. */
  reason?: string;
  /** BLOCKED/ERROR: HOW. File and key come before the command, in that order. */
  fix?: { file?: string; key?: string; steps: string[] };
  /** Copy-pasteable, e.g. "offline-sync schema". */
  nextCommand?: string;
  /** True when a BLOCKED outcome can be resumed by re-running the same command. */
  resumable?: boolean;
  details: Detail[];
}
