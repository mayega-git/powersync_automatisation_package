import type { AccessLocalDatabase } from './AccessLocalDatabase.js';
import type { HttpClient } from './HttpClient.js';
import type { HttpRequest } from './HttpRequest.js';
import type { SqlParams } from './SqlTranslator.js';

export type ResponseStatus = 'Success' | 'Fail';

export interface Response<T = unknown> {
  status: ResponseStatus;
  entity: T;
}

/** Handler for an `offline` operation: writes locally now, sent later. */
export interface Request {
  localWrite(db: AccessLocalDatabase, ctx: SqlParams): Promise<Response>;

  /**
   * Override: only needed when what must be sent to the server differs from
   * what the application sent. The module builds `ctx._metadata` itself by
   * default; the handler only has to write it as `:_metadata`.
   */
  constructMetadata?(ctx: SqlParams, req: HttpRequest): string;
}

/** Handler for an `online` operation: must succeed right away or fail. Never queued. */
export interface OnlineHandler {
  online(http: HttpClient, ctx: SqlParams): Promise<Response>;
}

/** The dispatcher picks a branch from `OperationMapping.connectivity`, never from the object's shape. */
export type Handler = Request | OnlineHandler;

export function isRequestHandler(handler: Handler): handler is Request {
  return typeof (handler as Request).localWrite === 'function';
}

export function isOnlineHandler(handler: Handler): handler is OnlineHandler {
  return typeof (handler as OnlineHandler).online === 'function';
}
