// Every read the SDK makes, against the desk, the gate, Morpho and the tokens, decoded into named
// fields and words. One viem PublicClient; every call is an eth_call the tests fake by selector.
import type { Address, Hex, PublicClient } from "viem";
import { creditDeskAbi } from "./abi/creditDesk.js";
import { erc20MinimalAbi, morphoMinimalAbi } from "./abi/minimal.js";
import { sessionGateAbi } from "./abi/sessionGate.js";
import type { BoundlineChainConfig } from "./config.js";
import {
  GATE_STATES,
  LINE_STATUSES,
  OBLIGATION_STATUSES,
  REASONS,
  SESSIONS,
  enumName,
  type GateStateName,
  type LineStatusName,
  type ObligationStatusName,
  type ReasonName,
  type SessionName,
} from "./names.js";

export interface Line {
  lineId: bigint;
  partnerId: Hex;
  user: Address;
  marketId: Hex;
  collateral: Address;
  policyVersion: number;
  status: LineStatusName;
  statusCode: number;
  holdReason: Hex;
  openedAt: number;
  drawnPrincipal: bigint;
}

export interface Quote {
  reason: ReasonName;
  reasonCode: number;
  session: SessionName;
  sessionCode: number;
  /** 8-decimal USD price of one share; 0 when the gate refuses. */
  price8: bigint;
  collateralRaw: bigint;
  /** USDC base units after any corporate-action haircut. */
  collateralValue: bigint;
  debt: bigint;
  maxDebt: bigint;
  available: bigint;
  effectiveMaxLtvWad: bigint;
  corporateActionHaircut: boolean;
}

export interface MarketInfo {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltvWad: bigint;
  collateralDecimals: number;
  loanDecimals: number;
  enabled: boolean;
}

export interface TickerPolicy {
  allowed: boolean;
  maxLtvWad: bigint;
  minDraw: bigint;
  maxDraw: bigint;
  exposureCap: bigint;
  exposure: bigint;
}

export interface Verdict {
  state: GateStateName;
  stateCode: number;
  session: SessionName;
  answer: bigint;
  updatedAt: number;
  multiplier: bigint;
  registryPaused: boolean;
  transferPaused: boolean;
}

