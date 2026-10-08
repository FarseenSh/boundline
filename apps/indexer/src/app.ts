import { Hono } from "hono";
import type { Address } from "viem";
import { rollingRoot } from "./daily.js";
import type { EventRow } from "./decode.js";
import type { Env } from "./env.js";
import type { RawRpc } from "./rpc.js";
import { seizeWatch } from "./seize.js";
import { MAINNET, MAINNET_FEED_BY_SYMBOL, MAINNET_STACK, SEPOLIA, SEPOLIA_PROTECTION, SEPOLIA_STACK, SOURCE_IDS, describeSource, type Source } from "./sources.js";
import type { EventQuery, ReconciliationRow, Store } from "./store.js";

export interface AppDeps {
  store: (env: Env) => Store;
  /** The sources this deployment follows; drives `/v1/sources`, the `source=` filter and the desk routes. */
  sources?: (env: Env) => Source[];
  /** JSON-RPC for the request-driven live reads (seize watch); absent in tests that do not need it. */
  rpc?: (env: Env, chainId: number) => RawRpc;
  now?: () => number;
}

const DEFAULT_CHAIN = 84532;
const MAX_LIMIT = 500;
/** Rows the aggregate routes (Aave borrowers) read in one go. */
const SCAN_LIMIT = 5_000;
/** A pause between two feed prints at least this long is reported as a gap (the weekend is 54–58 h, a holiday 76 h). */
export const FEED_GAP_SECONDS = 6 * 3600;

