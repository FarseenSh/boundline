// Morpho Blue B20 markets on Base: discovered from Morpho's public GraphQL API, then read onchain.
import { B20_BY_ADDRESS, MAINNET, createBaseClient, morphoAbi, morphoOracleAbi } from "@boundline/chain";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const MORPHO_GRAPHQL = "https://blue-api.morpho.org/graphql";

export interface DiscoveredMarket {
  id: Hex;
  collateral: { address: Address; symbol: string };
  loan: { address: Address; symbol: string };
  lltv: bigint;
  oracle: Address;
  irm: Address;
  listed: boolean;
}

export interface MarketRow extends Omit<DiscoveredMarket, "lltv"> {
  lltv: number;
  totalSupplyAssets: string;
  totalBorrowAssets: string;
  utilization: number;
  /** IOracle.price() as the market sees it (1e36 scale), as a string; null if the call failed. */
  oraclePrice36: string | null;
  /** The oracle price as USD per share, assuming 8-dec collateral vs 6-dec USDC. */
  oraclePriceUsd: number | null;
  idMatchesParams: boolean;
}

/** keccak256(abi.encode(MarketParams)): recomputed locally so the API can never hand us a wrong id. */
export function marketIdFromParams(p: { loan: Address; collateral: Address; oracle: Address; irm: Address; lltv: bigint }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [p.loan, p.collateral, p.oracle, p.irm, p.lltv],
    ),
  );
}

const QUERY = `query B20Markets($collateral: [String!]) {
  markets(first: 100, where: { chainId_in: [8453], collateralAssetAddress_in: $collateral }) {
    items { marketId lltv irmAddress listed oracle { address }
      collateralAsset { address symbol } loanAsset { address symbol } }
  }
}`;

interface ApiMarket {
  marketId: string;
  lltv: string;
  irmAddress: string;
  listed: boolean;
  oracle: { address: string } | null;
  collateralAsset: { address: string; symbol: string };
  loanAsset: { address: string; symbol: string };
}

export function parseDiscovery(body: { data?: { markets?: { items?: ApiMarket[] } } }): DiscoveredMarket[] {
  const items = body.data?.markets?.items ?? [];
  return items
    .filter((m) => m.oracle !== null && B20_BY_ADDRESS[m.collateralAsset.address.toLowerCase()] !== undefined)
    .map((m) => ({
      id: m.marketId as Hex,
      collateral: { address: m.collateralAsset.address as Address, symbol: m.collateralAsset.symbol },
      loan: { address: m.loanAsset.address as Address, symbol: m.loanAsset.symbol },
      lltv: BigInt(m.lltv),
      oracle: (m.oracle as { address: string }).address as Address,
      irm: m.irmAddress as Address,
      listed: m.listed,
    }));
}

export async function discoverB20Markets(fetchImpl: typeof fetch = fetch): Promise<DiscoveredMarket[]> {
  const collateral = Object.values(B20_BY_ADDRESS).map((t) => t.address);
  const res = await fetchImpl(MORPHO_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { collateral } }),
  });
  if (!res.ok) throw new Error(`morpho api ${res.status}`);
  return parseDiscovery((await res.json()) as Parameters<typeof parseDiscovery>[0]);
}

export async function readMarkets(rpcUrl: string, markets: DiscoveredMarket[]): Promise<MarketRow[]> {
  const client = createBaseClient({ chainId: 8453, rpcUrl });
  const results = await client.multicall({
    allowFailure: true,
    contracts: markets.flatMap((m) => [
      { address: MAINNET.morpho, abi: morphoAbi, functionName: "market", args: [m.id] } as const,
      { address: m.oracle, abi: morphoOracleAbi, functionName: "price" } as const,
    ]),
  });
  return markets.map((m, i) => {
    const mk = results[i * 2];
    const px = results[i * 2 + 1];
    const market = mk?.status === "success" ? (mk.result as { totalSupplyAssets: bigint; totalBorrowAssets: bigint }) : null;
    const price = px?.status === "success" ? (px.result as bigint) : null;
    const supply = market?.totalSupplyAssets ?? 0n;
    const borrow = market?.totalBorrowAssets ?? 0n;
    return {
      ...m,
      lltv: Number(m.lltv) / 1e18,
      totalSupplyAssets: supply.toString(),
      totalBorrowAssets: borrow.toString(),
      utilization: supply > 0n ? Number((borrow * 10_000n) / supply) / 10_000 : 0,
      oraclePrice36: price?.toString() ?? null,
      oraclePriceUsd: price !== null ? Number(price) / 1e34 : null,
      idMatchesParams:
        marketIdFromParams({ loan: m.loan.address, collateral: m.collateral.address, oracle: m.oracle, irm: m.irm, lltv: m.lltv }).toLowerCase() ===
        m.id.toLowerCase(),
    };
  });
}
