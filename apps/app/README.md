# Boundline app

Boundline's own partner #1 and the reference implementation of `@boundline/sdk`: borrow USDC against your
tokenized stocks on Base, protected while Wall Street is closed. Vite + React 19 + wagmi v3 + viem, served
by a Cloudflare Worker that also proxies the partner API.

Live: https://boundline-app.papermind-ai.workers.dev (Base Sepolia).

## Pages

- `/` portfolio: holdings, the line, the health bar, the next reopen.
- `/borrow` the widget: "Borrow up to $X", a partner quote with its quote hash, one `wallet_sendCalls` batch
  (authorise the desk once → approve → add collateral → draw), Flashblocks preconfirmation, decision hashes.
- `/protect` protected mode: Morpho authorisations for the desk and the pre-liquidation contract, opt-in.
- `/statements` the decision timeline from the indexer and the hash-chained daily roots.

The session ribbon on every page is the exchange clock in ET; the feeds publish Sunday 20:00 to Friday 20:00 ET.

## How the proxy works

The browser never holds the partner key. The Worker (`worker/index.ts`) serves the built app as static assets
and runs first for `/api/*`:

| Browser path | Upstream (service binding) | Added |
| --- | --- | --- |
| `/api/health`, `/api/v1/*` | `boundline-api` | `Authorization: Bearer <PARTNER_API_KEY>` |
| `/api/indexer/v1/*` | `boundline-indexer` | nothing |
| `/api/config` | the Worker itself | partner id, whether a key is configured |

`PARTNER_API_KEY` is a Worker secret (`pnpm --filter @boundline/app exec wrangler secret put PARTNER_API_KEY`).
Request headers forwarded: `content-type`, `accept`, `idempotency-key`, `x-correlation-id`; response headers
forwarded: `x-correlation-id`, `x-policy-version`, `x-quote-hash`, `x-idempotent-replay`.

## Environment (`VITE_*`, read at build time)

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_CHAIN_ID` | `84532` | `84532` Base Sepolia (live desk) or `8453` Base (no desk yet; the SDK's config carries both). |
| `VITE_PAYMASTER_URL` | unset | ERC-7677 paymaster URL (a server-side proxy to the CDP paymaster). Set → `capabilities.paymasterService` on the batch, gas sponsored. Unset → the user pays gas. |
| `VITE_BUILDER_CODE` | unset | Builder Code from dashboard.base.org. Set → ERC-8021 `capabilities.dataSuffix` on the batch (and appended to each call in the sequential fallback). |
| `VITE_PRELIQUIDATION` | unset | Morpho pre-liquidation contract for protected mode; enables the opt-in button on `/protect`. |
| `VITE_RPC_URL` | the SDK's public list | Comma-separated RPC URLs for reads. |
| `VITE_OBSERVATORY_URL` | the live Observatory | Footer link. |

## Wallets

Base Account (`baseAccount` connector, passkey sign-in, `wallet_sendCalls`) first, any injected wallet second.
When a wallet lacks EIP-5792 the same calls go out one transaction at a time, each waited to its block before
the next; both paths poll `eth_getTransactionReceipt` every 200 ms and show the Flashblocks preconfirmation
(all-zero block hash) before the block.

## Develop, build, deploy

```sh
pnpm --filter @boundline/sdk build            # the app consumes the SDK's dist
pnpm --filter @boundline/app dev              # http://localhost:5173 (proxy /api to a local wrangler dev of this Worker)
pnpm --filter @boundline/app typecheck
pnpm --filter @boundline/app build            # dist/
pnpm --filter @boundline/app exec wrangler deploy
```
