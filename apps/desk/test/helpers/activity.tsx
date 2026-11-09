import type { ReactNode } from "react";
import { CardActivityProvider, useCardActivityState } from "@/lib/use-card-activity";

/** Provides the card activity state of one page (spinner, last result, toasts) like the Integrations page does. */
export function ActivityHost({ children }: { children: ReactNode }) {
  const activity = useCardActivityState();
  return <CardActivityProvider value={activity}>{children}</CardActivityProvider>;
}
