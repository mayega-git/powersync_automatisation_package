import type { AccessLocalDatabase } from './AccessLocalDatabase.js';
import { classify, ClassifiedError } from './ClassifiedError.js';
import type { ComposedOperations } from './ComposedOperations.js';
import type { Converter } from './Converter.js';
import { DuplicateGuard } from './DuplicateGuard.js';
import { isOnlineHandler, isRequestHandler, type Response } from './Handler.js';
import type { HttpClient } from './HttpClient.js';
import type { HttpRequest } from './HttpRequest.js';
import type { Logger } from './Logger.js';
import type { RequestRegistry } from './RequestRegistry.js';
import { serialiseWriteMetadata } from './WriteMetadataBuilder.js';

/** Configuration defect: the operations map and the handlers file disagree. */
export class HandlerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandlerMismatchError';
  }
}

export interface InterceptorOptions {
  converter: Converter;
  requests: RequestRegistry;
  db: AccessLocalDatabase;
  http: HttpClient;
  logger: Logger;
  duplicates?: DuplicateGuard;
  /** Optional: SQL composed from the table declaration, instead of a hand-written handler. */
  composed?: ComposedOperations;
}

export class Interceptor {
  private readonly converter: Converter;
  private readonly requests: RequestRegistry;
  private readonly db: AccessLocalDatabase;
  private readonly http: HttpClient;
  private readonly logger: Logger;
  private readonly duplicates: DuplicateGuard;
  private readonly composed: ComposedOperations | undefined;

  constructor(options: InterceptorOptions) {
    this.converter = options.converter;
    this.requests = options.requests;
    this.db = options.db;
    this.http = options.http;
    this.logger = options.logger;
    this.duplicates = options.duplicates ?? new DuplicateGuard();
    this.composed = options.composed;
  }

  async interceptRequest(req: HttpRequest): Promise<Response> {
    this.logger.debug('request intercepted', { method: req.method, url: req.url });

    const resolved = this.converter.resolve(req);

    if (resolved === undefined && this.composed !== undefined) {
      const entity = this.composed.resolve(req);
      if (entity !== undefined) {
        const already = this.duplicates.findRecent(req);
        if (already !== undefined) {
          this.logger.warn('identical call already handled, returning the previous response', {
            table: entity.table,
          });
          return already;
        }
        const response = await this.composed.run(this.db, req, entity);
        this.duplicates.remember(req, response);
        return response;
      }
    }

    if (resolved === undefined) {
      this.logger.debug('no operation declared, the request goes to the server', {
        method: req.method,
        url: req.url,
      });
      return this.passThrough(req);
    }

    const { operation, pathParams } = resolved;

    const already = this.duplicates.findRecent(req, operation.dedupWindowMs);
    if (already !== undefined) {
      this.logger.warn('identical call already handled, returning the previous response', {
        operationId: operation.operationId,
      });
      return already;
    }

    const ctx = this.converter.extractParams(req, pathParams);
    const handler = this.requests.get(operation.handle);

    if (handler === undefined) {
      throw new HandlerMismatchError(
        `The operations map designates handler "${operation.handle}" for ` +
          `${operation.operationId}, but no handler of that name was ` +
          `registered. Known handlers: ${this.requests.names().join(', ') || '(none)'}.`,
      );
    }

    if (operation.connectivity === 'offline') {
      if (!isRequestHandler(handler)) {
        throw new HandlerMismatchError(
          `Operation ${operation.operationId} is declared "offline" but its ` +
            `handler "${operation.handle}" doesn't write to the local database.`,
        );
      }

      ctx['_metadata'] =
        handler.constructMetadata?.(ctx, req) ??
        serialiseWriteMetadata(req, operation);

      const response = await handler.localWrite(this.db, ctx);
      this.logger.info('local write done, waiting to be sent', {
        operationId: operation.operationId,
      });
      this.duplicates.remember(req, response);
      return response;
    }

    if (!isOnlineHandler(handler)) {
      throw new HandlerMismatchError(
        `Operation ${operation.operationId} is declared "online" but its ` +
          `handler "${operation.handle}" doesn't call the network.`,
      );
    }

    try {
      const response = await handler.online(this.http, ctx);
      this.duplicates.remember(req, response);
      return response;
    } catch (err) {
      const classified = classify(err);
      this.logger.error('online request failed, nothing was queued', {
        operationId: operation.operationId,
        kind: classified.kind,
        reason: classified.reason,
      });
      throw classified;
    }
  }

  private async passThrough(req: HttpRequest): Promise<Response> {
    try {
      const res = await this.http.send({
        method: req.method,
        url: req.url,
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      return {
        status: res.status >= 200 && res.status < 300 ? 'Success' : 'Fail',
        entity: res.body,
      };
    } catch (err) {
      const classified: ClassifiedError = classify(err);
      this.logger.error('relayed request failed', { reason: classified.reason });
      throw classified;
    }
  }
}
