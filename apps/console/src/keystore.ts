// The pasted partner key lives in sessionStorage only (gone when the tab closes), never in the URL, never
// in a cookie, never logged. The console's own partner key stays on the Worker as a secret.
const KEY = "boundline-console-partner-key";
const listeners = new Set<() => void>();

export function getPastedKey(): string | null {
  try {
    const v = window.sessionStorage.getItem(KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function setPastedKey(value: string | null): void {
  try {
    if (value && value.trim()) window.sessionStorage.setItem(KEY, value.trim());
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage can be blocked; the console then uses the Worker's key */
  }
  for (const l of listeners) l();
}

export function subscribeKey(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** "bl_live_…" style keys are shown masked: first 4 and last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
