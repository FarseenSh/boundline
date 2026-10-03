import { Hono } from "hono";
import { rollingRoot } from "./daily.js";
import type { EventRow } from "./decode.js";
import type { Env } from "./env.js";
import type { ReconciliationRow, Store } from "./store.js";

export interface AppDeps {
  store: (env: Env) => Store;
  now?: () => number;
}

const DEFAULT_CHAIN = 84532;
const MAX_LIMIT = 500;

function chainOf(value: string | undefined): number {
  const n = Number(value ?? DEFAULT_CHAIN);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CHAIN;
}

function intOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function parseBefore(value: string | undefined): { blockNumber: number; logIndex: number } | undefined {
  if (!value) return undefined;
  const [b, l] = value.split(":");
  const blockNumber = Number(b);
  const logIndex = Number(l);
  return Number.isInteger(blockNumber) && Number.isInteger(logIndex) ? { blockNumber, logIndex } : undefined;
}

function eventJson(e: EventRow) {
  return {
    chainId: e.chainId,
    blockNumber: e.blockNumber,
    blockTime: e.blockTime,
    txHash: e.txHash,
    logIndex: e.logIndex,
    address: e.address,
    topic0: e.topic0,
    name: e.name,
    args: JSON.parse(e.argsJson) as unknown,
  };
}

function reconciliationJson(r: ReconciliationRow) {
  return {
    id: r.id,
    chainId: r.chainId,
    subject: r.subject,
    checkedAt: r.checkedAt,
    blockNumber: r.blockNumber,
    status: r.status,
    expected: JSON.parse(r.expectedJson) as unknown,
    actual: JSON.parse(r.actualJson) as unknown,
  };
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Bindings: Env }>();

  app.get("/health", (c) => c.json({ ok: true, service: "boundline-indexer" }));

  app.get("/v1/events", async (c) => {
    const q = c.req.query();
    const chainId = chainOf(q.chain);
    const limit = Math.min(MAX_LIMIT, Math.max(1, intOrUndefined(q.limit) ?? 100));
    const before = parseBefore(q.before);
    const fromBlock = intOrUndefined(q.from);
    const toBlock = intOrUndefined(q.to);
    const rows = await deps.store(c.env).queryEvents({
      chainId,
      limit,
      ...(q.address ? { address: q.address } : {}),
      ...(q.name ? { name: q.name } : {}),
      ...(fromBlock !== undefined ? { fromBlock } : {}),
      ...(toBlock !== undefined ? { toBlock } : {}),
      ...(before ? { before } : {}),
    });
    const last = rows[rows.length - 1];
    return c.json({
      chainId,
      count: rows.length,
      events: rows.map(eventJson),
      next: rows.length === limit && last ? `${last.blockNumber}:${last.logIndex}` : null,
    });
  });

  app.get("/v1/cursors", async (c) => c.json({ cursors: await deps.store(c.env).listCursors() }));

  app.get("/v1/roots", async (c) => {
    const chainId = chainOf(c.req.query("chain"));
    const store = deps.store(c.env);
    const roots = await store.listRoots(chainId, 60);
    const today = await rollingRoot(store, chainId, now());
    return c.json({ chainId, scheme: "keccak256(prev_root || h1 || ... || hn), h = keccak256(abi.encode(chainId, txHash, logIndex, address, topic0, keccak256(args_json)))", roots, today });
  });

  app.get("/v1/roots/:day", async (c) => {
    const chainId = chainOf(c.req.query("chain"));
    const day = c.req.param("day");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: "day must be YYYY-MM-DD" }, 400);
    const root = await deps.store(c.env).getRoot(chainId, day);
    if (!root) return c.json({ error: "no root for that day", chainId, day }, 404);
    return c.json(root);
  });

  app.get("/v1/reconcile/latest", async (c) => {
    const chainId = chainOf(c.req.query("chain"));
    const rows = await deps.store(c.env).latestReconciliations(chainId);
    const first = rows[0];
    return c.json({
      chainId,
      checkedAt: first?.checkedAt ?? null,
      blockNumber: first?.blockNumber ?? null,
      status: rows.length === 0 ? "NONE" : rows.some((r) => r.status === "FAIL") ? "FAIL" : rows.every((r) => r.status === "SKIP") ? "SKIP" : "PASS",
      checks: rows.map(reconciliationJson),
    });
  });

  return app;
}
