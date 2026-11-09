import type { FacadeState } from "@/lib/facade";

/** A sign-in run state as the server reports it. */
export const runState = (over: Partial<FacadeState> = {}): FacadeState => ({
  secretId: "s",
  providerId: "p",
  status: "running",
  text: "",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  phase: "username",
  ...over,
});
