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

import type { FacadeInfo } from "@/lib/facade";

/** A guided sign-in provider (facade) as the server lists it. */
export const facadeInfo = (over: Partial<FacadeInfo> = {}): FacadeInfo => ({
  id: "stripe",
  label: "Stripe",
  recipeId: "stripe-recipe",
  connectionId: "stripe",
  issuesKeysByApi: true,
  available: true,
  reason: null,
  recipeStatus: null,
  host: "dashboard.stripe.test",
  connected: false,
  needsProject: false,
  inputs: [],
  timeoutMinutes: 10,
  methods: [],
  promise: null,
  ...over,
});
