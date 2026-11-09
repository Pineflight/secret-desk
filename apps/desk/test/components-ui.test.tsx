import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, LinkButton, ListSkeleton, Notice, PageHeader, Pill, ProviderChip, SectionLabel, SelectField, Skeleton, Stat, StageBadge, StatusBadge, Tabs, TextAreaField, TextField } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { SetupStep } from "@/components/SetupStep";
import { SyncDiff } from "@/components/SyncDiff";
import { ApiError } from "@/lib/api";
import type { BundleDiff } from "@/lib/team-sync";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { drainRequestsAfterEach } from "./helpers/drain";

drainRequestsAfterEach();

beforeEach(() => {
  fakePortal({ "GET stages": [] });
});

describe("ui primitives", () => {
  it("renders card, label, header with and without subtitle and actions", () => {
    renderApp(<><Card className="x">inside</Card><SectionLabel className="y">Label</SectionLabel><PageHeader title="Only" /></>);
    expect(screen.getByText("inside")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Label" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Only", level: 1 })).toBeInTheDocument();
  });

  it("renders the page header subtitle and actions", () => {
    renderApp(<PageHeader title="T" subtitle="Sub" actions={<button>Go</button>} />);
    expect(screen.getByText("Sub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
  });

  it("shows badges in full and compact form", () => {
    renderApp(<><Badge info={{ label: "Full", tone: "neutral", icon: "dot" }} className="z" /><Badge compact info={{ label: "Small", tone: "neutral", icon: "dot" }} /><StatusBadge level="ok" /><StageBadge stage="prod" /><ProviderChip automatic={true} /><ProviderChip automatic={false} /><ProviderChip automatic browser /><ProviderChip automatic readOnly /><Pill>pill</Pill></>);
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(screen.getByText("Small")).toHaveClass("sr-only");
    expect(screen.getByTitle("Small")).toBeInTheDocument();
    expect(screen.getByText("pill")).toBeInTheDocument();
  });

  it("disables a loading button and keeps clicks working otherwise", async () => {
    const onClick = vi.fn();
    const { user, rerender } = renderApp(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button loading variant="danger" onClick={onClick}>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    rerender(<Button disabled variant="primary">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("renders link buttons with and without an aria label", () => {
    renderApp(<><LinkButton href="/a">Plain</LinkButton><LinkButton href="/b" aria-label="Labelled" variant="ghost">Icon</LinkButton></>);
    expect(screen.getByRole("link", { name: "Plain" })).toHaveAttribute("href", "/a");
    expect(screen.getByRole("link", { name: "Labelled" })).toHaveAttribute("href", "/b");
  });

  it("connects labels to fields and shows hints only when given", async () => {
    const onChange = vi.fn();
    const { user } = renderApp(
      <>
        <Field label="Bare">x</Field>
        <TextField label="Name" hint="Name hint" className="w" onChange={onChange} />
        <TextField label="Plain" />
        <TextAreaField label="Notes" hint="Notes hint" />
        <TextAreaField label="Notes2" />
      </>,
    );
    await user.type(screen.getByLabelText("Name"), "ab");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Name hint")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes2")).toBeInTheDocument();
    expect(screen.getByLabelText("Plain")).toBeInTheDocument();
  });

  it("passes select field options through, with and without optional flags", async () => {
    function Host({ flags }: { flags: boolean }) {
      const [v, setV] = useState("a");
      return (
        <SelectField label="Pick" value={v} onChange={(e) => setV(e.target.value)} {...(flags ? { disabled: false, required: true, searchable: true, hint: "Pick hint" } : {})}>
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </SelectField>
      );
    }
    const { user, rerender } = renderApp(<Host flags={false} />);
    expect(screen.getByRole("combobox", { name: "Pick" })).toBeInTheDocument();
    rerender(<Host flags />);
    await user.click(screen.getByRole("combobox", { name: "Pick" }));
    await user.click(await screen.findByRole("option", { name: "Beta" }));
    expect(screen.getByText("Pick hint")).toBeInTheDocument();
  });

  it("toggles a checkbox and respects disabled", async () => {
    const onChange = vi.fn();
    const { user, rerender } = renderApp(<Checkbox checked={false} onChange={onChange}>Agree</Checkbox>);
    await user.click(screen.getByLabelText("Agree"));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Checkbox checked disabled onChange={onChange}>Agree</Checkbox>);
    expect(screen.getByLabelText("Agree")).toBeDisabled();
  });

  it("shows skeletons, empty states and notices", () => {
    renderApp(
      <>
        <Skeleton />
        <Skeleton className="h-2" />
        <ListSkeleton />
        <ListSkeleton rows={2} />
        <EmptyState title="Nothing" />
        <EmptyState title="Nothing 2" icon="eye">Explain</EmptyState>
        <Notice>Plain info</Notice>
        <Notice tone="danger" title="Bad">Detail</Notice>
        <Notice tone="warn" title="Careful" />
        <Notice tone="success" icon="eye">Fine</Notice>
      </>,
    );
    expect(screen.getAllByRole("status", { name: "Wird geladen" })).toHaveLength(2);
    expect(screen.getByText("Explain")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Bad");
    expect(screen.getAllByRole("note")).toHaveLength(3);
  });

  it("shows an error with retry and the missing connection hint", async () => {
    const onRetry = vi.fn();
    const { user, rerender } = renderApp(<ErrorState error={new Error("boom")} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<ErrorState error={new ApiError(400, "not linked", { code: "not-connected", connection: "github" })} onRetry={onRetry} />);
    expect(screen.getByText(/Die Verbindung „github“ fehlt/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zu den Integrationen" })).toHaveAttribute("href", "/connections");
    await user.click(screen.getByRole("button", { name: /Erneut versuchen/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorState error={new ApiError(400, "not linked", { code: "not-connected" })} />);
    expect(screen.getByText(/Die Verbindung „\?“ fehlt/)).toBeInTheDocument();
    rerender(<ErrorState error={new ApiError(500, "other")} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("switches tabs by click and arrow keys and ignores other keys", async () => {
    function Host({ prefix }: { prefix?: string }) {
      const [v, setV] = useState<"a" | "b" | "c">("a");
      return <Tabs label="Sections" value={v} onChange={setV} {...(prefix ? { idPrefix: prefix } : {})} tabs={[{ id: "a", label: "A", count: 3 }, { id: "b", label: "B" }, { id: "c", label: "C" }]} />;
    }
    const { user, rerender } = renderApp(<Host />);
    const tab = (n: string) => screen.getByRole("tab", { name: new RegExp(`^${n}`) });
    expect(tab("A")).toHaveAttribute("aria-selected", "true");
    expect(tab("A")).toHaveTextContent("3");
    await user.click(tab("B"));
    expect(tab("B")).toHaveAttribute("aria-selected", "true");
    tab("B").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("C")).toHaveFocus();
    await user.keyboard("x");
    expect(tab("C")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(tab("A")).toHaveFocus();
    rerender(<Host prefix="p" />);
    expect(tab("A")).toHaveAttribute("aria-controls", "p-panel-a");
    expect(tab("A")).toHaveAttribute("id", "p-tab-a");
  });

  it("shows stats in every tone", () => {
    renderApp(<><Stat label="d" value={1} tone="danger" /><Stat label="w" value={2} tone="warn" /><Stat label="i" value={3} tone="info" /><Stat label="s" value="4" tone="success" /><Stat label="n" value={5} /></>);
    expect(screen.getByText("1")).toHaveClass("text-danger-text");
    expect(screen.getByText("2")).toHaveClass("text-warn-text");
    expect(screen.getByText("3")).toHaveClass("text-info-text");
    expect(screen.getByText("4")).toHaveClass("text-success-text");
    expect(screen.getByText("5")).toHaveClass("text-ink");
  });
});

describe("Icon", () => {
  it("falls back to the dot for unknown names and takes a class", () => {
    const { container } = renderApp(<><Icon name="no-such-icon" /><Icon name="eye" className="h-9 w-9" /></>);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    expect(container.querySelectorAll("svg")[1]).toHaveClass("h-9");
  });
});

describe("SetupStep", () => {
  it("shows a number, a check once done and marks the current step", () => {
    renderApp(
      <ol>
        <SetupStep number={1} title="Repo" status="done" />
        <SetupStep number={2} title="File" status="current"><span>content</span></SetupStep>
        <SetupStep number={3} title="Mode" status="todo" />
      </ol>,
    );
    expect(screen.getByText("Repo").closest("li")).not.toHaveAttribute("aria-current");
    expect(screen.getByText("File").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getByText("Mode")).toHaveClass("text-muted-text");
  });
});

describe("SyncDiff", () => {
  const none = { added: [], changed: [], removed: [] };
  const sections = (over: Partial<BundleDiff["sections"]>): BundleDiff["sections"] => ({ secrets: none, variables: none, stages: none, providers: none, envTemplates: none, ...over });

  it("says there are no differences", () => {
    renderApp(<SyncDiff diff={{ empty: true, sections: sections({}) }} />);
    expect(screen.getByText("Keine Unterschiede.")).toBeInTheDocument();
  });

  it("lists ids per section and skips untouched sections", () => {
    renderApp(<SyncDiff diff={{ empty: false, sections: sections({ secrets: { added: ["s1"], changed: [], removed: [] }, variables: { added: [], changed: ["v1"], removed: ["v2"] } }) }} />);
    expect(screen.getByRole("heading", { name: "Secrets" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Variablen" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Stages" })).toBeNull();
    expect(screen.getByText(/\+ s1/)).toHaveTextContent("neu");
    expect(screen.getByText(/~ v1/)).toHaveTextContent("geändert");
    expect(screen.getByText(/− v2/)).toHaveTextContent("nur lokal");
  });
});
