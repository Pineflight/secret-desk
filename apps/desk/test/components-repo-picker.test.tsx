import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { RepoPicker } from "@/components/RepoPicker";
import { invalidateRepoList } from "@/lib/repo-list";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { drainRequestsAfterEach } from "./helpers/drain";

drainRequestsAfterEach();

const row = (name: string, over: Record<string, unknown> = {}) => ({ name, secrets: 0, variables: 0, templates: 0, inInventory: true, github: null, link: null, ...over });
const LIST = {
  owner: "acme",
  github: "ok",
  repos: [row("alpha", { github: { private: false, archived: false, pushedAt: null }, link: { path: "/x", exists: true, remote: null, remoteMatches: null } }), row("alphabet", { inInventory: false, github: { private: true, archived: false, pushedAt: null } }), row("beta")],
};

function Host({ initial = "", onChange, ...rest }: { initial?: string; onChange?: (v: string) => void; id?: string; placeholder?: string; required?: boolean; className?: string; ariaLabel?: string }) {
  const [v, setV] = useState(initial);
  return <RepoPicker value={v} onChange={(x) => { setV(x); onChange?.(x); }} {...rest} />;
}

beforeEach(() => invalidateRepoList());

describe("RepoPicker", () => {
  it("suggests repositories with their sources on focus and picks one with the mouse", async () => {
    fakePortal({ "GET repos?live=1": LIST });
    const onChange = vi.fn();
    const { user } = renderApp(<Host ariaLabel="Repo" placeholder="owner/name" required id="rp" className="extra" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: "Repo" });
    expect(input).toHaveAttribute("placeholder", "owner/name");
    expect(input).toBeRequired();
    expect(screen.getByRole("listbox", { hidden: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await user.click(input);
    expect(await screen.findByRole("option", { name: /alpha.*Inventar · GitHub · verknüpft/ })).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "true");
    await user.hover(screen.getByRole("option", { name: /beta/ }));
    expect(screen.getByRole("option", { name: /beta/ })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: /beta/ }));
    expect(onChange).toHaveBeenLastCalledWith("beta");
    expect(input).toHaveValue("beta");
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "false"));
  });

  it("filters while typing, navigates with arrow keys in a ring and picks with Enter", async () => {
    fakePortal({ "GET repos?live=1": LIST });
    const onChange = vi.fn();
    const { user } = renderApp(<Host ariaLabel="Repo" onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "alp");
    expect(await screen.findAllByRole("option")).toHaveLength(2);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-o0$/);
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-o1$/);
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-o0$/);
    await user.keyboard("{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-o1$/);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("alphabet");
    expect(input).toHaveValue("alphabet");
  });

  it("ignores Enter without an active suggestion and other keys", async () => {
    fakePortal({ "GET repos?live=1": LIST });
    const onChange = vi.fn();
    const { user } = renderApp(<Host ariaLabel="Repo" onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "b");
    await screen.findAllByRole("option");
    onChange.mockClear();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}{Escape}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens the closed list with ArrowDown on the first and ArrowUp on the last suggestion", async () => {
    fakePortal({ "GET repos?live=1": LIST });
    const { user } = renderApp(<Host ariaLabel="Repo" />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await screen.findAllByRole("option");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(input).toHaveAttribute("aria-expanded", "false"));
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-o0$/);
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-o2$/);
  });

  it("closes the list on Escape without letting a surrounding dialog see the key, and on blur", async () => {
    fakePortal({ "GET repos?live=1": LIST });
    const outer = vi.fn();
    const { user } = renderApp(<div onKeyDown={outer}><Host ariaLabel="Repo" /></div>);
    const input = screen.getByRole("combobox");
    await user.click(input);
    await screen.findAllByRole("option");
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    await user.keyboard("{Escape}");
    expect(outer).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(input);
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("stays a free text field when the list is empty or cannot be loaded", async () => {
    fakePortal({ "GET repos?live=1": { status: 500, body: { error: "down" } } });
    const onChange = vi.fn();
    const { user } = renderApp(<Host ariaLabel="Repo" onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "x/y");
    expect(onChange).toHaveBeenLastCalledWith("x/y");
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("x/y");
  });

  it("uses the cached list for a second picker without another request", async () => {
    const portal = fakePortal({ "GET repos?live=1": LIST });
    const first = renderApp(<Host ariaLabel="Repo" />);
    await first.user.click(screen.getByRole("combobox"));
    await screen.findAllByRole("option");
    first.unmount();
    const second = renderApp(<Host ariaLabel="Repo" />);
    await second.user.click(screen.getByRole("combobox"));
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(portal.callsTo("GET", "repos?live=1")).toHaveLength(1);
  });
});
