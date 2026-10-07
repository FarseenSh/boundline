import type { ReactNode } from "react";

export type StepState = "idle" | "active" | "done" | "failed";

export interface Step {
  label: ReactNode;
  state: StepState;
  detail?: ReactNode;
  when?: string;
}

export function Timeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="timeline">
      {steps.map((s, i) => (
        <li key={i}>
          <span className={`dot ${s.state}`} aria-hidden="true" />
          {s.when ? <span className="when">{s.when}</span> : null}
          <span className="what">{s.label}</span>
          {s.detail ? <span className="detail">{s.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}
