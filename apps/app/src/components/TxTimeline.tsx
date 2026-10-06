import type { ReactNode } from "react";

export type StepState = "idle" | "active" | "done" | "failed";

export interface Step {
  label: string;
  state: StepState;
  detail?: ReactNode;
}

export function TxTimeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="timeline">
      {steps.map((s, i) => (
        <li key={i}>
          <span className={`dot ${s.state}`} aria-hidden="true" />
          <span className="what">{s.label}</span>
          {s.detail ? <span className="detail">{s.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}
