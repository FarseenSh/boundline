// Aave V4 MAG7 spoke: reserve configuration for reserves 0..7. The borrower scan (Borrow events,
// getUserAccountData per borrower) is the indexer's job (plan M5) and is stubbed here.
import { AAVE_MAG7_RESERVES, MAINNET, aaveSpokeAbi, createBaseClient } from "@boundline/chain";

export interface AaveReserveRow {
  reserveId: number;
  symbol: string;
  underlying: string;
  decimals: number;
  collateralRisk: number;
  paused: boolean;
  frozen: boolean;
  borrowable: boolean;
  totalDebt: string;
  suppliedAssets: string;
}

const SYMBOL_BY_ID = Object.fromEntries(Object.entries(AAVE_MAG7_RESERVES).map(([s, id]) => [id, s])) as Record<number, string>;

export async function readAaveReserves(rpcUrl: string): Promise<AaveReserveRow[]> {
  const client = createBaseClient({ chainId: 8453, rpcUrl });
  const ids = Object.values(AAVE_MAG7_RESERVES);
  const results = await client.multicall({
    allowFailure: true,
    contracts: ids.flatMap((id) => [
      { address: MAINNET.aaveMag7Spoke, abi: aaveSpokeAbi, functionName: "getReserve", args: [BigInt(id)] } as const,
      { address: MAINNET.aaveMag7Spoke, abi: aaveSpokeAbi, functionName: "getReserveConfig", args: [BigInt(id)] } as const,
      { address: MAINNET.aaveMag7Spoke, abi: aaveSpokeAbi, functionName: "getReserveTotalDebt", args: [BigInt(id)] } as const,
      { address: MAINNET.aaveMag7Spoke, abi: aaveSpokeAbi, functionName: "getReserveSuppliedAssets", args: [BigInt(id)] } as const,
    ]),
  });
  return ids.map((id, i) => {
    const r = results[i * 4];
    const c = results[i * 4 + 1];
    const d = results[i * 4 + 2];
    const s = results[i * 4 + 3];
    const reserve = r?.status === "success" ? (r.result as { underlying: string; decimals: number; collateralRisk: number }) : null;
    const config = c?.status === "success" ? (c.result as { collateralRisk: number; paused: boolean; frozen: boolean; borrowable: boolean }) : null;
    return {
      reserveId: id,
      symbol: SYMBOL_BY_ID[id] ?? `reserve-${id}`,
      underlying: reserve?.underlying ?? "0x",
      decimals: reserve?.decimals ?? 0,
      collateralRisk: config?.collateralRisk ?? reserve?.collateralRisk ?? 0,
      paused: config?.paused ?? false,
      frozen: config?.frozen ?? false,
      borrowable: config?.borrowable ?? false,
      totalDebt: d?.status === "success" ? String(d.result) : "0",
      suppliedAssets: s?.status === "success" ? String(s.result) : "0",
    };
  });
}
