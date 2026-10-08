// Generates src/topics.ts: keccak256 of every event signature the indexer decodes, so neither the Worker's startup nor
// a tick hashes signatures (on a cold isolate ~100 interpreted keccaks cost ~23 ms of CPU, measured 8 Oct 2026 with
// node --jitless). test/topics.test.ts holds the table to viem.   pnpm --filter @boundline/indexer exec tsx scripts/gen-topics.ts
import { writeFileSync } from "node:fs";
import { toEventSelector, type Abi, type AbiEvent } from "viem";
import { answerUpdatedAbi, boundlineStackAbi, creditDeskAbi, mainnetOracleRegistryEventsAbi, morphoEventsAbi, policyRegistryEventsAbi, sepoliaProtectionAbi } from "../src/abis.js";
import { eventSignature } from "../src/topics.js";
import { aaveSpokeAbi, b20AssetAbi } from "@boundline/chain";

const abis: Abi[] = [morphoEventsAbi, boundlineStackAbi, creditDeskAbi, sepoliaProtectionAbi, answerUpdatedAbi, mainnetOracleRegistryEventsAbi, policyRegistryEventsAbi, b20AssetAbi as Abi, aaveSpokeAbi as Abi] as Abi[];
const table = new Map<string, string>();
for (const abi of abis) for (const item of abi) if (item.type === "event" && !item.anonymous) table.set(eventSignature(item as AbiEvent), toEventSelector(item as AbiEvent));
const rows = [...table.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sig, t]) => `  ${JSON.stringify(sig)}: "${t}",`);
const path = new URL("../src/topics.ts", import.meta.url);
const src = (await import("node:fs")).readFileSync(path, "utf8");
const start = src.indexOf("export const TOPIC0");
const out = `${src.slice(0, start)}export const TOPIC0: Readonly<Record<string, Hex>> = {\n${rows.join("\n")}\n};\n`;
writeFileSync(path, out);
console.log(`${table.size} signatures`);
