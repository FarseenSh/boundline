import { describe, expect, it } from "vitest";
import { argNeedle, createApp, feedForSymbol, feedGaps, toFeedRound } from "../src/app.js";
import type { Env } from "../src/env.js";
import { MAINNET_STACK, SEPOLIA_STACK, mainnetSources, sepoliaSources } from "../src/sources.js";
import { MemoryStore } from "../src/store-memory.js";
import { CHAIN, row, txHash } from "./fixtures.js";

const DESK = "0x39abadc0aaa12d1f7e259b89536aa1848997399a";
const PARTNER = "0x626f756e646c696e652d6170700000000000000000000000000000000000000000".slice(0, 66);
const USER = "0xb789ad318945b37566e2549f65526cc269a482fc";
const AAPL_AGG = MAINNET_STACK.feeds[0]!.aggregator.toLowerCase();
const SPOKE = MAINNET_STACK.aaveMag7Spoke.toLowerCase();
const env = { CREDIT_DESK_SEPOLIA: "0x39aBaDc0aAa12D1F7e259b89536Aa1848997399a", INDEX_MAINNET: "true" } as Env;

const HOUR = 3600;
const FRI_CLOSE = 1_791_158_400 - 52 * HOUR; // an instant on Friday evening (ET) before the Sun 4 Oct 2026 20:00 ET reopen
const SUN_REOPEN = 1_791_158_400 + 120; // first print after the reopen

