// D1 access behind small store interfaces, with an in-memory twin used by the tests.
import type { Address, Hex } from "viem";
import type { Session } from "./calendar-port.js";
import type { CaptureRow, CaptureSummary, TransitionKind } from "./capture.js";
import type { Borrower, PositionRow } from "./positions.js";

export interface CaptureRunRecord {
  transitionAt: number;
  fromSession: Session;
  toSession: Session;
  kind: TransitionKind;
  armedAt: number;
  firstUpdateAt: number | null;
  completedAt: number | null;
  summary: CaptureSummary;
}

export interface HeldPrint {
  answer: string;
  updatedAt: number;
}

export interface CaptureStore {
  getRun(transitionAt: number): Promise<CaptureRunRecord | null>;
  /** Insert or replace. */
  putRun(run: CaptureRunRecord): Promise<void>;
  latestRun(): Promise<CaptureRunRecord | null>;
  listRuns(limit: number): Promise<CaptureRunRecord[]>;
  addRows(rows: readonly CaptureRow[]): Promise<void>;
  rowsFor(transitionAt: number): Promise<CaptureRow[]>;
  /** Latest snapshot print of `symbol` whose updatedAt is at or before `at` (for a run armed after the transition). */
  lastHeldPrint(symbol: string, at: number): Promise<HeldPrint | null>;
}

export interface PositionStore {
  borrowers(chainId: number): Promise<Borrower[]>;
  /** Insert-or-ignore; returns how many were new. */
  addBorrowers(list: readonly Borrower[]): Promise<number>;
  /** Lowest cursor across the chain's markets, null before the first scan. */
  cursor(chainId: number): Promise<number | null>;
  setCursor(chainId: number, marketIds: readonly Hex[], lastBlock: number, at: number): Promise<void>;
  addPositions(rows: readonly PositionRow[]): Promise<void>;
  latestPositions(chainId: number): Promise<PositionRow[]>;
  positionsForAddress(address: Address): Promise<PositionRow[]>;
  lastPositionsTakenAt(chainId: number): Promise<number | null>;
}

export interface Stores {
  capture: CaptureStore;
  positions: PositionStore;
}

// ---------------------------------------------------------------- D1

interface RunDbRow {
  transition_at: number;
  from_session: string;
  to_session: string;
  kind: string;
  armed_at: number;
  first_update_at: number | null;
  completed_at: number | null;
  summary_json: string;
}

interface CaptureDbRow {
  transition_at: number;
  from_session: string;
  to_session: string;
  token_symbol: string;
  phase: string;
  taken_at: number;
  block_number: number;
  feed_round_id: string;
  feed_answer: string;
  feed_updated_at: number;
  dex_price: number | null;
  twap_price: number | null;
  note: string | null;
}

interface PositionDbRow {
  chain_id: number;
  market_id: string;
  address: string;
  taken_at: number;
  block_number: number;
  collateral_symbol: string;
  lltv: number;
  collateral: string;
  borrow_shares: string;
  debt_assets: string;
  venue_price: number | null;
  shadow_price: number | null;
  venue_hf: number | null;
  shadow_hf: number | null;
  protection_case: number;
}

function runFromDb(r: RunDbRow): CaptureRunRecord {
  return {
    transitionAt: r.transition_at,
    fromSession: r.from_session as Session,
    toSession: r.to_session as Session,
    kind: r.kind as TransitionKind,
    armedAt: r.armed_at,
    firstUpdateAt: r.first_update_at,
    completedAt: r.completed_at,
    summary: JSON.parse(r.summary_json) as CaptureSummary,
  };
}

function captureFromDb(r: CaptureDbRow): CaptureRow {
  return {
    transitionAt: r.transition_at,
    fromSession: r.from_session as Session,
    toSession: r.to_session as Session,
    tokenSymbol: r.token_symbol,
    phase: r.phase as CaptureRow["phase"],
    takenAt: r.taken_at,
    blockNumber: r.block_number,
    feedRoundId: r.feed_round_id,
    feedAnswer: r.feed_answer,
    feedUpdatedAt: r.feed_updated_at,
    dexPrice: r.dex_price,
    twapPrice: r.twap_price,
    note: r.note,
  };
}

