// A real SQLite (node:sqlite) behind the slice of D1Database the stores use, with every migration applied, so the
// D1 SQL itself (not only its in-memory twin) is executed and its query plans can be asserted.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface Executed {
  sql: string;
  params: SQLInputValue[];
}

export interface SqliteD1 {
  db: D1Database;
  raw: DatabaseSync;
  /** Every statement the stores executed, in order. */
  executed: Executed[];
  /** EXPLAIN QUERY PLAN details for a statement, with its parameters. */
  plan(e: Executed): string[];
}

/** Applies migrations whose file name sorts at or before `through` (default: all). */
export function sqliteD1(through = "9999"): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    if (f.slice(0, 4) > through) continue;
    raw.exec(readFileSync(MIGRATIONS + f, "utf8"));
  }
  const executed: Executed[] = [];

  class Stmt {
    constructor(
      private readonly sql: string,
      private readonly params: SQLInputValue[] = [],
    ) {}
    bind(...values: unknown[]): Stmt {
      return new Stmt(this.sql, values as SQLInputValue[]);
    }
    private record() {
      executed.push({ sql: this.sql, params: this.params });
      return raw.prepare(this.sql);
    }
    async first<T>(): Promise<T | null> {
      return (this.record().get(...this.params) as T | undefined) ?? null;
    }
    async all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, never> }> {
      return { results: this.record().all(...this.params) as T[], success: true, meta: {} };
    }
    async run(): Promise<{ results: []; success: true; meta: { changes: number } }> {
      const r = this.record().run(...this.params);
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    }
  }

  const db = {
    prepare: (sql: string) => new Stmt(sql),
    async batch(stmts: Stmt[]) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;

  const plan = (e: Executed): string[] =>
    (raw.prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...e.params) as Array<{ detail: string }>).map((r) => r.detail);

  return { db, raw, executed, plan };
}
