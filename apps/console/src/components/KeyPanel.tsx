// Sign-in: paste a partner key (kept in this tab's sessionStorage, sent as a bearer the Worker forwards) or use
// the console's own key, which lives on the Worker as a secret and never reaches the browser.
import { useState } from "react";
import { useConsoleConfig, useForgetAll, usePastedKey } from "../hooks.js";
import { maskKey, setPastedKey } from "../keystore.js";

export function KeyPanel() {
  const pasted = usePastedKey();
  const config = useConsoleConfig();
  const forget = useForgetAll();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);

  const apply = (): void => {
    setPastedKey(draft);
    setDraft("");
    setOpen(false);
    forget();
  };
  const signOut = (): void => {
    setPastedKey(null);
    forget();
  };

  return (
    <section className="keypanel" aria-label="Partner sign-in">
      {pasted ? (
        <span className="row">
          <span>
            Signed in with your partner key <code>{maskKey(pasted)}</code> (this tab only).
          </span>
          <button className="btn small ghost" onClick={signOut}>
            Sign out
          </button>
        </span>
      ) : (
        <span className="row">
          <span>
            {config.data?.hasPartnerKey ? (
              <>
                Using the console's own partner key for <b>{config.data.partnerId}</b>.
              </>
            ) : config.isLoading ? (
              "Checking the console's key…"
            ) : (
              "No partner key configured on the console Worker; paste yours to continue."
            )}
          </span>
          <button className="btn small" onClick={() => setOpen((o) => !o)}>
            {open ? "Cancel" : "Use my partner key"}
          </button>
        </span>
      )}
      {open && !pasted ? (
        <form
          className="row keyform"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <input type="password" autoComplete="off" spellCheck={false} placeholder="Partner API key" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Partner API key" />
          <button className="btn small primary" type="submit" disabled={draft.trim().length < 8}>
            Sign in
          </button>
          <span className="hint mute">Held in this tab's session storage, sent only to the console's proxy as a bearer header.</span>
        </form>
      ) : null}
    </section>
  );
}
