import { invoke } from '@tauri-apps/api/core';

type SqlRequest = { db: string; query: string; values: unknown[] };
type SqlExecuteResult = { rowsAffected: number; lastInsertId: number };

export default class Database {
  private readonly db: string;

  private constructor(db: string) {
    this.db = db;
  }

  static async load(db: string) {
    return new Database(await invoke<string>('sql_load', { db }));
  }

  select<T = Record<string, unknown>[]>(query: string, values: unknown[] = []) {
    return invoke<T>('sql_select', { request: { db: this.db, query, values } satisfies SqlRequest });
  }

  execute(query: string, values: unknown[] = []) {
    return invoke<SqlExecuteResult>('sql_execute', { request: { db: this.db, query, values } satisfies SqlRequest });
  }

  close() {
    return invoke<boolean>('sql_close', { db: this.db });
  }
}
