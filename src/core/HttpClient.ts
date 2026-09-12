export interface HttpClientRequest {
  method: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}

export interface HttpClientResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}

export interface HttpClient {
  /** Throws on a transport failure. A server response, including a 4xx/5xx, resolves normally. */
  send(req: HttpClientRequest): Promise<HttpClientResponse>;
}
