// Display helpers. ET formatting goes through Intl, which Workers ship with full ICU. Building an
// Intl.DateTimeFormat is the expensive part (about 10 ms the first time on 6 Oct 2026, and not free after),
// and the page formats dozens of instants, so the two formatters are built once per isolate and reused.
const ET = "America/New_York";

const formatters: { plain?: Intl.DateTimeFormat; seconds?: Intl.DateTimeFormat } = {};

function etFormatter(withSeconds: boolean): Intl.DateTimeFormat {
  const key = withSeconds ? "seconds" : "plain";
  const hit = formatters[key];
  if (hit) return hit;
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
    hour12: false,
    timeZoneName: "short",
  });
  formatters[key] = f;
  return f;
}

export function fmtEt(epochSeconds: number | null | undefined, withSeconds = false): string {
  if (!epochSeconds) return "—";
  try {
    return etFormatter(withSeconds).format(new Date(epochSeconds * 1000));
  } catch {
    return new Date(epochSeconds * 1000).toISOString();
  }
}

export function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h < 48 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// `Number.toLocaleString` builds an Intl.NumberFormat on every call; the page formats hundreds of amounts
// (measured 33 to 50 ms of CPU per page on 7 Oct 2026), so one formatter per digit count is kept.
const usdFormatters = new Map<number, Intl.NumberFormat>();

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  let f = usdFormatters.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    usdFormatters.set(digits, f);
  }
  return f.format(n);
}

export function fmtBps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)} bps`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
