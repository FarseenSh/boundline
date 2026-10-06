// Batching for EIP-5792 wallet_sendCalls: the one-tap borrow with a sponsoring paymaster and an
// ERC-8021 Builder Code suffix. Framework-free; wagmi's useSendCalls takes `buildSendCalls`' result
// as is, and `walletSendCallsParams` is the raw provider request.
import { concatHex, isHex, numberToHex, stringToHex, toHex, type Address, type Hex } from "viem";
import type { Call } from "./calls.js";

/**
 * ERC-8021 data suffix, schema 0 (canonical registry). Layout, read from the end of calldata backwards:
 *   codes ∥ codesLength (1 byte) ∥ schemaId 0x00 (1 byte) ∥ ercMarker (16 bytes 0x8021…8021)
 * where `codes` is the UTF-8 of the attribution codes joined by ",". Source: Base, "Builder Codes & ERC-8021"
 * (blog.base.dev, worked example "baseapp" → 0x62617365617070 07 00 80218021802180218021802180218021) and the
 * reference encoder in wevm/ox `src/erc8021/Attribution.ts` (`toDataSuffix`, schema 0 branch).
 */
export const ERC8021_MARKER: Hex = "0x80218021802180218021802180218021";

export function builderCodeSuffix(codes: string | readonly string[]): Hex {
  const list = typeof codes === "string" ? [codes] : [...codes];
  if (list.length === 0) throw new Error("at least one builder code is required");
  for (const c of list) {
    if (!/^[\x21-\x7e]+$/.test(c) || c.includes(",")) throw new Error(`builder code "${c}" must be printable ASCII without commas`);
  }
  const joined = list.join(",");
  const bytes = new TextEncoder().encode(joined).length;
  if (bytes > 255) throw new Error("builder codes exceed 255 bytes");
  return concatHex([stringToHex(joined), toHex(bytes, { size: 1 }), "0x00", ERC8021_MARKER]);
}

/** Appends a data suffix to one call's calldata, for wallets without wallet_sendCalls (the sequential fallback). */
export function appendDataSuffix(data: Hex, suffix: Hex): Hex {
  if (!isHex(data) || !isHex(suffix)) throw new Error("data and suffix must be hex");
  return concatHex([data, suffix]);
}

export interface SendCallsOptions {
  chainId: number;
  /** ERC-7677 paymaster service URL (the CDP paymaster behind a server proxy); omitted → the user pays gas. */
  paymasterUrl?: string;
  /** Builder Code(s) registered at dashboard.base.org; omitted → no attribution suffix. */
  builderCode?: string | readonly string[];
  /** Require the wallet to execute the batch atomically (default true: a half-done borrow is worse than none). */
  atomicRequired?: boolean;
}

export interface SendCallsCapabilities {
  paymasterService?: { url: string };
  dataSuffix?: Hex;
}

/** What wagmi's `useSendCalls().mutate` / viem's `sendCalls` take. */
export interface PreparedSendCalls {
  chainId: number;
  calls: { to: Address; data: Hex; value: bigint }[];
  capabilities?: SendCallsCapabilities;
  forceAtomic: boolean;
}

export function buildSendCalls(calls: readonly Call[], opts: SendCallsOptions): PreparedSendCalls {
  if (calls.length === 0) throw new Error("no calls to send");
  const capabilities: SendCallsCapabilities = {};
  if (opts.paymasterUrl) capabilities.paymasterService = { url: opts.paymasterUrl };
  if (opts.builderCode) capabilities.dataSuffix = builderCodeSuffix(opts.builderCode);
  const out: PreparedSendCalls = {
    chainId: opts.chainId,
    calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value })),
    forceAtomic: opts.atomicRequired ?? true,
  };
  if (Object.keys(capabilities).length > 0) out.capabilities = capabilities;
  return out;
}

export interface WalletSendCallsParams {
  version: "2.0.0";
  id?: Hex;
  chainId: Hex;
  from: Address;
  atomicRequired: boolean;
  calls: { to: Address; data: Hex; value: Hex }[];
  capabilities?: SendCallsCapabilities;
}

/** The raw EIP-5792 request body, for `provider.request({ method: "wallet_sendCalls", params: [body] })`. */
export function walletSendCallsParams(prepared: PreparedSendCalls, from: Address): WalletSendCallsParams {
  const body: WalletSendCallsParams = {
    version: "2.0.0",
    chainId: numberToHex(prepared.chainId),
    from,
    atomicRequired: prepared.forceAtomic,
    calls: prepared.calls.map((c) => ({ to: c.to, data: c.data, value: numberToHex(c.value) })),
  };
  if (prepared.capabilities) body.capabilities = prepared.capabilities;
  return body;
}
