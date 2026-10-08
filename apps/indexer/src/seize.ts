// Seize watch (plan M9). Cobalt gave B20 issuers `seizeWithMemo`: an account holding SEIZE_ROLE can move tokens out of
// any account that the token's SEIZE_EXEMPT_POLICY does not authorise. A seize from a venue's pool address (Morpho Blue,
// the Aave V4 hub) would take every borrower's collateral at once, so the watch answers three questions per stock:
// does anyone hold SEIZE_ROLE, which policy decides exemption, and are the venues exempt under it.
//
// Sources: the full-history baseline of 8 Oct 2026 (src/seize-baseline.ts, from creation to block 52,327,100), the
// indexer's mainnet-b20-tokens and mainnet-policy-registry events after it, and two live Multicall3 reads (each stock's
// two seize policies, then `isAuthorized(policy, venue)` for every distinct exemption policy).
import type { Address, Hex } from "viem";
import type { EventRow } from "./decode.js";
import { GET_BLOCK_NUMBER, MULTICALL3, decodeAggregate3, encodeAggregate3, wordAddress, wordUint, type Call } from "./multicall.js";
import type { RawRpc } from "./rpc.js";
import { SEIZE_BASELINE } from "./seize-baseline.js";
import { MAINNET, MAINNET_STACK, SOURCE_IDS } from "./sources.js";
import type { Store } from "./store.js";

/** keccak256 of the base-std v1.1.0 B20Constants names. */
export const SEIZE_ROLE: Hex = "0x3469b8b0d89e9604f8510ed143f74a8336d22955d4f83e23bf53d9414e27f432";
export const SEIZE_EXEMPT_POLICY: Hex = "0xedb5da348cfb67af08746d3afd1be81034b50d5c8576f31aff688f39dfd540ed";
export const SEIZE_RECEIVER_POLICY: Hex = "0xbf15b19caf5c77422c038bc25f26b8b815c3a14f6d04c6616076b81bcfe07b3d";
const POLICY_ID = "0xdb3de624"; // IB20.policyId(bytes32)
const IS_AUTHORIZED = "0x55a1179e"; // IPolicyRegistry.isAuthorized(uint64,address)