async function setup() {
  const store = new MemoryStore();
  await store.insertEvents([
    // mainnet feed prints: two Friday prints, a 52 h pause, the reopen print
    row({ chainId: 8453, blockNumber: 100, logIndex: 0, blockTime: FRI_CLOSE - HOUR, txHash: txHash(100), address: AAPL_AGG as `0x${string}`, name: "AnswerUpdated", argsJson: '{"current":"33000000000","roundId":"10","updatedAt":"' + (FRI_CLOSE - HOUR) + '"}' }),
    row({ chainId: 8453, blockNumber: 110, logIndex: 0, blockTime: FRI_CLOSE, txHash: txHash(110), address: AAPL_AGG as `0x${string}`, name: "AnswerUpdated", argsJson: '{"current":"33366495000","roundId":"11","updatedAt":"' + FRI_CLOSE + '"}' }),
    row({ chainId: 8453, blockNumber: 200, logIndex: 0, blockTime: SUN_REOPEN, txHash: txHash(200), address: AAPL_AGG as `0x${string}`, name: "AnswerUpdated", argsJson: '{"current":"33267000000","roundId":"12","updatedAt":"' + SUN_REOPEN + '"}' }),
    // Aave spoke borrows
    row({ chainId: 8453, blockNumber: 150, logIndex: 0, blockTime: FRI_CLOSE, txHash: txHash(150), address: SPOKE as `0x${string}`, name: "Borrow", argsJson: '{"caller":"0x0a","drawnAmount":"1000000","drawnShares":"1","reserveId":"7","user":"0xaaaa"}' }),
    row({ chainId: 8453, blockNumber: 160, logIndex: 0, blockTime: FRI_CLOSE + 10, txHash: txHash(160), address: SPOKE as `0x${string}`, name: "Borrow", argsJson: '{"caller":"0x0a","drawnAmount":"2000000","drawnShares":"2","reserveId":"7","user":"0xbbbb"}' }),
    row({ chainId: 8453, blockNumber: 170, logIndex: 0, blockTime: FRI_CLOSE + 20, txHash: txHash(170), address: SPOKE as `0x${string}`, name: "Borrow", argsJson: '{"caller":"0x0a","drawnAmount":"3000000","drawnShares":"3","reserveId":"7","user":"0xAAAA"}' }),
    row({ chainId: 8453, blockNumber: 171, logIndex: 0, blockTime: FRI_CLOSE + 20, txHash: txHash(171), address: SPOKE as `0x${string}`, name: "Repay", argsJson: '{"user":"0xaaaa"}' }),
    // Sepolia desk: two lines for the partner, one for another partner, plus line 1's timeline
    row({ chainId: CHAIN, blockNumber: 500, logIndex: 0, blockTime: 1_791_050_000, txHash: txHash(500), address: DESK, name: "LineOpened", argsJson: `{"decisionHash":"0x01","lineId":"1","marketId":"${SEPOLIA_STACK.market.id}","partnerId":"${PARTNER}","policyVersion":1,"user":"${USER}"}` }),
    row({ chainId: CHAIN, blockNumber: 500, logIndex: 1, blockTime: 1_791_050_000, txHash: txHash(500), address: DESK, name: "Decision", argsJson: `{"action":"0x4f50454e00000000000000000000000000000000000000000000000000000000","amount":"0","decisionHash":"0x01","lineId":"1","price8":"0"}` }),
    row({ chainId: CHAIN, blockNumber: 600, logIndex: 0, blockTime: 1_791_060_000, txHash: txHash(600), address: DESK, name: "Drawn", argsJson: `{"amount":"5000000","decisionHash":"0x02","lineId":"1","price8":"33267000000","session":1}` }),
    row({ chainId: CHAIN, blockNumber: 700, logIndex: 0, blockTime: 1_791_070_000, txHash: txHash(700), address: DESK, name: "LineOpened", argsJson: `{"decisionHash":"0x03","lineId":"10","marketId":"${SEPOLIA_STACK.market.id}","partnerId":"${PARTNER}","policyVersion":1,"user":"0x0c"}` }),
    row({ chainId: CHAIN, blockNumber: 800, logIndex: 0, blockTime: 1_791_080_000, txHash: txHash(800), address: DESK, name: "LineOpened", argsJson: `{"decisionHash":"0x04","lineId":"11","marketId":"${SEPOLIA_STACK.market.id}","partnerId":"0x${"ab".repeat(32)}","policyVersion":1,"user":"0x0d"}` }),
  ]);
  await store.setCursor({ chainId: 8453, source: "mainnet-feeds", lastBlock: 210, lastBlockTime: SUN_REOPEN + 100, updatedAt: 5 });
  const app = createApp({ store: () => store, sources: (e) => [...sepoliaSources(e), ...mainnetSources(e)], now: () => SUN_REOPEN + 1000 });
  const get = async (path: string) => {
    const res = await app.request(path, undefined, env);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { store, get };
}

describe("helpers", () => {
  it("argNeedle lowercases hex and keeps decimals", () => {
    expect(argNeedle("lineId", "1")).toBe('"lineId":"1"');
    expect(argNeedle("partnerId", "0xABCD")).toBe('"partnerId":"0xabcd"');
  });
  it("feedForSymbol resolves mainnet aggregators and Sepolia test feeds", () => {
    expect(feedForSymbol("AAPLc", 8453)).toEqual({ chainId: 8453, feed: MAINNET_STACK.feeds[0]!.proxy, emitter: MAINNET_STACK.feeds[0]!.aggregator, token: MAINNET_STACK.feeds[0]!.token });
    expect(feedForSymbol("aaplt", 84532)).toEqual({ chainId: 84532, feed: SEPOLIA_STACK.feeds.AAPLt, emitter: SEPOLIA_STACK.feeds.AAPLt, token: SEPOLIA_STACK.tokens.AAPLt });
    expect(feedForSymbol("AAPLt", 8453)).toBeNull();
    expect(feedForSymbol("AAPLc", 1)).toBeNull();
  });
  it("toFeedRound and feedGaps turn prints into rounds and report the long pauses", () => {
    const r = toFeedRound(row({ name: "AnswerUpdated", argsJson: '{"current":"33267000000","roundId":"12","updatedAt":"1791158520"}' }));
    expect(r).toMatchObject({ roundId: "12", answer: "33267000000", price: 332.67, updatedAt: 1_791_158_520 });
    expect(toFeedRound(row({ name: "Borrow" }))).toBeNull();
    const rounds = [
      { roundId: "3", answer: "110", price: 0, updatedAt: 200 * HOUR, blockNumber: 3, blockTime: 0, txHash: "0x3" },
      { roundId: "2", answer: "100", price: 0, updatedAt: 100 * HOUR, blockNumber: 2, blockTime: 0, txHash: "0x2" },
      { roundId: "1", answer: "90", price: 0, updatedAt: 99 * HOUR, blockNumber: 1, blockTime: 0, txHash: "0x1" },
    ];
    const gaps = feedGaps(rounds);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ fromUpdatedAt: 100 * HOUR, toUpdatedAt: 200 * HOUR, hours: 100, heldAnswer: "100", nextAnswer: "110", moveBps: 1000 });
  });
});

