import type { ReactNode } from "react";
import { Icon } from "@/components/Icons";
import type { StepStatus } from "@/lib/setup-steps";

/** One numbered step of a form: a round number (a check once done) and a heading; the content sits under it. */
export function SetupStep({ number, title, status, children }: { number: number; title: string; status: StepStatus; children?: ReactNode }) {
  return (
    <li className="flex gap-3" aria-current={status === "current" ? "step" : undefined}>
      <span
        className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          status === "done" ? "bg-success-light text-success-text" : status === "current" ? "bg-primary text-white" : "bg-page text-muted-text ring-1 ring-inset ring-line"
        }`}
      >
        {status === "done" ? <Icon name="check" className="h-3.5 w-3.5" /> : number}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pb-1">
        <p className={`text-sm font-medium ${status === "todo" ? "text-muted-text" : ""}`}>{title}</p>
        {children}
      </div>
    </li>
  );
}
