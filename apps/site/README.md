# @boundline/site

The landing page at https://boundline-site.papermind-ai.workers.dev: one self-contained static page
(`public/index.html`, its CSS and JS inline) plus its icons and link-preview card (`favicon.ico`,
`apple-touch-icon.png`, `og.png`, all from `docs/brand/`), served as Cloudflare Workers assets with no build step.
The Worker in `worker/index.js` runs only for `/obs/*` and `/live/*`, the read-only bridges to the Observatory and the
partner API's drills.

The page: a live week dial (the NYSE calendar computed in the browser with the same rules as the onchain
`MarketCalendar`), "Drag through a weekend" (the 7 Oct replay's staged Morpho position through a -15% gap, raw venue
against Boundline; the path between Friday and the reopen is labelled illustrative), what Boundline does, the partner
surface, and what is live on Base mainnet and Base Sepolia with transaction links. `drafts/` holds the two alternative
designs (`session.html`, `observatory.html`) and the Weekend draft this page was made from.

Rules the page keeps: every number on it is either fetched live from the Observatory (`/v1/sessions`, `/v1/tokens`) or
copied from `deployments/`, `docs/evidence/` and `docs/submission/SUBMISSION.md`, with its source. No fictional brands,
no invented traction. Opened as a local file it shows a labelled snapshot instead of live numbers.

Deploy: `pnpm --filter @boundline/site deploy` (or `pnpm exec wrangler deploy` here). The custom domain
boundline.xyz still serves the old site; pointing it here is a human decision (`routes` in `wrangler.jsonc`).
