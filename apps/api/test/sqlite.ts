// A D1 stand-in over node:sqlite with the real migrations applied, so the SQL the Worker runs is exercised as written
// (the older fakeD1 in helpers.ts matches statements by string; this one executes them).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { Db, DbStatement } from "../src/db.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url).href);

export function sqliteD1(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(`${MIGRATIONS}${f}`, "utf8"));
  const norm = (v: unknown): unknown => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v);
  return {
    raw,
    prepare(sql: string): DbStatement {
      let args: unknown[] = [];
      const stmt: DbStatement = {
        bind(...values) {
          args = values.map(norm);
          return stmt;
        },
        async first<T>() {
          return ((raw.prepare(sql).get(...(args as never[])) as T | undefined) ?? null) as T | null;
        },
        async all<T>() {
          return { results: raw.prepare(sql).all(...(args as never[])) as T[] };
        },
        async run() {
          const r = raw.prepare(sql).run(...(args as never[]));
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      };
      return stmt;
    },
  };
}