function positionFromDb(r: PositionDbRow): PositionRow {
  return {
    chainId: r.chain_id,
    marketId: r.market_id as Hex,
    address: r.address as Address,
    takenAt: r.taken_at,
    blockNumber: r.block_number,
    collateralSymbol: r.collateral_symbol,
    lltv: r.lltv,
    collateral: r.collateral,
    borrowShares: r.borrow_shares,
    debtAssets: r.debt_assets,
    venuePrice: r.venue_price,
    shadowPrice: r.shadow_price,
    venueHf: r.venue_hf,
    shadowHf: r.shadow_hf,
    protectionCase: r.protection_case === 1,
  };
}

const LATEST_POSITIONS_SQL = `SELECT p.* FROM positions p
  JOIN (SELECT chain_id, market_id, address, MAX(taken_at) AS taken_at FROM positions WHERE chain_id = ?1 GROUP BY chain_id, market_id, address) m
    ON p.chain_id = m.chain_id AND p.market_id = m.market_id AND p.address = m.address AND p.taken_at = m.taken_at
  ORDER BY p.protection_case DESC, (p.shadow_hf IS NULL) ASC, p.shadow_hf ASC, p.venue_hf ASC`;

export function d1Stores(db: D1Database): Stores {
  const capture: CaptureStore = {
    async getRun(at) {
      const r = await db.prepare("SELECT * FROM capture_runs WHERE transition_at = ?1").bind(at).first<RunDbRow>();
      return r ? runFromDb(r) : null;
    },
    async putRun(run) {
      await db
        .prepare(
          `INSERT OR REPLACE INTO capture_runs (transition_at, from_session, to_session, kind, armed_at, first_update_at, completed_at, summary_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(run.transitionAt, run.fromSession, run.toSession, run.kind, run.armedAt, run.firstUpdateAt, run.completedAt, JSON.stringify(run.summary))
        .run();
    },
    async latestRun() {
      const r = await db.prepare("SELECT * FROM capture_runs ORDER BY transition_at DESC LIMIT 1").first<RunDbRow>();
      return r ? runFromDb(r) : null;
    },
    async listRuns(limit) {
      const { results } = await db.prepare("SELECT * FROM capture_runs ORDER BY transition_at DESC LIMIT ?1").bind(limit).all<RunDbRow>();
      return results.map(runFromDb);
    },
    async addRows(rows) {
      if (rows.length === 0) return;
      const stmt = db.prepare(
        `INSERT INTO captures (transition_at, from_session, to_session, token_symbol, phase, taken_at, block_number, feed_round_id, feed_answer, feed_updated_at, dex_price, twap_price, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      );
      await db.batch(
        rows.map((r) =>
          stmt.bind(r.transitionAt, r.fromSession, r.toSession, r.tokenSymbol, r.phase, r.takenAt, r.blockNumber, r.feedRoundId, r.feedAnswer, r.feedUpdatedAt, r.dexPrice, r.twapPrice, r.note),
        ),
      );
    },
    async rowsFor(at) {
      const { results } = await db.prepare("SELECT * FROM captures WHERE transition_at = ?1 ORDER BY taken_at ASC, token_symbol ASC").bind(at).all<CaptureDbRow>();
      return results.map(captureFromDb);
    },
    async lastHeldPrint(symbol, at) {
      const r = await db
        .prepare("SELECT feed_answer, feed_updated_at FROM snapshots WHERE symbol = ?1 AND feed_updated_at <= ?2 ORDER BY feed_updated_at DESC, taken_at DESC LIMIT 1")
        .bind(symbol, at)
        .first<{ feed_answer: string; feed_updated_at: number }>();
      return r ? { answer: r.feed_answer, updatedAt: r.feed_updated_at } : null;
    },
  };

  const positions: PositionStore = {
    async borrowers(chainId) {
      const { results } = await db.prepare("SELECT * FROM borrowers WHERE chain_id = ?1").bind(chainId).all<{ chain_id: number; market_id: string; address: string; first_seen_block: number; source: string }>();
      return results.map((r) => ({ chainId: r.chain_id, marketId: r.market_id as Hex, address: r.address as Address, firstSeenBlock: r.first_seen_block, source: r.source as Borrower["source"] }));
    },
    async addBorrowers(list) {
      if (list.length === 0) return 0;
      const stmt = db.prepare("INSERT OR IGNORE INTO borrowers (chain_id, market_id, address, first_seen_block, source) VALUES (?1, ?2, ?3, ?4, ?5)");
      const res = await db.batch(list.map((b) => stmt.bind(b.chainId, b.marketId.toLowerCase(), b.address, b.firstSeenBlock, b.source)));
      return res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    },
    async cursor(chainId) {
      const r = await db.prepare("SELECT MIN(last_block) AS b FROM scan_cursors WHERE chain_id = ?1").bind(chainId).first<{ b: number | null }>();
      return r?.b ?? null;
    },
    async setCursor(chainId, marketIds, lastBlock, at) {
      if (marketIds.length === 0) return;
      const stmt = db.prepare("INSERT OR REPLACE INTO scan_cursors (chain_id, market_id, last_block, updated_at) VALUES (?1, ?2, ?3, ?4)");
      await db.batch(marketIds.map((id) => stmt.bind(chainId, id.toLowerCase(), lastBlock, at)));
    },
    async addPositions(rows) {
      if (rows.length === 0) return;
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO positions (chain_id, market_id, address, taken_at, block_number, collateral_symbol, lltv, collateral, borrow_shares, debt_assets, venue_price, shadow_price, venue_hf, shadow_hf, protection_case)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      );
      await db.batch(
        rows.map((p) =>
          stmt.bind(p.chainId, p.marketId.toLowerCase(), p.address, p.takenAt, p.blockNumber, p.collateralSymbol, p.lltv, p.collateral, p.borrowShares, p.debtAssets, p.venuePrice, p.shadowPrice, p.venueHf, p.shadowHf, p.protectionCase ? 1 : 0),
        ),
      );
    },
    async latestPositions(chainId) {
      const { results } = await db.prepare(LATEST_POSITIONS_SQL).bind(chainId).all<PositionDbRow>();
      return results.map(positionFromDb);
    },
    async positionsForAddress(address) {
      const { results } = await db
        .prepare("SELECT * FROM positions WHERE lower(address) = lower(?1) ORDER BY taken_at DESC, market_id ASC LIMIT 50")
        .bind(address)
        .all<PositionDbRow>();
      return results.map(positionFromDb);
    },
    async lastPositionsTakenAt(chainId) {
      const r = await db.prepare("SELECT MAX(taken_at) AS t FROM positions WHERE chain_id = ?1").bind(chainId).first<{ t: number | null }>();
      return r?.t ?? null;
    },
  };

  return { capture, positions };
}

