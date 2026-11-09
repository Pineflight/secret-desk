import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EditMetaDialog, ExternalLink, MetaFields, TagChips, TagInput, TagPills, metaBody, metaFrom, metaPatch, validateMeta, type MetaValues } from "@/components/Meta";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";

const empty: MetaValues = { description: "", owner: "", link: "", tags: [] };

describe("meta value helpers", () => {
  it("fills missing parts with empty values", () => {
    expect(metaFrom({})).toEqual(empty);
    expect(metaFrom({ description: "d", owner: "o", link: "https://x.test", tags: ["a"] })).toEqual({ description: "d", owner: "o", link: "https://x.test", tags: ["a"] });
    expect(metaFrom({ description: null, owner: null, link: null })).toEqual(empty);
  });

  it("builds a create body with filled fields only and a patch body that nulls empty ones", () => {
    expect(metaBody(empty)).toEqual({});
    expect(metaBody({ description: " d ", owner: " o ", link: " https://x.test ", tags: ["a"] })).toEqual({ description: "d", owner: "o", link: "https://x.test", tags: ["a"] });
    expect(metaPatch(empty)).toEqual({ description: null, owner: null, link: null, tags: [] });
    expect(metaPatch({ description: "d", owner: "o", link: "https://x.test", tags: ["a"] })).toEqual({ description: "d", owner: "o", link: "https://x.test", tags: ["a"] });
  });

  it("validates description length and link shape", () => {
    expect(validateMeta(empty)).toBeNull();
    expect(validateMeta({ ...empty, description: "x".repeat(501) })).toBe("Die Beschreibung ist länger als 500 Zeichen.");
    expect(validateMeta({ ...empty, link: "ftp://x" })).toBe("Der Link muss mit http:// oder https:// beginnen.");
    expect(validateMeta({ ...empty, link: " https://x.test " })).toBeNull();
  });
});

