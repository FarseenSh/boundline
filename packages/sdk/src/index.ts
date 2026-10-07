// @boundline/sdk: everything a partner app needs to read a line, quote it, prepare the user's calls,
// batch them for one-tap sending, and watch the session clock. Framework-free; viem only.
import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { base, baseSepolia } from "viem/chains";
import { createApiClient, type ApiClient, type ApiClientOptions } from "./api.js";
import * as calls from "./calls.js";
import { configFor, marketById, type BoundlineChainConfig } from "./config.js";
import { computeHealth, type Health } from "./health.js";
import { preparePayout, quotePayout, readPayouts, type PayoutQuote, type PayoutRecord, type PayoutRequest } from "./payout.js";
import { waitForPreconfirmation, type PreconfOptions, type PreconfResult } from "./preconf.js";
import { createReader, type BoundlineReader, type Line, type Quote } from "./reads.js";
import { buildSendCalls, type PreparedSendCalls, type SendCallsOptions } from "./sendcalls.js";
import { sessionInfo, type SessionInfo } from "./session.js";

export * from "./abi/creditDesk.js";
export * from "./abi/sessionGate.js";
export * from "./abi/localPayoutRouter.js";
export * from "./abi/minimal.js";
export * from "./api.js";
export * from "./calls.js";
export * from "./config.js";
export * from "./decisions.js";
export * from "./format.js";
export * from "./health.js";
export * from "./names.js";
export * from "./payout.js";
export * from "./preconf.js";
export * from "./reads.js";
export * from "./sendcalls.js";
export * from "./session.js";

export interface BoundlineOptions {
  chainId: 84532 | 8453;
  /** Comma-separated or single RPC URL; defaults to the config's public list with fallback. */
  rpcUrl?: string;
  /** A viem transport instead of RPC URLs (tests pass `custom`). */
  transport?: Transport;
  /** Partner API access; omit to work purely onchain. */
  api?: ApiClientOptions;
}

export interface LineHealth {
  line: Line;
  quote: Quote;
  health: Health;
  lltvWad: bigint;
}

export interface Boundline {
  readonly config: BoundlineChainConfig;
  readonly client: PublicClient;
  readonly reader: BoundlineReader;
  readonly api: ApiClient | null;
  /** The exchange clock right now (pure, no RPC). */
  session(now?: number): SessionInfo;
  /** Line, capacity quote and the health bar's words in one call. */
  lineHealth(lineId: bigint, now?: number): Promise<LineHealth>;
  buildSendCalls(callList: readonly calls.Call[], opts?: Partial<SendCallsOptions>): PreparedSendCalls;
  waitForPreconfirmation(hash: `0x${string}`, opts?: PreconfOptions): Promise<PreconfResult>;
  /** What the local-money leg pays right now for `amountIn` USDC, from the pool's own state. */
  quotePayout(token: string | `0x${string}`, amountIn: bigint): Promise<PayoutQuote>;
  /** The router's record of a sender's payouts, oldest first. */
  payouts(sender: `0x${string}`, offset?: bigint, limit?: bigint): Promise<PayoutRecord[]>;
  /** The prepared-call builders bound to this chain's config. */
  readonly prepare: {
    authorizeDesk(authorized?: boolean): calls.Call;
    authorize(target: `0x${string}`, authorized: boolean): calls.Call;
    approve(token: `0x${string}`, spender: `0x${string}`, amount: bigint): calls.Call;
    openLine(args: Parameters<typeof calls.prepareOpenLine>[1]): calls.Call;
    addCollateral(lineId: bigint, amount: bigint): calls.Call;
    draw(lineId: bigint, amount: bigint): calls.Call;
    repay(lineId: bigint, amount?: bigint): calls.Call;
    withdrawCollateral(lineId: bigint, amount: bigint): calls.Call;
    closeLine(lineId: bigint): calls.Call;
    borrowBatch(input: calls.BorrowBatchInput): calls.Call[];
    repayBatch(input: calls.RepayBatchInput): calls.Call[];
    payout(req: PayoutRequest): calls.Call;
  };
}

export function createBoundline(opts: BoundlineOptions): Boundline {
  const config = configFor(opts.chainId);
  const chain = opts.chainId === 84532 ? baseSepolia : base;
  const urls = (opts.rpcUrl ? opts.rpcUrl.split(",") : [...config.rpcUrls]).map((u) => u.trim()).filter(Boolean);
  const transport = opts.transport ?? (urls.length === 1 ? http(urls[0]!) : fallback(urls.map((u) => http(u, { retryCount: 1 })), { rank: false }));
  const client = createPublicClient({ chain, transport }) as PublicClient;
  const reader = createReader(client, config);
  const api = opts.api ? createApiClient(opts.api) : null;
  const lltvOf = async (marketId: `0x${string}`): Promise<bigint> => marketById(config, marketId)?.lltvWad ?? (await reader.market(marketId)).lltvWad;

  return {
    config,
    client,
    reader,
    api,
    session: (now) => sessionInfo(now),
    async lineHealth(lineId, now) {
      const [line, quote] = await Promise.all([reader.getLine(lineId), reader.capacity(lineId)]);
      const lltvWad = await lltvOf(line.marketId);
      const health = computeHealth(now === undefined ? { quote, lltvWad } : { quote, lltvWad, now });
      return { line, quote, health, lltvWad };
    },
    buildSendCalls: (callList, o = {}) => buildSendCalls(callList, { chainId: config.chainId, ...o }),
    waitForPreconfirmation: (hash, o) => waitForPreconfirmation(client, hash, o),
    quotePayout: (token, amountIn) => quotePayout(client, config, token, amountIn),
    payouts: (sender, offset, limit) => readPayouts(client, config, sender, offset, limit),
    prepare: {
      authorizeDesk: (authorized) => calls.prepareAuthorizeDesk(config, authorized),
      authorize: (target, authorized) => calls.prepareAuthorize(config, target, authorized),
      approve: calls.prepareApprove,
      openLine: (args) => calls.prepareOpenLine(config, args),
      addCollateral: (lineId, amount) => calls.prepareAddCollateral(config, lineId, amount),
      draw: (lineId, amount) => calls.prepareDraw(config, lineId, amount),
      repay: (lineId, amount) => calls.prepareRepay(config, lineId, amount),
      withdrawCollateral: (lineId, amount) => calls.prepareWithdrawCollateral(config, lineId, amount),
      closeLine: (lineId) => calls.prepareCloseLine(config, lineId),
      borrowBatch: (input) => calls.borrowBatch(config, input),
      repayBatch: (input) => calls.repayBatch(config, input),
      payout: (req) => preparePayout(config, req),
    },
  };
}