// ---------------------------------------------------------------- memory (tests)

export interface MemorySeed {
  runs?: CaptureRunRecord[];
  captures?: CaptureRow[];
  borrowers?: Borrower[];
  cursors?: Array<{ chainId: number; marketId: Hex; lastBlock: number }>;
  positions?: PositionRow[];
  /** Snapshot prints for lastHeldPrint: symbol -> prints. */
  prints?: Array<{ symbol: string; answer: string; updatedAt: number; takenAt: number }>;
}

export interface MemoryStores extends Stores {
  state: Required<MemorySeed>;
}

export function memoryStores(seed: MemorySeed = {}): MemoryStores {
  const state: Required<MemorySeed> = {
    runs: [...(seed.runs ?? [])],
    captures: [...(seed.captures ?? [])],
    borrowers: [...(seed.borrowers ?? [])],
    cursors: [...(seed.cursors ?? [])],
    positions: [...(seed.positions ?? [])],
    prints: [...(seed.prints ?? [])],
  };
  const capture: CaptureStore = {
    async getRun(at) {
      return state.runs.find((r) => r.transitionAt === at) ?? null;
    },
    async putRun(run) {
      const i = state.runs.findIndex((r) => r.transitionAt === run.transitionAt);
      const copy = structuredClone(run);
      if (i >= 0) state.runs[i] = copy;
      else state.runs.push(copy);
    },
    async latestRun() {
      return [...state.runs].sort((a, b) => b.transitionAt - a.transitionAt)[0] ?? null;
    },
    async listRuns(limit) {
      return [...state.runs].sort((a, b) => b.transitionAt - a.transitionAt).slice(0, limit);
    },
    async addRows(rows) {
      state.captures.push(...rows.map((r) => ({ ...r })));
    },
    async rowsFor(at) {
      return state.captures.filter((r) => r.transitionAt === at).sort((a, b) => a.takenAt - b.takenAt || a.tokenSymbol.localeCompare(b.tokenSymbol));
    },
    async lastHeldPrint(symbol, at) {
      const hit = state.prints
        .filter((p) => p.symbol === symbol && p.updatedAt <= at)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.takenAt - a.takenAt)[0];
      return hit ? { answer: hit.answer, updatedAt: hit.updatedAt } : null;
    },
  };
  const key = (b: { chainId: number; marketId: string; address: string }) => `${b.chainId}:${b.marketId.toLowerCase()}:${b.address.toLowerCase()}`;
  const positions: PositionStore = {
    async borrowers(chainId) {
      return state.borrowers.filter((b) => b.chainId === chainId);
    },
    async addBorrowers(list) {
      const have = new Set(state.borrowers.map(key));
      let n = 0;
      for (const b of list) {
        const k = key(b);
        if (have.has(k)) continue;
        have.add(k);
        state.borrowers.push({ ...b, marketId: b.marketId.toLowerCase() as Hex });
        n += 1;
      }
      return n;
    },
    async cursor(chainId) {
      const rows = state.cursors.filter((c) => c.chainId === chainId);
      return rows.length === 0 ? null : Math.min(...rows.map((c) => c.lastBlock));
    },
    async setCursor(chainId, marketIds, lastBlock) {
      for (const id of marketIds) {
        const i = state.cursors.findIndex((c) => c.chainId === chainId && c.marketId.toLowerCase() === id.toLowerCase());
        const row = { chainId, marketId: id.toLowerCase() as Hex, lastBlock };
        if (i >= 0) state.cursors[i] = row;
        else state.cursors.push(row);
      }
    },
    async addPositions(rows) {
      for (const p of rows) {
        const i = state.positions.findIndex((q) => key(q) === key(p) && q.takenAt === p.takenAt);
        if (i >= 0) state.positions[i] = { ...p };
        else state.positions.push({ ...p });
      }
    },
    async latestPositions(chainId) {
      const latest = new Map<string, PositionRow>();
      for (const p of state.positions) {
        if (p.chainId !== chainId) continue;
        const k = key(p);
        const cur = latest.get(k);
        if (!cur || p.takenAt > cur.takenAt) latest.set(k, p);
      }
      return [...latest.values()].sort((a, b) => Number(b.protectionCase) - Number(a.protectionCase) || (a.shadowHf ?? Infinity) - (b.shadowHf ?? Infinity));
    },
    async positionsForAddress(address) {
      return state.positions.filter((p) => p.address.toLowerCase() === address.toLowerCase()).sort((a, b) => b.takenAt - a.takenAt).slice(0, 50);
    },
    async lastPositionsTakenAt(chainId) {
      const rows = state.positions.filter((p) => p.chainId === chainId);
      return rows.length === 0 ? null : Math.max(...rows.map((p) => p.takenAt));
    },
  };
  return { capture, positions, state };
}
