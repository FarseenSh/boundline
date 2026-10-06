import { describe, expect, it } from "vitest";
import { buildEventQuery } from "../src/store-d1.js";
import { MemoryStore } from "../src/store-memory.js";
import { BORROWER, CHAIN, DEPLOYER, MORPHO, row, txHash } from "./fixtures.js";

describe("MemoryStore.queryEvents filters", () => {
  async function seeded() {
    const store = new MemoryStore();
    await store.insertEvents([
      row({ blockNumber: 1, blockTime: 100, txHash: txHash(1), address: MORPHO, name: "Borrow", argsJson: '{"lineId":"1","user":"0xaa"}' }),
      row({ blockNumber: 2, blockTime: 200, txHash: txHash(2), address: BORROWER, name: "Decision", argsJson: '{"lineId":"10","user":"0xbb"}' }),
      row({ blockNumber: 3, blockTime: 300, txHash: txHash(3), address: DEPLOYER, name: "Repay", argsJson: '{"lineId":"1","user":"0xcc"}' }),
    ]);
    return store;
  }
  it("matches several addresses and names, a time floor and an args substring", async () => {
    const store = await seeded();
    const two = await store.queryEvents({ chainId: CHAIN, addresses: [MORPHO.toUpperCase(), DEPLOYER], limit: 10 });
    expect(two.map((e) => e.blockNumber)).toEqual([3, 1]);
    const names = await store.queryEvents({ chainId: CHAIN, names: ["Borrow", "Decision"], limit: 10 });
    expect(names.map((e) => e.name)).toEqual(["Decision", "Borrow"]);
    const since = await store.queryEvents({ chainId: CHAIN, fromTime: 200, limit: 10 });
    expect(since.map((e) => e.blockNumber)).toEqual([3, 2]);
    const line1 = await store.queryEvents({ chainId: CHAIN, argsContains: '"lineId":"1"', limit: 10 });
    expect(line1.map((e) => e.blockNumber)).toEqual([3, 1]); // "10" does not match "1" thanks to the closing quote
  });
});

describe("buildEventQuery", () => {
  it("adds one clause per filter, in order, with the limit last", () => {
    const { sql, params } = buildEventQuery({
      chainId: 8453,
      addresses: ["0xAA", "0xbb"],
      names: ["Borrow", "Repay"],
      fromBlock: 10,
      toBlock: 20,
      fromTime: 1_000,
      argsContains: '"lineId":"1"',
      before: { blockNumber: 15, logIndex: 2 },
      limit: 50,
    });
    expect(sql).toContain("address IN (?, ?)");
    expect(sql).toContain("name IN (?, ?)");
    expect(sql).toContain("block_number >= ?");
    expect(sql).toContain("block_time >= ?");
    expect(sql).toContain("instr(args_json, ?) > 0");
    expect(sql).toContain("(block_number < ? OR (block_number = ? AND log_index < ?))");
    expect(sql.trim().endsWith("ORDER BY block_number DESC, log_index DESC LIMIT ?")).toBe(true);
    expect(params).toEqual([8453, "0xaa", "0xbb", "Borrow", "Repay", 10, 20, 1_000, '"lineId":"1"', 15, 15, 2, 50]);
  });
  it("uses equality for a single address or name and passes a long bytes32 needle through untouched", () => {
    const needle = '"decisionHash":"0x56f7e74ca5ce08307ba7c750f029a82976bb96bed1ea8e787fe002e90615c395"';
    const { sql, params } = buildEventQuery({ chainId: 84532, address: "0xAB", name: "Decision", argsContains: needle, limit: 5 });
    expect(sql).toContain("address = ?");
    expect(sql).toContain("name = ?");
    expect(sql).not.toContain("LIKE");
    expect(params).toEqual([84532, "0xab", "Decision", needle, 5]);
    expect(buildEventQuery({ chainId: 1, limit: 1 }).sql).toBe(
      "SELECT chain_id, block_number, block_time, tx_hash, log_index, address, topic0, name, args_json FROM events WHERE chain_id = ? ORDER BY block_number DESC, log_index DESC LIMIT ?",
    );
  });
});
