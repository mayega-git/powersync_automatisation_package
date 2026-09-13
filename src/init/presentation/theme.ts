import pc from 'picocolors';

/** Symbols carry the meaning; color is decoration only -- both stay correct with color off. */
export const SYMBOL = {
  success: '✓',
  warning: '⚠',
  blocked: '⚠',
  error: '✕',
  info: 'ℹ',
  pending: '○',
  running: '…',
} as const;

export interface Theme {
  color: boolean;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  info(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
  command(text: string): string;
}

/** `color` defaults to `isTTY && !NO_COLOR`, matching common CLI convention. */
export function detectColor(stdout: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return stdout.isTTY === true;
}

export function createTheme(color: boolean): Theme {
  const wrap = (fn: (s: string) => string) => (text: string) => (color ? fn(text) : text);
  return {
    color,
    success: wrap(pc.green),
    warning: wrap(pc.yellow),
    error: wrap(pc.red),
    info: wrap(pc.cyan),
    dim: wrap(pc.dim),
    bold: wrap(pc.bold),
    command: wrap((s) => pc.cyan(pc.bold(s))),
  };
}
