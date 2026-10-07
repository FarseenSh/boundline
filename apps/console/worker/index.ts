// The console Worker: static assets for the SPA plus the thin /api proxy in route.ts. Nothing else runs here.
import { routeApi } from "./route.js";

export interface Env {
  ASSETS: Fetcher;
  API: Fetcher;
  INDEXER: Fetcher;
  OBSERVATORY?: Fetcher;
  PARTNER_API_KEY?: string;
  PARTNER_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handled = await routeApi(request, env);
    return handled ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