describe("tag display", () => {
  it("renders nothing without tags", () => {
    const { container } = renderApp(<><TagPills tags={[]} /><TagChips tags={[]} /></>);
    expect(container.querySelector("span")).toBeNull();
  });

  it("renders static pills and picks through buttons, marking the active one", async () => {
    const onPick = vi.fn();
    const { user, rerender } = renderApp(<TagPills tags={["a", "b"]} />);
    expect(screen.getByText("#a").tagName).toBe("SPAN");
    rerender(<TagPills tags={["a", "b"]} onPick={onPick} active="b" />);
    await user.click(screen.getByRole("button", { name: "#a" }));
    expect(onPick).toHaveBeenCalledWith("a");
    expect(screen.getByRole("button", { name: "#a" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "#b" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders every chip tier with a +N chip for hidden tags, static or clickable", async () => {
    const tags = ["one", "two", "three", "four", "five"];
    const { container, rerender, user } = renderApp(<TagChips tags={tags} />);
    const texts = [...container.querySelectorAll("span.shrink-0")].map((e) => e.textContent);
    expect(texts).toContain("#one+4");
    expect(texts).toContain("#one#two+3");
    expect(texts).toContain("#one#two#three+2");
    expect(container.querySelector('[title="#one\n#two\n#three\n#four\n#five"]')).not.toBeNull();

    const onPick = vi.fn();
    rerender(<TagChips tags={["one", "two"]} onPick={onPick} active="one" />);
    const pressed = container.querySelectorAll('button[aria-pressed="true"]');
    expect(pressed.length).toBeGreaterThan(0);
    await user.click(container.querySelector("button[title='#two']") as HTMLElement);
    expect(onPick).toHaveBeenCalledWith("two");
  });
});

function TagHarness({ initial = [] as string[], onChange = () => {} }: { initial?: string[]; onChange?: (t: string[]) => void }) {
  const [tags, setTags] = useState(initial);
  return <TagInput tags={tags} onChange={(t) => { setTags(t); onChange(t); }} />;
}

describe("TagInput", () => {
  it("adds tags with comma, Enter and blur, and removes them with the pill button", async () => {
    const onChange = vi.fn();
    const { user } = renderApp(<TagHarness onChange={onChange} />);
    const input = screen.getByLabelText("Schlagworte");
    await user.type(input, "pay,");
    expect(onChange).toHaveBeenLastCalledWith(["pay"]);
    await user.type(input, "web{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["pay", "web"]);
    await user.type(input, "ops");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(["pay", "web", "ops"]);
    await user.click(screen.getByRole("button", { name: "Schlagwort web entfernen" }));
    expect(onChange).toHaveBeenLastCalledWith(["pay", "ops"]);
    expect(screen.queryByText("#web")).toBeNull();
  });

  it("ignores empty input and shows the error for an invalid tag until corrected", async () => {
    const onChange = vi.fn();
    const { user } = renderApp(<TagHarness onChange={onChange} />);
    const input = screen.getByLabelText("Schlagworte");
    await user.type(input, "{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Kleinbuchstaben, Ziffern und Bindestriche/)).toBeInTheDocument();
    await user.type(input, "-bad{Enter}");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "good{Enter}");
    expect(onChange).toHaveBeenCalledWith(["good"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("MetaFields", () => {
  it("edits every field and counts the description length", async () => {
    const onChange = vi.fn();
    const Harness = () => {
      const [v, setV] = useState(empty);
      return <MetaFields value={v} onChange={(n) => { setV(n); onChange(n); }} />;
    };
    const { user } = renderApp(<Harness />);
    await user.type(screen.getByLabelText("Beschreibung (empfohlen)"), "abc");
    expect(screen.getByText("3/500")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Verantwortlich"), "team");
    await user.type(screen.getByLabelText("Link"), "https://x.test");
    await user.type(screen.getByLabelText("Schlagworte"), "pay{Enter}");
    expect(onChange).toHaveBeenLastCalledWith({ description: "abc", owner: "team", link: "https://x.test", tags: ["pay"] });
  });

  it("marks an over-long description", () => {
    renderApp(<MetaFields value={{ ...empty, description: "x".repeat(501) }} onChange={() => {}} />);
    expect(screen.getByText("501/500")).toHaveClass("text-danger-text");
  });
});

describe("EditMetaDialog", () => {
  it("patches the trimmed values with notes and reports saved", async () => {
    const portal = fakePortal({ "PATCH secrets/s1": {} });
    const onSaved = vi.fn();
    const { user } = renderApp(<EditMetaDialog path="secrets/s1" initial={{ ...empty, description: "old" }} notes="n1" onClose={() => {}} onSaved={onSaved} />);
    await user.clear(screen.getByLabelText("Hinweise"));
    await user.type(screen.getByLabelText("Beschreibung (empfohlen)"), " new");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(portal.callsTo("PATCH", "secrets/s1")[0]?.body).toEqual({ description: "old new", owner: null, link: null, tags: [], notes: null });
    expect(await screen.findByText("Gespeichert.")).toBeInTheDocument();
  });

  it("omits notes when none are given and cancels", async () => {
    const portal = fakePortal({ "PATCH variables/v1": {} });
    const onClose = vi.fn();
    const { user } = renderApp(<EditMetaDialog path="variables/v1" initial={empty} onClose={onClose} onSaved={() => {}} />);
    expect(screen.queryByLabelText("Hinweise")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(portal.callsTo("PATCH", "variables/v1")).toHaveLength(1));
    expect(portal.callsTo("PATCH", "variables/v1")[0]?.body).not.toHaveProperty("notes");
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps notes filled in the body", async () => {
    const portal = fakePortal({ "PATCH secrets/s1": {} });
    const { user } = renderApp(<EditMetaDialog path="secrets/s1" initial={empty} notes={null} onClose={() => {}} onSaved={() => {}} />);
    await user.type(screen.getByLabelText("Hinweise"), " remember ");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(portal.callsTo("PATCH", "secrets/s1")).toHaveLength(1));
    expect(portal.callsTo("PATCH", "secrets/s1")[0]?.body).toMatchObject({ notes: "remember" });
  });

  it("shows validation errors without calling the portal and the server error otherwise", async () => {
    const portal = fakePortal({ "PATCH secrets/s1": { status: 422, body: { error: "rejected by server" } } });
    const { user } = renderApp(<EditMetaDialog path="secrets/s1" initial={{ ...empty, link: "ftp://bad" }} onClose={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Der Link muss mit http:// oder https:// beginnen.");
    expect(portal.callsTo("PATCH", "secrets/s1")).toHaveLength(0);
    const link = screen.getByLabelText("Link");
    await user.clear(link);
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("rejected by server"));
  });
});

describe("ExternalLink", () => {
  it("links http addresses safely and prints other text plainly", () => {
    const { rerender } = renderApp(<ExternalLink href="https://x.test/a" />);
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("href", "https://x.test/a");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(a).toHaveAttribute("target", "_blank");
    rerender(<ExternalLink href="javascript:alert(1)" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
  });
});


