// The landing page's only script: two read-only bridges for its live numbers. A browser cannot read the Observatory
// from this origin (its workers.dev answers carry no CORS headers) nor the partner API without a key, so this Worker
// reaches the Observatory and the app Worker's keyed proxy through service bindings (a Worker fetching another
// Worker's workers.dev URL is refused with error 1042). It runs only for /obs/* and /live/*; every other path is a
// static asset served without it. Plain JS, no dependencies, well under a millisecond of CPU per request.

/** The Observatory routes the page reads; nothing else is bridged. */
const OBSERVATORY_PATHS = new Set(["/v1/sessions", "/v1/tokens", "/v1/captures", "/v1/assurance", "/v1/gaps"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The upstream body and status with a short public cache, so a busy page does not multiply upstream reads. The body is
 *  buffered (a few kilobytes of JSON): passing the stream through two Workers ended some invocations as "canceled". */
async function pass(res, maxAge) {
  const headers = new Headers({ "content-type": res.headers.get("content-type") || "application/json", "cache-control": `public, max-age=${maxAge}` });
  return new Response(await res.arrayBuffer(), { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/obs/") && !path.startsWith("/live/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
    try {
      if (path.startsWith("/obs/")) {
        const rest = path.slice("/obs".length);
        if (!OBSERVATORY_PATHS.has(rest)) return json({ error: "not found" }, 404);
        return await pass(await env.OBSERVATORY.fetch(`https://observatory${rest}`), 30);
      }
      if (path === "/live/drills") return await pass(await env.APP.fetch("https://app/api/v1/drills"), 60);
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: "upstream unavailable", detail: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
};