/** The pools that hold B20 collateral for borrowers, or swap it for them. */
export const SEIZE_VENUES: readonly { name: string; address: Address }[] = [
  { name: "Morpho Blue", address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" },
  { name: "Aave V4 hub", address: "0xa4d5947Eb727A052bae69C593FfC84247EC9864E" },
  { name: "Aave V4 MAG7 spoke", address: "0x17905Db0e4A3514467539956c084180616AE7B8D" },
  { name: "Aave Taker position manager", address: "0x8481204E528735aF2F3391AD98f36E757A56D695" },
  { name: "Aave Giver position manager", address: "0x9E81c2fDE4E34CAB3AB1667ca3c932dBAED95F08" },
  { name: "Aerodrome AAPLc/USDC", address: "0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0" },
  { name: "Aerodrome NVDAc/USDC", address: "0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9" },
];

export interface SeizeLive {
  block: number;
  /** symbol → the two policy ids the stock binds now */
  policies: Record<string, { seizeExempt: number; seizeReceiver: number }>;
  /** exemption policy id → venue address → authorised (exempt) */
  venueExempt: Record<string, Record<string, boolean>>;
}

function args(e: EventRow): Record<string, unknown> {
  try {
    return JSON.parse(e.argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The live part: one aggregate3 for every stock's two policies, one for the venues under each exemption policy. */
export async function readSeizeLive(rpc: RawRpc): Promise<SeizeLive> {
  const tokens = MAINNET_STACK.feeds;
  const first: Call[] = [{ target: MULTICALL3, callData: GET_BLOCK_NUMBER as Hex }];
  for (const f of tokens) {
    first.push({ target: f.token, callData: `${POLICY_ID}${SEIZE_EXEMPT_POLICY.slice(2)}` as Hex });
    first.push({ target: f.token, callData: `${POLICY_ID}${SEIZE_RECEIVER_POLICY.slice(2)}` as Hex });
  }
  const r1 = decodeAggregate3(await rpc.call<Hex>("eth_call", [{ to: MULTICALL3, data: encodeAggregate3(first) }, "latest"]));
  const block = Number(BigInt(`0x${r1[0]!.data}`));
  const tag = `0x${block.toString(16)}`;
  const policies: SeizeLive["policies"] = {};
  tokens.forEach((f, i) => {
    const ex = r1[1 + i * 2]!;
    const rc = r1[2 + i * 2]!;
    if (!ex.success || !rc.success) throw new Error(`policyId read failed for ${f.symbol}`);
    policies[f.symbol] = { seizeExempt: Number(BigInt(`0x${ex.data}`)), seizeReceiver: Number(BigInt(`0x${rc.data}`)) };
  });
  const ids = [...new Set(Object.values(policies).map((p) => p.seizeExempt))].filter((id) => id !== 0);
  const venueExempt: SeizeLive["venueExempt"] = {};
  if (ids.length > 0) {
    const second: Call[] = [];
    for (const id of ids) for (const v of SEIZE_VENUES) second.push({ target: MAINNET_STACK.policyRegistry, callData: `${IS_AUTHORIZED}${wordUint(id)}${wordAddress(v.address)}` as Hex });
    const r2 = decodeAggregate3(await rpc.call<Hex>("eth_call", [{ to: MULTICALL3, data: encodeAggregate3(second) }, tag]));
    let k = 0;
    for (const id of ids) {
      const row: Record<string, boolean> = {};
      for (const v of SEIZE_VENUES) {
        const res = r2[k++]!;
        if (!res.success) throw new Error(`isAuthorized(${id}, ${v.name}) failed`);
        row[v.address] = BigInt(`0x${res.data}`) !== 0n;
      }
      venueExempt[String(id)] = row;
    }
  }
  return { block, policies, venueExempt };
}

/** Per RPC client (the Worker keeps one per URL list for the isolate's life), so tests with their own fakes stay apart. */
const memos = new WeakMap<RawRpc, { at: number; live: SeizeLive }>();
/** Live reads memoised for this long per isolate (a page view should not cost two eth_calls each time). */
export const SEIZE_LIVE_TTL_SECONDS = 60;

export async function seizeWatch(store: Store, rpc: RawRpc | null, now: number) {
  const tokens = MAINNET_STACK.feeds.map((f) => f.token);
  const after = SEIZE_BASELINE.scannedTo;
  // three D1 round trips (each costs CPU on a Free-plan request): the stocks' governance events, the policy registry's,
  // and the cursors; roles and scopes are filtered here
  const [tokenRows, registryRows, cursors] = await Promise.all([
    store.queryEvents({ chainId: MAINNET, addresses: tokens, names: ["RoleGranted", "RoleRevoked", "PolicyUpdated", "Seized"], limit: 500 }),
    store.queryEvents({ chainId: MAINNET, address: MAINNET_STACK.policyRegistry, limit: 500 }),
    store.listCursors(),
  ]);
  const roleRows = tokenRows.filter((e) => (e.name === "RoleGranted" || e.name === "RoleRevoked") && args(e).role === SEIZE_ROLE);
  const policyRows = tokenRows.filter((e) => e.name === "PolicyUpdated");
  const seizedRows = tokenRows.filter((e) => e.name === "Seized");
  const cursorOf = (id: string) => cursors.find((c) => c.chainId === MAINNET && c.source === id) ?? null;
  const tokenCursor = cursorOf(SOURCE_IDS.mainnetB20Tokens);
  const registryCursor = cursorOf(SOURCE_IDS.mainnetPolicyRegistry);

  let live: SeizeLive | null = null;
  let liveError: string | null = null;
  const memo = rpc ? memos.get(rpc) : undefined;
  if (memo && now - memo.at >= 0 && now - memo.at < SEIZE_LIVE_TTL_SECONDS) live = memo.live;
  else if (rpc) {
    try {
      live = await readSeizeLive(rpc);
      memos.set(rpc, { at: now, live });
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }
  }

  // Indexed events after the baseline's end (the indexer's window overlaps the baseline from 52,198,000).
  const fresh = (e: EventRow) => e.blockNumber > after;
  const rows = MAINNET_STACK.feeds.map((f) => {
    const token = f.token.toLowerCase();
    const base = SEIZE_BASELINE.tokens.find((t) => t.token.toLowerCase() === token)!;
    const mine = (e: EventRow) => e.address === token && fresh(e);
    const roleEvents = roleRows.filter(mine).map((e) => ({ event: e.name, account: String(args(e).account ?? ""), block: e.blockNumber, time: e.blockTime, tx: e.txHash }));
    const holders = new Set<string>();
    for (const r of [...roleEvents].sort((a, b) => a.block - b.block)) {
      if (r.event === "RoleGranted") holders.add(r.account);
      else holders.delete(r.account);
    }
    const scopeOf = (e: EventRow) => String(args(e).policyScope ?? "");
    const policyUpdate = (e: EventRow) => ({ old: Number(args(e).oldPolicyId ?? 0), new: Number(args(e).newPolicyId ?? 0), block: e.blockNumber, time: e.blockTime, tx: e.txHash });
    const exemptUpdates = [...base.seizeExemptUpdates, ...policyRows.filter((e) => mine(e) && scopeOf(e) === SEIZE_EXEMPT_POLICY).map(policyUpdate)];
    const receiverUpdates = [...base.seizeReceiverUpdates, ...policyRows.filter((e) => mine(e) && scopeOf(e) === SEIZE_RECEIVER_POLICY).map(policyUpdate)];
    const seized = base.seized + seizedRows.filter(mine).length;
    const policies = live?.policies[f.symbol] ?? null;
    const exemptId = policies?.seizeExempt ?? null;
    const venues =
      exemptId === null
        ? null
        : SEIZE_VENUES.map((v) => ({ name: v.name, address: v.address, exempt: exemptId === 0 ? true : (live?.venueExempt[String(exemptId)]?.[v.address] ?? null) }));
    const seizeRoleHolders = [...holders];
    return {
      symbol: f.symbol,
      token: f.token,
      createdAtBlock: base.createdAtBlock,
      seizeRole: { grantsAllTime: base.seizeRoleGrants + roleEvents.filter((r) => r.event === "RoleGranted").length, holders: seizeRoleHolders, events: roleEvents },
      seizeExemptPolicy: { live: exemptId, updates: exemptUpdates },
      seizeReceiverPolicy: { live: policies?.seizeReceiver ?? null, updates: receiverUpdates },
      seized,
      venues,
      verdict: seizeRoleHolders.length > 0 ? "SEIZE_ROLE_HELD" : seized > 0 ? "SEIZED_BEFORE" : base.seizeRoleGrants + roleEvents.length > 0 ? "SEIZE_ROLE_REVOKED" : "NO_SEIZE_ROLE",
    };
  });
  const policyChanges = [
    ...SEIZE_BASELINE.policy129Blocklist.map((b) => ({ policyId: 129, event: b.blocked ? "blocked" : "unblocked", accounts: [...b.accounts], block: b.block, time: b.time, tx: b.tx })),
    ...registryRows.filter(fresh).map((e) => {
      const a = args(e);
      const accounts = Array.isArray(a.accounts) ? (a.accounts as string[]) : [];
      const event = e.name === "BlocklistUpdated" ? (a.blocked ? "blocked" : "unblocked") : e.name === "AllowlistUpdated" ? (a.allowed ? "allowed" : "disallowed") : e.name;
      return { policyId: Number(a.policyId ?? 0), event, accounts, block: e.blockNumber, time: e.blockTime, tx: e.txHash };
    }),
  ];
  const venuesNotExempt = rows.flatMap((r) => (r.venues ?? []).filter((v) => v.exempt === false).map((v) => ({ symbol: r.symbol, venue: v.name, address: v.address })));
  const holdersTotal = rows.reduce((n, r) => n + r.seizeRole.holders.length, 0);
  return {
    chainId: MAINNET,
    asOf: now,
    live: live ? { block: live.block, error: null } : { block: null, error: liveError ?? "no RPC" },
    coverage: {
      baseline: { from: SEIZE_BASELINE.scannedFrom, to: SEIZE_BASELINE.scannedTo, toTime: SEIZE_BASELINE.scannedToTime, governanceLogs: SEIZE_BASELINE.governanceLogs, method: "full-history eth_getLogs scan, 8 Oct 2026 (apps/indexer/scripts/seize-history.py)" },
      tokenEvents: tokenCursor ? { to: tokenCursor.lastBlock, toTime: tokenCursor.lastBlockTime } : null,
      policyRegistryEvents: registryCursor ? { to: registryCursor.lastBlock, toTime: registryCursor.lastBlockTime } : null,
    },
    roles: { SEIZE_ROLE, SEIZE_EXEMPT_POLICY, SEIZE_RECEIVER_POLICY },
    summary: {
      seizeRoleHolders: holdersTotal,
      seizeRoleGrantsAllTime: rows.reduce((n, r) => n + r.seizeRole.grantsAllTime, 0),
      seizedAllTime: rows.reduce((n, r) => n + r.seized, 0),
      exemptionPolicies: [...new Set(rows.map((r) => r.seizeExemptPolicy.live).filter((x): x is number => x !== null))],
      venuesNotExempt,
      statement:
        holdersTotal === 0
          ? `No account holds SEIZE_ROLE on any of the ten stocks, so no seizure is possible today. Since 5 Oct 2026 every stock binds SEIZE_EXEMPT_POLICY to a policy the issuer administers (accounts it blocklists become seizable once a SEIZE_ROLE exists); ${venuesNotExempt.length === 0 ? "every venue pool is exempt under it." : `${venuesNotExempt.length} venue pool(s) are NOT exempt under it.`}`
          : `${holdersTotal} account(s) hold SEIZE_ROLE: seizure is possible from any account the exemption policy does not authorise.`,
    },
    policyChanges,
    tokens: rows,
  };
}
