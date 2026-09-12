import type { LocalDatabaseSession, SqlRow } from './AccessLocalDatabase.js';
import type { HttpRequest } from './HttpRequest.js';

/** Declared `localOnly` in the schema: never replicated, so it can't trigger an upload by itself. */
export const QUEUE_TABLE = '_file_attente';

export const QUEUE_COLUMNS = ['method', 'path', 'body', 'created_at'] as const;

export interface QueuedRequest {
  /** Matches the `_metadata` value stamped on the business row. */
  id: string;
  method: string;
  /** Includes the query string. */
  path: string;
  body?: unknown;
  createdAt: string;
}

export class PendingQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PendingQueueError';
  }
}

export interface EnqueueInput {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  now: string;
}

/** Call within the same transaction as the business write. */
export async function enqueue(
  tx: LocalDatabaseSession,
  input: EnqueueInput,
): Promise<void> {
  await tx.writeData(
    `INSERT INTO ${QUEUE_TABLE} (id, method, path, body, created_at)` +
      ' VALUES (?, ?, ?, ?, ?)',
    [
      input.id,
      input.method.toUpperCase(),
      input.path,
      input.body === undefined ? null : JSON.stringify(input.body),
      input.now,
    ],
  );
}

export async function readQueued(
  tx: LocalDatabaseSession,
  id: string,
): Promise<QueuedRequest | undefined> {
  const rows = await tx.readData<SqlRow>(
    `SELECT id, method, path, body, created_at FROM ${QUEUE_TABLE} WHERE id = ?`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? undefined : toQueuedRequest(row);
}

/** Ordered by creation time: two requests touching the same row must reach the server in order. */
export async function listQueued(
  tx: LocalDatabaseSession,
): Promise<QueuedRequest[]> {
  const rows = await tx.readData<SqlRow>(
    `SELECT id, method, path, body, created_at FROM ${QUEUE_TABLE}` +
      ' ORDER BY created_at, id',
  );
  return rows.map(toQueuedRequest);
}

/** Call within the same transaction as the engine's acknowledgment. */
export async function dequeue(
  tx: LocalDatabaseSession,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await tx.writeData(`DELETE FROM ${QUEUE_TABLE} WHERE id IN (${placeholders})`, [...ids]);
}

export function toHttpRequest(queued: QueuedRequest): HttpRequest {
  return {
    method: queued.method,
    url: queued.path,
    ...(queued.body !== undefined ? { body: queued.body } : {}),
  };
}

function toQueuedRequest(row: SqlRow): QueuedRequest {
  const raw = row['body'];
  return {
    id: String(row['id']),
    method: String(row['method']),
    path: String(row['path']),
    ...(typeof raw === 'string' ? { body: parseBody(raw) } : {}),
    createdAt: String(row['created_at'] ?? ''),
  };
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PendingQueueError(
      `The body stored in ${QUEUE_TABLE} is not valid JSON; replaying it would send an empty body.`,
    );
  }
}
