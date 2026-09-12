import type { ClassifiedError } from './ClassifiedError.js';
import type { Logger } from './Logger.js';

export interface ErrorContext {
  operationId: string;
  entryId: string;
  payload: string;
  error: ClassifiedError;
}

export type ErrorHandler = (ctx: ErrorContext) => Promise<void>;

export class ErrorHandlerRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErrorHandlerRegistrationError';
  }
}

export interface ErrorHandlerRegistryOptions {
  logger: Logger;
}

export class ErrorHandlerRegistry {
  private readonly handlers = new Map<string, ErrorHandler>();
  private readonly logger: Logger;

  constructor(options: ErrorHandlerRegistryOptions) {
    this.logger = options.logger;
  }

  register(name: string, handler: ErrorHandler): void {
    if (this.handlers.has(name)) {
      throw new ErrorHandlerRegistrationError(
        `Two error handlers are registered under the name "${name}".`,
      );
    }
    this.handlers.set(name, handler);
  }

  registerAll(handlers: Readonly<Record<string, ErrorHandler>>): void {
    for (const [name, handler] of Object.entries(handlers)) {
      this.register(name, handler);
    }
  }

  get(name: string): ErrorHandler | undefined {
    return this.handlers.get(name);
  }

  getHandler(operationId: string): ErrorHandler {
    return this.handlers.get(operationId) ?? this.defaultHandler();
  }

  /** Never lets the handler's own exception escape: a bug here must not stall the whole queue. */
  async apply(ctx: ErrorContext): Promise<void> {
    try {
      await this.getHandler(ctx.operationId)(ctx);
    } catch (err) {
      this.logger.error('the error handler itself failed, ignoring it', {
        operationId: ctx.operationId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  get size(): number {
    return this.handlers.size;
  }

  private defaultHandler(): ErrorHandler {
    return async (ctx: ErrorContext): Promise<void> => {
      this.logger.warn('no handler declared for this operation, failure only recorded', {
        operationId: ctx.operationId,
        entryId: ctx.entryId,
        reason: ctx.error.reason,
      });
    };
  }
}
