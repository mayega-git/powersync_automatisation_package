export interface CliOutput {
  log(message: string): void;
  error(message: string): void;
}

export const consoleOutput: CliOutput = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
};

/** The only place in this package that writes to the terminal. */
export function print(lines: readonly string[], out: CliOutput, toStderr = false): void {
  for (const line of lines) {
    if (toStderr) out.error(line);
    else out.log(line);
  }
}
