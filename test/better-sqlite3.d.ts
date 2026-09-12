// The strict minimum of better-sqlite3 the tests use. `@types/better-sqlite3`
// isn't installed; declaring these three methods here beats `any`.
declare module 'better-sqlite3' {
  interface Statement {
    readonly reader: boolean;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number };
  }
  export default class Database {
    constructor(filename: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