describe("phase-2 routes", () => {
  it("/v1/sources lists every source with its cursor and the mainnet constants", async () => {
    const { get } = await setup();
    const r = await get("/v1/sources");
    expect(r.body.count).toBe(8);
    const feeds = (r.body.sources as { id: string; cursor: { lastBlock: number } | null; addresses: number }[]).find((s) => s.id === "mainnet-feeds")!;
    expect(feeds.cursor?.lastBlock).toBe(210);
    expect(feeds.addresses).toBe(10);
    expect(r.body.mainnet.markets).toHaveLength(13);
  });

  it("/v1/events accepts chainId, source, since and argument filters", async () => {
    const { get } = await setup();
    const bySource = await get("/v1/events?chainId=8453&source=mainnet-aave-mag7-spoke");
    expect(bySource.body.source).toBe("mainnet-aave-mag7-spoke");
    expect(bySource.body.count).toBe(4);
    const since = await get(`/v1/events?chainId=8453&source=mainnet-feeds&since=${FRI_CLOSE}`);
    expect((since.body.events as { blockNumber: number }[]).map((e) => e.blockNumber)).toEqual([200, 110]);
    const byLine = await get("/v1/events?chain=84532&lineId=1");
    expect((byLine.body.events as { name: string }[]).map((e) => e.name)).toEqual(["Drawn", "Decision", "LineOpened"]);
    const byHash = await get("/v1/events?chain=84532&name=Decision&decisionHash=0x01");
    expect(byHash.body.count).toBe(1);
    const byUser = await get("/v1/events?chainId=8453&user=0xAAAA&name=Borrow");
    expect(byUser.body.count).toBe(1); // canonical args store the hex lowercased, so the uppercase row was stored as 0xaaaa only if emitted so
    const twoFilters = await get("/v1/events?chain=84532&lineId=1&decisionHash=0x02");
    expect((twoFilters.body.events as { name: string }[]).map((e) => e.name)).toEqual(["Drawn"]);
    expect((await get("/v1/events?chainId=8453&source=nope")).status).toBe(404);
    expect((await get("/v1/events?chainId=84532&source=mainnet-feeds")).status).toBe(404);
  });

  it("/v1/feeds/:symbol/rounds returns the prints newest first with the weekend gap", async () => {
    const { get } = await setup();
    const r = await get("/v1/feeds/AAPLc/rounds");
    expect(r.status).toBe(200);
    expect(r.body.emitter).toBe(MAINNET_STACK.feeds[0]!.aggregator);
    expect((r.body.rounds as { roundId: string }[]).map((x) => x.roundId)).toEqual(["12", "11", "10"]);
    expect(r.body.gaps).toHaveLength(1);
    expect(r.body.gaps[0]).toMatchObject({ fromUpdatedAt: FRI_CLOSE, toUpdatedAt: SUN_REOPEN, heldAnswer: "33366495000", nextAnswer: "33267000000" });
    expect(r.body.gaps[0].hours).toBeCloseTo(52.03, 1);
    const since = await get(`/v1/feeds/AAPLc/rounds?since=${SUN_REOPEN}`);
    expect(since.body.count).toBe(1);
    expect(since.body.gaps).toEqual([]);
    expect((await get("/v1/feeds/XXXc/rounds")).status).toBe(404);
    expect((await get("/v1/feeds/AAPLt/rounds?chain=84532")).status).toBe(200);
  });

  it("/v1/venues/aave/borrowers groups the Borrow events by user", async () => {
    const { get } = await setup();
    const r = await get("/v1/venues/aave/borrowers");
    expect(r.body.spoke).toBe(MAINNET_STACK.aaveMag7Spoke);
    expect(r.body.borrowEvents).toBe(3);
    expect(r.body.cutoffBlock).toBe(MAINNET_STACK.blocks.phase2Start);
    const borrowers = r.body.borrowers as { address: string; borrows: number; firstBlock: number; lastBlock: number; reserveIds: string[] }[];
    expect(borrowers.map((b) => b.address)).toEqual(["0xaaaa", "0xbbbb"]);
    expect(borrowers[0]).toMatchObject({ borrows: 2, firstBlock: 150, lastBlock: 170, reserveIds: ["7"] });
    const since = await get(`/v1/venues/aave/borrowers?since=${FRI_CLOSE + 5}`);
    expect(since.body.borrowEvents).toBe(2);
  });

  it("/v1/desk/lines filters by partner and /v1/desk/lines/:id/timeline returns the line's events oldest first", async () => {
    const { get } = await setup();
    const all = await get("/v1/desk/lines");
    expect((all.body.lines as { lineId: string }[]).map((l) => l.lineId)).toEqual(["11", "10", "1"]);
    const mine = await get(`/v1/desk/lines?partnerId=${PARTNER}`);
    expect((mine.body.lines as { lineId: string; user: string }[]).map((l) => l.lineId)).toEqual(["10", "1"]);
    expect(mine.body.lines[1]).toMatchObject({ lineId: "1", user: USER, marketId: SEPOLIA_STACK.market.id, policyVersion: 1, decisionHash: "0x01", blockNumber: 500, txHash: txHash(500) });
    expect((await get("/v1/desk/lines?partnerId=boundline-app")).status).toBe(400);
    const tl = await get("/v1/desk/lines/1/timeline");
    expect(tl.body.count).toBe(3);
    expect((tl.body.events as { name: string; blockNumber: number }[]).map((e) => [e.name, e.blockNumber])).toEqual([
      ["LineOpened", 500],
      ["Decision", 500],
      ["Drawn", 600],
    ]);
    expect((await get("/v1/desk/lines/0/timeline")).status).toBe(400);
    expect((await get("/v1/desk/lines/10/timeline")).body.count).toBe(1);
    // a deployment without the desk source answers 503
    const bare = createApp({ store: () => new MemoryStore(), sources: () => [] });
    const res = await bare.request("/v1/desk/lines", undefined, env);
    expect(res.status).toBe(503);
  });
});
