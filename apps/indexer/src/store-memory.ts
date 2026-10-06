import type { EventRow } from "./decode.js";
import { byBlockAsc, eventKey, queryAddresses, queryNames, type CursorRow, type DailyRootRow, type EventQuery, type ReconciliationRow, type Store } from "./store.js";

/** In-memory Store with the same semantics as D1Store; used by the tests and local experiments. */
export class MemoryStore implements Store {
  readonly events = new Map<string, EventRow>();
  readonly cursors = new Map<string, CursorRow>();
  readonly roots = new Map<string, DailyRootRow>();
  readonly reconciliations: ReconciliationRow[] = [];

  async getCursor(chainId: number, source: string): Promise<CursorRow | null> {
    return this.cursors.get(`${chainId}:${source}`) ?? null;
  }
  async setCursor(row: CursorRow): Promise<void> {
    this.cursors.set(`${row.chainId}:${row.source}`, { ...row });
  }
  async listCursors(): Promise<CursorRow[]> {
    return [...this.cursors.values()].sort((a, b) => a.chainId - b.chainId || a.source.localeCompare(b.source));
  }
  async insertEvents(rows: readonly EventRow[]): Promise<number> {
    let added = 0;
    for (const r of rows) {
      const k = eventKey(r);
      if (this.events.has(k)) continue;
      this.events.set(k, { ...r });
      added += 1;
    }
    return added;
  }
  async queryEvents(q: EventQuery): Promise<EventRow[]> {
    const addresses = queryAddresses(q);
    const names = queryNames(q);
    const rows = [...this.events.values()]
      .filter((e) => e.chainId === q.chainId)
      .filter((e) => addresses.length === 0 || addresses.includes(e.address))
      .filter((e) => names.length === 0 || names.includes(e.name))
      .filter((e) => q.fromBlock === undefined || e.blockNumber >= q.fromBlock)
      .filter((e) => q.toBlock === undefined || e.blockNumber <= q.toBlock)
      .filter((e) => q.fromTime === undefined || e.blockTime >= q.fromTime)
      .filter((e) => !q.argsContains || e.argsJson.includes(q.argsContains))
      .filter(
        (e) =>
          q.before === undefined ||
          e.blockNumber < q.before.blockNumber ||
          (e.blockNumber === q.before.blockNumber && e.logIndex < q.before.logIndex),
      )
      .sort((a, b) => byBlockAsc(b, a));
    return rows.slice(0, q.limit);
  }
  async eventsBetween(chainId: number, fromTime: number, toTime: number): Promise<EventRow[]> {
    return [...this.events.values()]
      .filter((e) => e.chainId === chainId && e.blockTime >= fromTime && e.blockTime < toTime)
      .sort(byBlockAsc);
  }
  async eventsOfAddress(chainId: number, address: string): Promise<EventRow[]> {
    const a = address.toLowerCase();
    return [...this.events.values()].filter((e) => e.chainId === chainId && e.address === a).sort(byBlockAsc);
  }
  async earliestEventTime(chainId: number): Promise<number | null> {
    let min: number | null = null;
    for (const e of this.events.values()) {
      if (e.chainId !== chainId) continue;
      if (min === null || e.blockTime < min) min = e.blockTime;
    }
    return min;
  }
  async getRoot(chainId: number, day: string): Promise<DailyRootRow | null> {
    return this.roots.get(`${chainId}:${day}`) ?? null;
  }
  async latestRoot(chainId: number): Promise<DailyRootRow | null> {
    const rows = await this.listRoots(chainId, 1);
    return rows[0] ?? null;
  }
  async listRoots(chainId: number, limit: number): Promise<DailyRootRow[]> {
    return [...this.roots.values()]
      .filter((r) => r.chainId === chainId)
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      .slice(0, limit);
  }
  async putRoot(row: DailyRootRow): Promise<void> {
    this.roots.set(`${row.chainId}:${row.day}`, { ...row });
  }
  async insertReconciliations(rows: readonly ReconciliationRow[]): Promise<void> {
    for (const r of rows) this.reconciliations.push({ ...r, id: this.reconciliations.length + 1 });
  }
  async latestReconciliations(chainId: number): Promise<ReconciliationRow[]> {
    const mine = this.reconciliations.filter((r) => r.chainId === chainId);
    const last = Math.max(-1, ...mine.map((r) => r.checkedAt));
    return mine.filter((r) => r.checkedAt === last);
  }
}
