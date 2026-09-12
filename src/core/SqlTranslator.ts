import type { SqlValue } from './AccessLocalDatabase.js';

/** The current request's values, merged by Converter.extractParams(). Unused keys are ignored. */
export type SqlParams = Record<string, SqlValue>;

export interface PositionalSql {
  sql: string;
  /** Values, in the exact order of the `?` placeholders. */
  params: SqlValue[];
}

export class SqlTranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlTranslationError';
  }
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

function skipDelimited(sql: string, start: number, close: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (sql[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw new SqlTranslationError(
    `Unterminated literal in the SQL: missing a closing ${close}.`,
  );
}

export class SqlTranslator {
  /** Replaces each `:name` with a `?`; leaves anything inside a quoted literal or comment untouched. */
  static toPositional(sql: string, params: SqlParams): PositionalSql {
    const out: string[] = [];
    const ordered: SqlValue[] = [];
    let i = 0;

    while (i < sql.length) {
      const c = sql[i]!;

      if (c === '?') {
        throw new SqlTranslationError(
          "The SQL already contains a '?'. Mixing named and positional " +
            'parameters in the same query is ambiguous: keep only the named ' +
            'form (:name).',
        );
      }

      if (c === "'" || c === '"' || c === '`') {
        const end = skipDelimited(sql, i, c);
        out.push(sql.slice(i, end));
        i = end;
        continue;
      }

      if (c === '[') {
        const end = sql.indexOf(']', i + 1);
        if (end === -1) {
          throw new SqlTranslationError('Unterminated literal in the SQL: missing a closing ].');
        }
        out.push(sql.slice(i, end + 1));
        i = end + 1;
        continue;
      }

      if (c === '-' && sql[i + 1] === '-') {
        const nl = sql.indexOf('\n', i);
        const end = nl === -1 ? sql.length : nl;
        out.push(sql.slice(i, end));
        i = end;
        continue;
      }

      if (c === '/' && sql[i + 1] === '*') {
        const close = sql.indexOf('*/', i + 2);
        const end = close === -1 ? sql.length : close + 2;
        out.push(sql.slice(i, end));
        i = end;
        continue;
      }

      if (c === ':') {
        if (sql[i + 1] === ':') {
          out.push('::');
          i += 2;
          continue;
        }

        const first = sql[i + 1];
        if (first !== undefined && NAME_START.test(first)) {
          let j = i + 1;
          while (j < sql.length && NAME_CHAR.test(sql[j]!)) j += 1;
          const name = sql.slice(i + 1, j);

          if (!Object.prototype.hasOwnProperty.call(params, name)) {
            throw new SqlTranslationError(
              `The SQL asks for :${name}, missing from the request values. ` +
                `Available values: ${Object.keys(params).join(', ') || '(none)'}.`,
            );
          }

          out.push('?');
          ordered.push(params[name]!);
          i = j;
          continue;
        }
      }

      out.push(c);
      i += 1;
    }

    return { sql: out.join(''), params: ordered };
  }
}
