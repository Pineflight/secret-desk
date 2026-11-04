"use client";
import { useMemo } from "react";
import type { SecretView, VariableView } from "@secret-desk/runtime";
import { api } from "./api";
import type { FacadeInfo } from "./facade";
import { useQuery } from "./hooks";
import { buildCards, type ConnectionRow, type ProviderRow, type VendorsResponse } from "./provider-cards";
import { DEFAULT_RENEWAL_WARN_DAYS, renewalWarnings, type RenewalWarning } from "./renewal-warning";
import type { AutomationInfo } from "@/components/BrowserAutomationPanel";

/**
 * The renewal warnings for the pages that show them (overview, entries). Loads what the provider cards are built from; while
 * anything is missing or failed to load there is simply no warning (a hint must never get in the way of the page).
 */
export function useRenewalWarnings(): RenewalWarning[] {
  const auto = useQuery<AutomationInfo>("automation", () => api<AutomationInfo>("GET", "automation"));
  const vendors = useQuery<VendorsResponse>("vendors", () => api<VendorsResponse>("GET", "vendors"));
  const conns = useQuery<ConnectionRow[]>("connections", () => api<ConnectionRow[]>("GET", "connections"));
  const provs = useQuery<ProviderRow[]>("providers-full", () => api<ProviderRow[]>("GET", "providers"));
  const facades = useQuery<FacadeInfo[]>("facades", () => api<FacadeInfo[]>("GET", "facades"));
  const secrets = useQuery<SecretView[]>("overview-secrets", () => api<SecretView[]>("GET", "secrets"));
  const vars = useQuery<VariableView[]>("overview-variables", () => api<VariableView[]>("GET", "variables"));
  return useMemo(() => {
    if (!auto.data?.enabled || !vendors.data || !conns.data || !secrets.data) return [];
    const cards = buildCards({
      catalog: vendors.data,
      connections: conns.data,
      providers: provs.data ?? [],
      recipes: auto.data.recipes,
      facades: facades.data ?? [],
      secrets: secrets.data,
      variables: vars.data ?? [],
      automationEnabled: true,
      signInChecks: auto.data.signInChecks,
      signInFreshHours: auto.data.signInFreshHours,
      now: new Date(),
    });
    return renewalWarnings(secrets.data, cards, auto.data.renewalWarnDays ?? DEFAULT_RENEWAL_WARN_DAYS);
  }, [auto.data, vendors.data, conns.data, provs.data, facades.data, secrets.data, vars.data]);
}
