import { describe, expect, it } from "vitest";
import { concatHex, encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { ZERO_ROOT, chainRoot, eventHash, sortForRoot, type RootEvent } from "../src/roots.js";

// The pre-8 Oct implementation (viem abi.encode over hex strings), kept here as the reference the byte-level one must
// reproduce exactly: every daily root stored before the change was computed with it.
function referenceEventHash(e: RootEvent): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      [BigInt(e.chainId), e.txHash, BigInt(e.logIndex), e.address, e.topic0, keccak256(stringToHex(e.argsJson))],
    ),
  );
}
function referenceChainRoot(prevRoot: Hex, events: readonly RootEvent[]): Hex {
  return keccak256(concatHex([prevRoot, ...sortForRoot(events).map(referenceEventHash)]));
}

function hex(n: number, bytes: number): Hex {
  return `0x${n.toString(16).padStart(bytes * 2, "0").slice(-bytes * 2)}` as Hex;
}

const ARGS = ['{"id":"0x4a03"}', "{}", '{"description":"Thanksgiving — early close ✓","id":"1"}', `{"x":"${"9".repeat(300)}"}`];

function ev(i: number): RootEvent {
  return {
    chainId: i % 2 ? 8453 : 84532,
    blockNumber: 52_000_000 + (i % 7),
    txHash: keccak256(hex(i, 4)),
    logIndex: i % 5,
    address: hex(0xb2000000 + i, 20) as `0x${string}`,
    topic0: keccak256(hex(i * 31, 4)),
    argsJson: ARGS[i % ARGS.length]!,
  };
}

describe("byte-level roots versus the abi.encode reference", () => {
  it("eventHash is identical on 200 events (multi-byte UTF-8 and long args included)", () => {
    for (let i = 0; i < 200; i += 1) expect(eventHash(ev(i))).toBe(referenceEventHash(ev(i)));
  });
  it("chainRoot is identical for empty, single and unsorted multi-event days", () => {
    const events = Array.from({ length: 60 }, (_, i) => ev(i)).reverse();
    const prev = keccak256("0x1234");
    expect(chainRoot(ZERO_ROOT, [])).toBe(referenceChainRoot(ZERO_ROOT, []));
    expect(chainRoot(prev, events.slice(0, 1))).toBe(referenceChainRoot(prev, events.slice(0, 1)));
    expect(chainRoot(prev, events)).toBe(referenceChainRoot(prev, events));
  });
  it("rejects a malformed 32-byte field exactly where abi.encode would", () => {
    expect(() => eventHash({ ...ev(1), topic0: "0x" })).toThrow();
    expect(() => referenceEventHash({ ...ev(1), topic0: "0x" })).toThrow();
  });
});