export interface MorphoPosition {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

export interface MorphoMarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

export interface BoundlineReader {
  readonly desk: Address;
  getLine(lineId: bigint): Promise<Line>;
  lineOf(user: Address, marketId: Hex, partnerId?: Hex): Promise<bigint>;
  quote(lineId: bigint, amount: bigint): Promise<Quote>;
  capacity(lineId: bigint): Promise<Quote>;
  obligationStatus(lineId: bigint): Promise<ObligationStatusName>;
  market(marketId: Hex): Promise<MarketInfo>;
  tickerPolicy(collateral: Address, partnerId?: Hex): Promise<TickerPolicy>;
  nonces(user: Address): Promise<bigint>;
  gateCheck(token: Address): Promise<Verdict>;
  isAuthorized(user: Address, target?: Address): Promise<boolean>;
  morphoPosition(marketId: Hex, user: Address): Promise<MorphoPosition>;
  morphoMarket(marketId: Hex): Promise<MorphoMarketState>;
  allowance(token: Address, owner: Address, spender?: Address): Promise<bigint>;
  balanceOf(token: Address, owner: Address): Promise<bigint>;
}

export function createReader(client: PublicClient, cfg: BoundlineChainConfig): BoundlineReader {
  if (!cfg.desk) throw new Error(`no CreditDesk on ${cfg.name}`);
  const desk = cfg.desk;
  const gate = cfg.gate;
  const read = client.readContract.bind(client);
  return {
    desk,
    async getLine(lineId) {
      const l = await read({ address: desk, abi: creditDeskAbi, functionName: "line", args: [lineId] });
      return {
        lineId,
        partnerId: l.partnerId,
        user: l.user,
        marketId: l.marketId,
        collateral: l.collateral,
        policyVersion: Number(l.policyVersion),
        status: enumName(LINE_STATUSES, l.status),
        statusCode: Number(l.status),
        holdReason: l.holdReason,
        openedAt: Number(l.openedAt),
        drawnPrincipal: l.drawnPrincipal,
      };
    },
    lineOf: (user, marketId, partnerId = cfg.partnerId) => read({ address: desk, abi: creditDeskAbi, functionName: "lineOf", args: [partnerId, user, marketId] }),
    async quote(lineId, amount) {
      return shapeQuote(await read({ address: desk, abi: creditDeskAbi, functionName: "quote", args: [lineId, amount] }));
    },
    async capacity(lineId) {
      return shapeQuote(await read({ address: desk, abi: creditDeskAbi, functionName: "capacity", args: [lineId] }));
    },
    async obligationStatus(lineId) {
      return enumName(OBLIGATION_STATUSES, await read({ address: desk, abi: creditDeskAbi, functionName: "obligationStatus", args: [lineId] }));
    },
    async market(marketId) {
      const m = await read({ address: desk, abi: creditDeskAbi, functionName: "market", args: [marketId] });
      return {
        loanToken: m.params.loanToken,
        collateralToken: m.params.collateralToken,
        oracle: m.params.oracle,
        irm: m.params.irm,
        lltvWad: m.params.lltv,
        collateralDecimals: Number(m.collateralDecimals),
        loanDecimals: Number(m.loanDecimals),
        enabled: m.enabled,
      };
    },
    async tickerPolicy(collateral, partnerId = cfg.partnerId) {
      const t = await read({ address: desk, abi: creditDeskAbi, functionName: "tickerPolicy", args: [partnerId, collateral] });
      return { allowed: t.allowed, maxLtvWad: BigInt(t.maxLtvWad), minDraw: t.minDraw, maxDraw: t.maxDraw, exposureCap: t.exposureCap, exposure: t.exposure };
    },
    nonces: (user) => read({ address: desk, abi: creditDeskAbi, functionName: "nonces", args: [user] }),
    async gateCheck(token) {
      if (!gate) throw new Error(`no SessionGate on ${cfg.name}`);
      const v = await read({ address: gate, abi: sessionGateAbi, functionName: "check", args: [token] });
      return {
        state: enumName(GATE_STATES, v.state),
        stateCode: Number(v.state),
        session: enumName(SESSIONS, v.session),
        answer: v.answer,
        updatedAt: Number(v.updatedAt),
        multiplier: v.multiplier,
        registryPaused: v.registryPaused,
        transferPaused: v.transferPaused,
      };
    },
    isAuthorized: (user, target = desk) => read({ address: cfg.morpho, abi: morphoMinimalAbi, functionName: "isAuthorized", args: [user, target] }),
    async morphoPosition(marketId, user) {
      const [supplyShares, borrowShares, collateral] = await read({ address: cfg.morpho, abi: morphoMinimalAbi, functionName: "position", args: [marketId, user] });
      return { supplyShares, borrowShares, collateral };
    },
    async morphoMarket(marketId) {
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = await read({ address: cfg.morpho, abi: morphoMinimalAbi, functionName: "market", args: [marketId] });
      return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
    },
    allowance: (token, owner, spender = desk) => read({ address: token, abi: erc20MinimalAbi, functionName: "allowance", args: [owner, spender] }),
    balanceOf: (token, owner) => read({ address: token, abi: erc20MinimalAbi, functionName: "balanceOf", args: [owner] }),
  };
}

type RawQuote = {
  reason: number;
  session: number;
  price8: bigint;
  collateralRaw: bigint;
  collateralValue: bigint;
  debt: bigint;
  maxDebt: bigint;
  available: bigint;
  effectiveMaxLtvWad: bigint;
  corporateActionHaircut: boolean;
};

export function shapeQuote(q: RawQuote): Quote {
  return {
    reason: enumName(REASONS, q.reason),
    reasonCode: Number(q.reason),
    session: enumName(SESSIONS, q.session),
    sessionCode: Number(q.session),
    price8: q.price8,
    collateralRaw: q.collateralRaw,
    collateralValue: q.collateralValue,
    debt: q.debt,
    maxDebt: q.maxDebt,
    available: q.available,
    effectiveMaxLtvWad: q.effectiveMaxLtvWad,
    corporateActionHaircut: q.corporateActionHaircut,
  };
}
