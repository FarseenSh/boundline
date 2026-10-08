// The route-plan signer: signs the EIP-712 "Boundline Router" v1 typed data of a plan the API stores, so a partner can
// prove later which plan Boundline produced. Typed data only: this key never signs a transaction and holds no funds.
// It exists only when the secret ROUTE_SIGNER_KEY is set (pending the human's approval on 8 Oct 2026); without it the
// API answers `signature: null` and says so.
//
// CPU: deriving an account builds noble-curves' base-point tables, about 18 ms the first time in an isolate. The keeper
// pays that at module evaluation because it signs inside a cron tick (strictly capped at 10 ms on the Free plan). The
// API signs only inside `POST /v1/route`, a fetch invocation, and fetches over 10 ms ended `ok` on this account (16 and
// 19 ms seen on 8 Oct 2026) while a module-scope warm-up would be paid by every isolate, cron ticks included. So the
// account is derived on first use and memoised per isolate.
import type { Address, Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { RoutePlanTypedData } from "@boundline/router";

export interface RouteSigner {
  /** Signs the plan's typed data; the account is derived on the first call (see above). */
  sign(td: RoutePlanTypedData): Promise<{ signature: Hex; signer: Address }>;
}

let cached: { key: string; account: PrivateKeyAccount } | null = null;

function accountFor(key: Hex): PrivateKeyAccount {
  if (cached && cached.key === key) return cached.account;
  const account = privateKeyToAccount(key);
  cached = { key, account };
  return account;
}

/** A signer for the configured key, or null when the secret is absent or malformed. Nothing is derived until it signs. */
export function routeSignerFrom(key: string | undefined): RouteSigner | null {
  const k = key?.trim();
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) return null;
  return {
    async sign(td) {
      const account = accountFor(k as Hex);
      const signature = await account.signTypedData({
        domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as Address },
        types: td.types,
        primaryType: td.primaryType,
        message: { ...td.message, user: td.message.user as Address },
      });
      return { signature, signer: account.address };
    },
  };
}
