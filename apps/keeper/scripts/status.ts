// Keyless live status from a laptop: `pnpm --filter @boundline/keeper exec tsx scripts/status.ts`.
// Reads both chains through the same code path as the Worker's `/v1/status`; never sends.
import { createViemMirrorChain } from "../src/chain.js";
import { PAIRS } from "../src/config.js";
import { collectStatus } from "../src/status.js";

const chain = createViemMirrorChain({
  mainnetRpc: process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org",
  sepoliaRpc: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org,https://base-sepolia-rpc.publicnode.com",
  keeperKey: null,
});
const status = await collectStatus(chain, PAIRS, Math.floor(Date.now() / 1000));
console.log(JSON.stringify(status, null, 2));
