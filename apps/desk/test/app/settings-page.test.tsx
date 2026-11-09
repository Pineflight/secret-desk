import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SettingsPage from "@/app/settings/page";
import { translate as t } from "@/lib/i18n";
import { navigation } from "../helpers/navigation";
import { fakePortal } from "../helpers/portal";
import { renderApp } from "../helpers/render";

const stage = { id: "dev", label: "Dev", kind: "development", environmentName: null, usage: { secrets: 0, variables: 0, templates: 0, agent: false } };

describe("Settings page", () => {
  it("shows a skeleton for the stages tab until the stages arrived, then the stages panel", async () => {
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((resolve) => (release = resolve));
    fakePortal({ "GET stages": () => gate });
    renderApp(<SettingsPage />);
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "settings-panel-stages");
    expect(screen.getByRole("tab", { name: t("settings.tab.stages") })).toHaveAttribute("aria-selected", "true");
    expect(panel.querySelector(".sd-skeleton")).not.toBeNull();
    release([stage]);
    expect(await screen.findByRole("button", { name: t("settings.editAria", { id: "dev" }) })).toBeInTheDocument();
  });

  it("opens the tab named in the address and loads its panel", async () => {
    navigation.set("/settings?tab=language");
    fakePortal({ "GET stages": [stage] });
    renderApp(<SettingsPage />);
    expect(screen.getByRole("tab", { name: t("settings.tab.language") })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("English")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "settings-panel-language");
  });

  it.each([
    ["policy", "policy broke"],
    ["storage", "storage broke"],
    ["developer", "developer broke"],
  ])("loads the %s panel and reports its failure", async (tab, error) => {
    navigation.set(`/settings?tab=${tab}`);
    fakePortal({ "GET stages": [stage], "GET settings": { status: 500, body: { error } }, "GET automation": { status: 500, body: { error } } });
    renderApp(<SettingsPage />);
    expect(await screen.findByText(error)).toBeInTheDocument();
  });

  it("falls back to the stages tab for an unknown tab name", async () => {
    navigation.set("/settings?tab=nonsense");
    fakePortal({ "GET stages": [stage] });
    renderApp(<SettingsPage />);
    expect(screen.getByRole("tab", { name: t("settings.tab.stages") })).toHaveAttribute("aria-selected", "true");
    await screen.findByRole("button", { name: t("settings.editAria", { id: "dev" }) });
  });

  it("puts the chosen tab into the address and drops it again for the first tab", async () => {
    navigation.set("/settings?keep=1");
    fakePortal({ "GET stages": [stage] });
    const { user } = renderApp(<SettingsPage />);
    await user.click(screen.getByRole("tab", { name: t("settings.tab.policy") }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/settings?keep=1&tab=policy", { scroll: false });
    await user.click(screen.getByRole("tab", { name: t("settings.tab.stages") }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/settings?keep=1", { scroll: false });
  });

  it("goes to a bare /settings when no other parameter is left", async () => {
    navigation.set("/settings?tab=language");
    fakePortal({ "GET stages": [stage] });
    const { user } = renderApp(<SettingsPage />);
    await user.click(screen.getByRole("tab", { name: t("settings.tab.stages") }));
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/settings", { scroll: false });
    await waitFor(() => expect(screen.getByRole("tabpanel")).toBeInTheDocument());
  });

  it("moves between tabs with the arrow keys", async () => {
    fakePortal({ "GET stages": [stage] });
    const { user } = renderApp(<SettingsPage />);
    screen.getByRole("tab", { name: t("settings.tab.stages") }).focus();
    await user.keyboard("{ArrowRight}");
    expect(navigation.router.replace).toHaveBeenLastCalledWith("/settings?tab=policy", { scroll: false });
  });
});
