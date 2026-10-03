// Mints a partner key (shown once) and prints the D1 insert for its hash.
//   pnpm --filter @boundline/api exec tsx scripts/new-partner-key.ts <partnerId or short name> [display name...]
// The partner id must match the one used on the CreditDesk (bytes32 hex, or the same short string the deploy
// script left-aligned into bytes32).
import { isHex, stringToHex } from "viem";
import { newPartnerKey, sha256Hex } from "../src/auth.js";

const [, , idArg, ...nameParts] = process.argv;
if (!idArg) {
  console.error("usage: tsx scripts/new-partner-key.ts <partnerId or short name> [display name...]");
  process.exit(1);
}
const partnerId = isHex(idArg) && idArg.length === 66 ? idArg.toLowerCase() : stringToHex(idArg, { size: 32 }).toLowerCase();
const name = (nameParts.join(" ") || idArg).replace(/'/g, "''");
const key = newPartnerKey();
const hash = await sha256Hex(key);
const now = Math.floor(Date.now() / 1000);
const sql = `INSERT INTO partners (partner_id, name, api_key_hash, policy_version, created_at) VALUES ('${partnerId}', '${name}', '${hash}', 1, ${now});`;

console.log(`partner id : ${partnerId}`);
console.log(`api key    : ${key}   (shown once; give it to the partner, never store it)`);
console.log(`key hash   : ${hash}`);
console.log("");
console.log("register it (from apps/api):");
console.log(`  pnpm exec wrangler d1 execute boundline-api --remote --command "${sql}"`);
console.log("locally:");
console.log(`  pnpm exec wrangler d1 execute boundline-api --local --command "${sql}"`);
