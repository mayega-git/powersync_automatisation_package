import type {
  AccessLocalDatabase,
  LocalDatabaseSession,
  SqlRow,
} from './AccessLocalDatabase.js';
import { RELATIVE_BASE } from './Converter.js';
import type { EntityRoutes, ResolvedEntity } from './EntityRoutes.js';
import type { Response } from './Handler.js';
import type { HttpRequest } from './HttpRequest.js';
import type { Logger } from './Logger.js';
import { enqueue } from './PendingQueue.js';
import { SqlBuilder, type BuiltStatement, type TableColumns } from './SqlBuilder.js';
import { SqlTranslator } from './SqlTranslator.js';

export interface ComposedOperationsOptions {
  routes: EntityRoutes;
  /** Real columns, read from the schema generated from the engine. */
  schema: TableColumns;
  logger: Logger;
  now?: () => string;
  newRequestId?: () => string;
  newRowId?: () => string;
}

export class ComposedOperations {
  private readonly routes: EntityRoutes;
  private readonly schema: TableColumns;
  private readonly sql: SqlBuilder;
  private readonly logger: Logger;
  private readonly now: () => string;
  private readonly newRequestId: () => string;
  private readonly newRowId: (() => string) | undefined;

  constructor(options: ComposedOperationsOptions) {
    this.routes = options.routes;
    this.schema = options.schema;
    this.sql = new SqlBuilder(options.schema);
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newRequestId =
      options.newRequestId ?? (() => `req-${globalThis.crypto.randomUUID()}`);
    this.newRowId = options.newRowId;
  }

  resolve(req: HttpRequest): ResolvedEntity | undefined {
    const { pathname } = new URL(req.url, RELATIVE_BASE);
    return this.routes.resolve(req.method, pathname);
  }

  async run(
    db: AccessLocalDatabase,
    req: HttpRequest,
    resolved: ResolvedEntity,
  ): Promise<Response> {
    const method = req.method.toUpperCase();

    if (method === 'GET' || method === 'HEAD') {
      return this.read(db, req, resolved);
    }
    return this.write(db, req, resolved);
  }

  private async read(
    db: AccessLocalDatabase,
    req: HttpRequest,
    resolved: ResolvedEntity,
  ): Promise<Response> {
    const [statement] = this.sql.build({
      table: resolved.table,
      method: req.method,
      pathParams: resolved.pathParams,
      joins: resolved.joins,
      aggregates: resolved.aggregates,
      select: resolved.select,
    });
    const translated = this.translate(statement!, resolved);
    const rows = await db.readData(translated.sql, translated.params);

    if (resolved.aggregates && resolved.aggregates.length > 0) {
      for (const row of rows) {
        for (const agg of resolved.aggregates) {
          const val = row[agg.field];
          if (typeof val === 'string') {
            try {
              row[agg.field] = JSON.parse(val);
            } catch {
              // Leave as string if not parsable
            }
          }
        }
      }
    }

    const single = Object.keys(resolved.pathParams).length > 0;
    return {
      status: 'Success',
      entity: single ? (rows[0] ?? null) : rows,
    };
  }

  private async write(
    db: AccessLocalDatabase,
    req: HttpRequest,
    resolved: ResolvedEntity,
  ): Promise<Response> {
    const requestId = this.newRequestId();
    const timestamp = this.now();
    const { pathname, search } = new URL(req.url, RELATIVE_BASE);

    return db.runInTransaction(async (tx) => {
      const tenant = await this.localTenant(tx, resolved.table);

      const statements = this.sql.build({
        table: resolved.table,
        method: req.method,
        pathParams: resolved.pathParams,
        joins: resolved.joins,
        ...(req.body !== undefined ? { body: req.body } : {}),
        metadata: requestId,
        tenantId: tenant,
        now: timestamp,
        ...(this.newRowId !== undefined ? { newId: this.newRowId } : {}),
      });

      let last: SqlRow | null = null;
      for (const statement of statements) {
        const translated = this.translate(statement, resolved);
        const writeResult = await tx.writeData(translated.sql, translated.params);
        if (statement.kind !== 'mark') last = writeResult.rows[0] ?? last;
      }

      await enqueue(tx, {
        id: requestId,
        method: req.method,
        path: pathname + search,
        ...(req.body !== undefined ? { body: req.body } : {}),
        now: timestamp,
      });

      this.logger.info('local write done, request kept for replay', {
        table: resolved.table,
        method: req.method.toUpperCase(),
        requestId,
      });

      return { status: 'Success', entity: last };
    });
  }

  private translate(
    statement: BuiltStatement,
    resolved: ResolvedEntity,
  ): { sql: string; params: readonly (string | number | bigint | boolean | null | Uint8Array)[] } {
    const translated = SqlTranslator.toPositional(statement.sql, statement.params);
    this.logger.debug('sql composed', {
      table: resolved.table,
      rule: resolved.rule,
      sql: translated.sql,
    });
    return translated;
  }

  private async localTenant(
    tx: LocalDatabaseSession,
    table: string,
  ): Promise<string | null> {
    const columns = this.schema[table];
    if (columns === undefined || !columns.includes('tenant_id')) return null;

    const candidates = [
      table,
      ...Object.keys(this.schema).filter(
        (t) => t !== table && (this.schema[t] ?? []).includes('tenant_id'),
      ),
    ];

    for (const name of candidates) {
      const rows = await tx.readData<{ tenant_id: string }>(
        `SELECT tenant_id FROM ${name} WHERE tenant_id IS NOT NULL LIMIT 1`,
      );
      const found = rows[0]?.tenant_id;
      if (found !== undefined && found !== null) return found;
    }
    return null;
  }
}