function chainOf(value: string | undefined, fallback = DEFAULT_CHAIN): number {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function intOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function limitOf(value: string | undefined, fallback = 100): number {
  return Math.min(MAX_LIMIT, Math.max(1, intOrUndefined(value) ?? fallback));
}

function parseBefore(value: string | undefined): { blockNumber: number; logIndex: number } | undefined {
  if (!value) return undefined;
  const [b, l] = value.split(":");
  const blockNumber = Number(b);
  const logIndex = Number(l);
  return Number.isInteger(blockNumber) && Number.isInteger(logIndex) ? { blockNumber, logIndex } : undefined;
}

function nextCursor(rows: EventRow[], limit: number): string | null {
  const last = rows[rows.length - 1];
  return rows.length === limit && last ? `${last.blockNumber}:${last.logIndex}` : null;
}

/** The canonical-JSON needle for an argument: hex lowercased, everything else as the decimal/text string it was stored as. */
export function argNeedle(name: string, value: string): string {
  const v = /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  return `"${name}":"${v}"`;
}

/** The DeskProtectionVault events that belong on a line's timeline. */
const VAULT_TIMELINE_EVENTS = ["Protected", "AdvanceSettled", "CollateralRecovered", "CollateralReturned"] as const;

/** Query-string argument filters, in the order the first one becomes the SQL filter and the rest post-filter the page. */
const ARG_FILTERS = ["lineId", "partnerId", "decisionHash", "user", "borrower", "onBehalf", "token"] as const;

function argsOf(e: EventRow): Record<string, unknown> {
  try {
    return JSON.parse(e.argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function eventJson(e: EventRow) {
  return {
    chainId: e.chainId,
    blockNumber: e.blockNumber,
    blockTime: e.blockTime,
    txHash: e.txHash,
    logIndex: e.logIndex,
    address: e.address,
    topic0: e.topic0,
    name: e.name,
    args: argsOf(e),
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

/** The feed a symbol names: a mainnet Coinbase stock (its phase-2 aggregator) or a Sepolia test stock (its TestPriceFeed). */
export function feedForSymbol(symbol: string, chainId: number): { chainId: number; feed: Address; emitter: Address; token: Address | null } | null {
  const upper = symbol.toUpperCase();
  if (chainId === MAINNET) {
    const f = Object.values(MAINNET_FEED_BY_SYMBOL).find((x) => x.symbol.toUpperCase() === upper);
    return f ? { chainId: MAINNET, feed: f.proxy, emitter: f.aggregator, token: f.token } : null;
  }
  if (chainId === SEPOLIA) {
    const entry = (Object.entries(SEPOLIA_STACK.feeds) as [string, Address][]).find(([sym]) => sym.toUpperCase() === upper);
    if (!entry) return null;
    const token = (SEPOLIA_STACK.tokens as Record<string, Address>)[entry[0]] ?? null;
    return { chainId: SEPOLIA, feed: entry[1], emitter: entry[1], token };
  }
  return null;
}

export interface FeedRound {
  roundId: string;
  answer: string;
  /** answer / 1e8 (every Coinbase stock feed has 8 decimals). */
  price: number;
  updatedAt: number;
  blockNumber: number;
  blockTime: number;
  txHash: string;
}

export function toFeedRound(e: EventRow): FeedRound | null {
  const a = argsOf(e);
  if (typeof a.current !== "string" || typeof a.roundId !== "string" || typeof a.updatedAt !== "string") return null;
  return {
    roundId: a.roundId,
    answer: a.current,
    price: Number(a.current) / 1e8,
    updatedAt: Number(a.updatedAt),
    blockNumber: e.blockNumber,
    blockTime: e.blockTime,
    txHash: e.txHash,
  };
}

/** Pauses of at least `minSeconds` between consecutive prints, oldest first; the held answer is the one the venue read meanwhile. */
export function feedGaps(roundsNewestFirst: readonly FeedRound[], minSeconds = FEED_GAP_SECONDS) {
  const chrono = [...roundsNewestFirst].sort((a, b) => a.updatedAt - b.updatedAt || a.blockNumber - b.blockNumber);
  const gaps: { fromUpdatedAt: number; toUpdatedAt: number; seconds: number; hours: number; heldAnswer: string; nextAnswer: string; moveBps: number }[] = [];
  for (let i = 1; i < chrono.length; i += 1) {
    const prev = chrono[i - 1]!;
    const cur = chrono[i]!;
    const seconds = cur.updatedAt - prev.updatedAt;
    if (seconds < minSeconds) continue;
    const held = Number(prev.answer);
    gaps.push({
      fromUpdatedAt: prev.updatedAt,
      toUpdatedAt: cur.updatedAt,
      seconds,
      hours: Math.round((seconds / 3600) * 100) / 100,
      heldAnswer: prev.answer,
      nextAnswer: cur.answer,
      moveBps: held > 0 ? Math.round(((Number(cur.answer) - held) / held) * 10_000 * 100) / 100 : 0,
    });
  }
  return gaps;
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const sourcesOf = deps.sources ?? (() => []);
  const app = new Hono<{ Bindings: Env }>();

  const deskOf = (env: Env): Address | null => {
    const s = sourcesOf(env).find((x) => x.id === SOURCE_IDS.creditDesk);
    return s?.addresses[0] ?? null;
  };

  app.get("/health", (c) => c.json({ ok: true, service: "boundline-indexer" }));

  app.get("/v1/sources", async (c) => {
    const sources = sourcesOf(c.env);
    const cursors = await deps.store(c.env).listCursors();
    return c.json({
      count: sources.length,
      sources: sources.map((s) => {
        const cursor = cursors.find((x) => x.chainId === s.chainId && x.source === s.id) ?? null;
        return { ...describeSource(s), addressList: s.addresses, cursor };
      }),
      mainnet: {
        feeds: MAINNET_STACK.feeds,
        markets: MAINNET_STACK.markets,
        oracleRegistry: MAINNET_STACK.oracleRegistry,
        aaveMag7Spoke: MAINNET_STACK.aaveMag7Spoke,
        blocks: MAINNET_STACK.blocks,
      },
    });
  });

  app.get("/v1/events", async (c) => {
    const q = c.req.query();
    const chainId = chainOf(q.chainId ?? q.chain);
    const limit = limitOf(q.limit);
    const before = parseBefore(q.before);
    const fromBlock = intOrUndefined(q.from);
    const toBlock = intOrUndefined(q.to);
    const fromTime = intOrUndefined(q.since);
    const source = q.source ? sourcesOf(c.env).find((s) => s.id === q.source && s.chainId === chainId) : undefined;
    if (q.source && !source) return c.json({ error: "unknown source for this chain", source: q.source, chainId }, 404);
    const argFilters = ARG_FILTERS.filter((k) => typeof q[k] === "string" && q[k] !== "").map((k) => ({ key: k, needle: argNeedle(k, q[k] as string) }));
    const query: EventQuery = {
      chainId,
      limit,
      ...(q.address ? { address: q.address } : {}),
      ...(source ? { addresses: source.addresses } : {}),
      ...(q.name ? { name: q.name } : {}),
      ...(fromBlock !== undefined ? { fromBlock } : {}),
      ...(toBlock !== undefined ? { toBlock } : {}),
      ...(fromTime !== undefined ? { fromTime } : {}),
      ...(argFilters[0] ? { argsContains: argFilters[0].needle } : {}),
      ...(before ? { before } : {}),
    };
    let rows = await deps.store(c.env).queryEvents(query);
    const next = nextCursor(rows, limit);
    for (const f of argFilters.slice(1)) rows = rows.filter((e) => e.argsJson.includes(f.needle));
    return c.json({ chainId, source: source?.id ?? null, count: rows.length, events: rows.map(eventJson), next });
  });

  app.get("/v1/cursors", async (c) => c.json({ cursors: await deps.store(c.env).listCursors() }));

  app.get("/v1/roots", async (c) => {
    const chainId = chainOf(c.req.query("chainId") ?? c.req.query("chain"));
    const store = deps.store(c.env);
    const [roots, today, counts] = await Promise.all([store.listRoots(chainId, 60), rollingRoot(store, chainId, now()), store.countEventsByDay(chainId)]);
    // A root covers the events stored when its day closed. A source added later with an earlier start block stores more
    // events in an already-rooted day (8 Oct 2026: sepolia-protection backfilled 6 and 7 Oct): `drift` says so, and the
    // day is re-rooted only by deleting its row and the later ones (a human decision; the chain re-forms by itself).
    const annotated = roots.map((r) => ({ ...r, eventsStoredNow: counts[r.day] ?? 0, drift: (counts[r.day] ?? 0) !== r.eventCount }));
    return c.json({
      chainId,
      scheme: "keccak256(prev_root || h1 || ... || hn), h = keccak256(abi.encode(chainId, txHash, logIndex, address, topic0, keccak256(args_json)))",
      coverage: "each root covers the events stored when its UTC day closed; drift = events stored in that day since (a source added later)",
      roots: annotated,
      today,
    });
  });

  app.get("/v1/roots/:day", async (c) => {
    const chainId = chainOf(c.req.query("chainId") ?? c.req.query("chain"));
    const day = c.req.param("day");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: "day must be YYYY-MM-DD" }, 400);
    const root = await deps.store(c.env).getRoot(chainId, day);
    if (!root) return c.json({ error: "no root for that day", chainId, day }, 404);
    return c.json(root);
  });

  app.get("/v1/reconcile/latest", async (c) => {
    const chainId = chainOf(c.req.query("chainId") ?? c.req.query("chain"));
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

  /** Feed rounds (Chainlink `AnswerUpdated`) for a stock, newest first, with the pauses between prints: the weekend-gap history. */
  app.get("/v1/feeds/:symbol/rounds", async (c) => {
    const symbol = c.req.param("symbol");
    const chainId = chainOf(c.req.query("chainId") ?? c.req.query("chain"), MAINNET);
    const feed = feedForSymbol(symbol, chainId);
    if (!feed) return c.json({ error: "unknown feed symbol for this chain", symbol, chainId }, 404);
    const limit = limitOf(c.req.query("limit"), 200);
    const before = parseBefore(c.req.query("before"));
    const since = intOrUndefined(c.req.query("since"));
    const rows = await deps.store(c.env).queryEvents({
      chainId,
      address: feed.emitter,
      name: "AnswerUpdated",
      limit,
      ...(since !== undefined ? { fromTime: since } : {}),
      ...(before ? { before } : {}),
    });
    const rounds = rows.map(toFeedRound).filter((r): r is FeedRound => r !== null);
    return c.json({
      chainId,
      symbol: symbol.toUpperCase() === symbol ? symbol : symbol,
      feed: feed.feed,
      emitter: feed.emitter,
      token: feed.token,
      count: rounds.length,
      rounds,
      gaps: feedGaps(rounds),
      gapThresholdSeconds: FEED_GAP_SECONDS,
      next: nextCursor(rows, limit),
      note: "rounds are the AnswerUpdated events stored since the source's start block; gaps are pauses between consecutive prints on this page",
    });
  });

  /** Distinct borrowers of the Aave V4 MAG7 spoke from its Borrow events, so the Observatory can read their positions. */
  app.get("/v1/venues/aave/borrowers", async (c) => {
    const since = intOrUndefined(c.req.query("since"));
    const limit = limitOf(c.req.query("limit"), 500);
    const rows = await deps.store(c.env).queryEvents({
      chainId: MAINNET,
      address: MAINNET_STACK.aaveMag7Spoke,
      name: "Borrow",
      limit: SCAN_LIMIT,
      ...(since !== undefined ? { fromTime: since } : {}),
    });
    const byUser = new Map<string, { address: string; borrows: number; firstBlock: number; lastBlock: number; lastBlockTime: number; reserveIds: Set<string> }>();
    for (const e of rows) {
      const a = argsOf(e);
      const user = typeof a.user === "string" ? a.user.toLowerCase() : null;
      if (!user) continue;
      const cur = byUser.get(user) ?? { address: user, borrows: 0, firstBlock: e.blockNumber, lastBlock: e.blockNumber, lastBlockTime: e.blockTime, reserveIds: new Set<string>() };
      cur.borrows += 1;
      cur.firstBlock = Math.min(cur.firstBlock, e.blockNumber);
      if (e.blockNumber >= cur.lastBlock) {
        cur.lastBlock = e.blockNumber;
        cur.lastBlockTime = e.blockTime;
      }
      if (typeof a.reserveId === "string") cur.reserveIds.add(a.reserveId);
      byUser.set(user, cur);
    }
    const borrowers = [...byUser.values()]
      .sort((x, y) => y.lastBlock - x.lastBlock)
      .slice(0, limit)
      .map((b) => ({ ...b, reserveIds: [...b.reserveIds].sort() }));
    const source = sourcesOf(c.env).find((s) => s.id === SOURCE_IDS.mainnetAaveSpoke);
    return c.json({
      chainId: MAINNET,
      spoke: MAINNET_STACK.aaveMag7Spoke,
      count: borrowers.length,
      borrowEvents: rows.length,
      cutoffBlock: source?.startBlock ?? null,
      note: "borrowers seen in Borrow events since the cutoff block; positions opened before it appear once they borrow again",
      borrowers,
    });
  });

  /** Lines opened on the CreditDesk (LineOpened events), optionally one partner's, newest first. */
  app.get("/v1/desk/lines", async (c) => {
    const chainId = chainOf(c.req.query("chainId") ?? c.req.query("chain"));
    const desk = deskOf(c.env);
    if (!desk) return c.json({ error: "no desk source on this deployment" }, 503);
    const partnerId = c.req.query("partnerId");
    if (partnerId !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(partnerId)) return c.json({ error: "partnerId must be bytes32 hex" }, 400);
    const limit = limitOf(c.req.query("limit"), 100);
    const before = parseBefore(c.req.query("before"));
    const rows = await deps.store(c.env).queryEvents({
      chainId,
      address: desk,
      name: "LineOpened",
      limit,
      ...(partnerId ? { argsContains: argNeedle("partnerId", partnerId) } : {}),
      ...(before ? { before } : {}),
    });
    const lines = rows.map((e) => {
      const a = argsOf(e);
      return {
        lineId: String(a.lineId ?? ""),
        partnerId: String(a.partnerId ?? ""),
        user: String(a.user ?? ""),
        marketId: String(a.marketId ?? ""),
        policyVersion: Number(a.policyVersion ?? 0),
        decisionHash: String(a.decisionHash ?? ""),
        blockNumber: e.blockNumber,
        blockTime: e.blockTime,
        txHash: e.txHash,
      };
    });
    return c.json({ chainId, desk, partnerId: partnerId?.toLowerCase() ?? null, count: lines.length, lines, next: nextCursor(rows, limit) });
  });

  /** Every event of one line, oldest first: the desk's (obligation, decisions) and, on Sepolia, the DeskProtectionVault's
   *  protective repays, advance settlements and collateral recovered and returned (each carries the vault's decision
   *  hash; the vault's own `Decision` rows are left out so a consumer's decision list stays the desk's). `contract`
   *  tells the emitters apart. */
  app.get("/v1/desk/lines/:id/timeline", async (c) => {
    const chainId = chainOf(c.req.query("chainId") ?? c.req.query("chain"));
    const desk = deskOf(c.env);
    if (!desk) return c.json({ error: "no desk source on this deployment" }, 503);
    const id = c.req.param("id");
    if (!/^[1-9]\d*$/.test(id)) return c.json({ error: "line id must be a positive integer" }, 400);
    const needle = argNeedle("lineId", id);
    const vault = chainId === SEPOLIA && sourcesOf(c.env).some((s) => s.id === SOURCE_IDS.sepoliaProtection) ? SEPOLIA_PROTECTION.deskProtectionVault.toLowerCase() : null;
    const store = deps.store(c.env);
    const [deskRows, vaultRows] = await Promise.all([
      store.queryEvents({ chainId, address: desk, argsContains: needle, limit: MAX_LIMIT }),
      vault ? store.queryEvents({ chainId, address: vault, names: VAULT_TIMELINE_EVENTS, argsContains: needle, limit: MAX_LIMIT }) : Promise.resolve([] as EventRow[]),
    ]);
    const events = [...deskRows, ...vaultRows]
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
      .map((e) => ({ ...eventJson(e), contract: e.address === vault ? "DeskProtectionVault" : "CreditDesk" }));
    return c.json({ chainId, desk, vault, lineId: id, count: events.length, events });
  });

  /** Seize watch (plan M9): who can seize the ten Coinbase stocks, under which exemption policy, and are the venues exempt. */
  app.get("/v1/seize-watch", async (c) => {
    const body = await seizeWatch(deps.store(c.env), deps.rpc ? deps.rpc(c.env, MAINNET) : null, now());
    return c.json(body);
  });

  return app;
}
