import type { HttpClientResponse } from './HttpClient.js';

export type ClassifiedErrorKind =
  | 'retry'
  | 'reject'
  /** Session expired while offline: keep the queue intact and ask the user to sign in again. */
  | 'reauth';

export class ClassifiedError extends Error {
  readonly kind: ClassifiedErrorKind;
  readonly response?: HttpClientResponse;

  constructor(
    kind: ClassifiedErrorKind,
    reason: string,
    options: { response?: HttpClientResponse; cause?: unknown } = {},
  ) {
    super(reason, { cause: options.cause });
    this.name = 'ClassifiedError';
    this.kind = kind;
    if (options.response !== undefined) this.response = options.response;
  }

  get reason(): string {
    return this.message;
  }
}

/** Lets a host override how an HTTP status maps to a `ClassifiedErrorKind`. Return `undefined` to fall back to the default rules. */
export type StatusClassifier = (
  response: HttpClientResponse,
) => ClassifiedErrorKind | undefined;

function isReauthStatus(status: number): boolean {
  return status === 401;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultClassify(status: number): ClassifiedErrorKind {
  if (isReauthStatus(status)) return 'reauth';
  if (isRetryableStatus(status)) return 'retry';
  return 'reject';
}

export function classify(
  err: unknown,
  response?: HttpClientResponse,
  customClassify?: StatusClassifier,
): ClassifiedError {
  if (err instanceof ClassifiedError) return err;

  if (response !== undefined) {
    const kind = customClassify?.(response) ?? defaultClassify(response.status);
    return new ClassifiedError(
      kind,
      kind === 'reauth'
        ? 'The server returned 401: the session expired while offline. Nothing is lost; sign in again.'
        : `The server returned ${response.status}.`,
      { response, cause: err },
    );
  }

  return new ClassifiedError(
    'retry',
    err instanceof Error ? err.message : 'The request did not complete.',
    { cause: err },
  );
}
