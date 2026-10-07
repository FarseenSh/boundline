# @boundline/site

The landing page at https://boundline-site.papermind-ai.workers.dev: a single static page (`public/index.html`,
`public/styles.css`, `public/site.js`) served as Cloudflare Workers assets, no build step, no Worker script.

Rules the page keeps: every number on it is either fetched live from the Observatory
(`/v1/sessions`, `/v1/tokens`) or a recorded transaction hash from `deployments/base-sepolia.json` and
`docs/evidence/`. No fictional brands, no invented traction.

Deploy: `pnpm --filter @boundline/site deploy` (or `pnpm exec wrangler deploy` here). The custom domain
boundline.xyz still serves the old site; pointing it here is a human decision (`routes` in `wrangler.jsonc`).
