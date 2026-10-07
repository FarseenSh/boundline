import type { Tone } from "../timeline.js";

export function Tag({ tone = "plain", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  const cls = tone === "live" ? "tag live" : tone === "bad" ? "tag bad" : tone === "warn" ? "tag warn" : "tag";
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}
