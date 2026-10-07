import { ApiRequestError } from "../api.js";

/** One line for every failed read: a 404/501 from a route Lane D is still adding reads as "not live yet". */
export function ErrorNote({ error, what }: { error: unknown; what: string }) {
  if (error instanceof ApiRequestError) {
    if (error.notLive) {
      return (
        <p className="notice warn">
          {what}: the API route answered {error.status}, so this endpoint is not live on the partner API yet. The page is wired to its contract and fills in as soon as it is deployed.
        </p>
      );
    }
    if (error.status === 401) return <p className="notice">{what}: the partner API refused the key (401). Paste a valid partner key, or sign out to use the console's own.</p>;
    if (error.status === 503) return <p className="notice">{what}: {error.message}</p>;
    return (
      <p className="notice">
        {what}: {error.message} (HTTP {error.status}
        {error.body?.correlationId ? `, correlation ${String(error.body.correlationId)}` : ""})
      </p>
    );
  }
  return <p className="notice">{what}: {error instanceof Error ? error.message : String(error)}</p>;
}
