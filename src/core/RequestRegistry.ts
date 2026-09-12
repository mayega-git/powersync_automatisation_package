import type { Handler } from './Handler.js';

export class HandlerRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandlerRegistrationError';
  }
}

export class RequestRegistry {
  private readonly handlers = new Map<string, Handler>();

  register(name: string, handler: Handler): void {
    if (this.handlers.has(name)) {
      throw new HandlerRegistrationError(
        `Two handlers are registered under the name "${name}". Each name ` +
          'must be unique: the operations map uses it to find exactly one handler.',
      );
    }
    this.handlers.set(name, handler);
  }

  registerAll(handlers: Readonly<Record<string, Handler>>): void {
    for (const [name, handler] of Object.entries(handlers)) {
      this.register(name, handler);
    }
  }

  get(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  get size(): number {
    return this.handlers.size;
  }
}
