export interface HttpRequest {
  method: string;
  /** Absolute or relative; includes the query string. */
  url: string;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
}
