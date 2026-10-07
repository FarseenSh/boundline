// One real x402 payment against a metered route of the deployed API: a hand-rolled v2 client (no wallet stack).
// Reads the 402's PAYMENT-REQUIRED header, signs the EIP-3009 TransferWithAuthorization for the requirement with the
// key in X402_PAYER_KEY (an EIP-712 signature only: no onchain nonce of the account is used; the facilitator broadcasts
// transferWithAuthorization and pays the gas), and retries the request with PAYMENT-SIGNATURE.
//   X402_PAYER_KEY=0x... pnpm --filter @boundline/api exec tsx scripts/x402-pay.ts <url> [method] [json body]
// The payer needs USDC on Base Sepolia (the Circle faucet) and nothing else. Never print the key.
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

const [, , url, method = "GET", bodyText] = process.argv;
if (!url) throw new Error("usage: x402-pay.ts <url> [method] [json body]");
const pk = process.env.X402_PAYER_KEY;
if (!pk) throw new Error("X402_PAYER_KEY is not set");
const account = privateKeyToAccount(pk as Hex);

const b64e = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const b64d = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as any;

const init = (extra: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { ...(bodyText ? { "content-type": "application/json" } : {}), ...extra },
  ...(bodyText ? { body: bodyText } : {}),
});

const first = await fetch(url, init());
console.log("first response:", first.status);
const requiredHeader = first.headers.get("payment-required");
if (first.status !== 402 || !requiredHeader) {
  console.log(await first.text());
  throw new Error("expected a 402 with PAYMENT-REQUIRED");
}
const required = b64d(requiredHeader);
const req = required.accepts[0];
console.log("requirement:", JSON.stringify(req));
if (req.network !== "eip155:84532" || req.scheme !== "exact") throw new Error("unexpected requirement");

const now = Math.floor(Date.now() / 1000);
const nonceBytes = new Uint8Array(32);
crypto.getRandomValues(nonceBytes);
const authorization = {
  from: account.address as Address,
  to: req.payTo as Address,
  value: BigInt(req.amount),
  validAfter: BigInt(now - 60),
  validBefore: BigInt(now + Number(req.maxTimeoutSeconds ?? 300)),
  nonce: (`0x${Buffer.from(nonceBytes).toString("hex")}`) as Hex,
};
const signature = await account.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: 84532, verifyingContract: req.asset as Address },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: authorization,
});
const payload = {
  x402Version: 2,
  resource: required.resource,
  accepted: req,
  payload: {
    signature,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  },
};
const paid = await fetch(url, init({ "payment-signature": b64e(payload) }));
console.log("paid response:", paid.status);
const settlement = paid.headers.get("payment-response");
console.log("PAYMENT-RESPONSE:", settlement ? JSON.stringify(b64d(settlement)) : "(none)");
const text = await paid.text();
console.log(text.slice(0, 1200));
