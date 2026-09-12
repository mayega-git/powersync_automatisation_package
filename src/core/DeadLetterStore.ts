import type { AccessLocalDatabase, SqlRow } from './AccessLocalDatabase.js';

/** A record of one lost write, kept to understand later what happened. */
export interface DeadLetterEntry {
  /** Id of the pending write that was rejected. */
  id: string;
  operationId: string;
  /** What the write carried, verbatim. */
  payload: string;
  /** Server status code; 0 when there was no response at all. */
  code: number;
  reason: string;
  createdAt: number;
}

export const DEAD_LETTER_TABLE_NAME = 'offline_sync_dead_letters';

/** Columns and their type, so the schema writer can generate this table. `id` is added by the engine. */
export const DEAD_LETTER_COLUMNS = {
  operation_id: 'text',
  payload: 'text',
  code: 'integer',
  reason: 'text',
  created_at: 'integer',
} as const;

export interface DeadLetterStoreOptions {
  db: AccessLocalDatabase;
  /** Local table name. Change only on a collision. */
  tableName?: string;
}

export class DeadLetterStore {
  private readonly db: AccessLocalDatabase;
  private readonly table: string;

  constructor(options: DeadLetterStoreOptions) {
    this.db = options.db;
    this.table = safeTableName(options.tableName ?? DEAD_LETTER_TABLE_NAME);
  }

  /** Recording the same entry twice is not a duplicate: a retried transaction can pass through here again. */
  async record(entry: DeadLetterEntry): Promise<void> {
    await this.db.writeData(
      `INSERT OR REPLACE INTO ${this.table}
         (id, operation_id, payload, code, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.operationId,
        entry.payload,
        entry.code,
        entry.reason,
        entry.createdAt,
      ],
    );
  }

  /** Most recent first. */
  async list(): Promise<DeadLetterEntry[]> {
    const rows = await this.db.readData(
      `SELECT id, operation_id, payload, code, reason, created_at
         FROM ${this.table}
        ORDER BY created_at DESC`,
    );
    return rows.map(toEntry);
  }

  async remove(id: string): Promise<void> {
    await this.db.writeData(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
  }

  async count(): Promise<number> {
    const rows = await this.db.readData<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${this.table}`,
    );
    return rows[0]?.n ?? 0;
  }
}

function safeTableName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid table name for the dead-letter store: "${name}". Only ` +
        'letters, digits and underscores are accepted, and the name cannot ' +
        'start with a digit.',
    );
  }
  return name;
}

function toEntry(row: SqlRow): DeadLetterEntry {
  return {
    id: String(row['id']),
    operationId: String(row['operation_id']),
    payload: String(row['payload']),
    code: Number(row['code']),
    reason: String(row['reason']),
    createdAt: Number(row['created_at']),
  };
}
