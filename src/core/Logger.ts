export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

const PREFIX = '[offline-sync]';

export class ConsoleLogger implements Logger {
  debug(msg: string, ctx?: LogContext): void {
    console.debug(`${PREFIX} ${msg}`, ctx ?? '');
  }
  info(msg: string, ctx?: LogContext): void {
    console.info(`${PREFIX} ${msg}`, ctx ?? '');
  }
  warn(msg: string, ctx?: LogContext): void {
    console.warn(`${PREFIX} ${msg}`, ctx ?? '');
  }
  error(msg: string, ctx?: LogContext): void {
    console.error(`${PREFIX} ${msg}`, ctx ?? '');
  }
}

export class SilentLogger implements Logger {
  debug(_msg: string, _ctx?: LogContext): void {}
  info(_msg: string, _ctx?: LogContext): void {}
  warn(_msg: string, _ctx?: LogContext): void {}
  error(_msg: string, _ctx?: LogContext): void {}
}

export const defaultLogger: Logger = new ConsoleLogger();
export const silentLogger: Logger = new SilentLogger();
