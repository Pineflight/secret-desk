import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvDownload } from "@/components/EnvDownload";
import { LaunchForm } from "@/components/LaunchForm";
import { resetSessionForTests } from "@/lib/api";
import { fakePortal } from "./helpers/portal";
import { renderApp } from "./helpers/render";
import { pickOption } from "./helpers/select";

describe("EnvDownload", () => {
  let created: Blob[];
  let clicked: HTMLAnchorElement[];
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    created = [];
    clicked = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { created.push(b as Blob); return "blob:test"; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("downloads the dotenv file for the default stage and reports counts, never showing the content", async () => {
    const portal = fakePortal({ "POST env/export": { filename: ".env", content: "A=content-for-tests", format: "dotenv", keys: ["A", "B"], missing: ["C"] } });
    const { user } = renderApp(<EnvDownload repo="acme-app" />);
    await user.click(screen.getByRole("button", { name: "Datei herunterladen" }));
    expect(await screen.findByText("2 Werte in der Datei, 1 fehlen (als Kommentar aufgeführt).")).toBeInTheDocument();
    expect(portal.callsTo("POST", "env/export")[0]?.body).toEqual({ repo: "acme-app", stage: "dev", include: "variables", format: "dotenv" });
    expect(clicked[0]?.download).toBe(".env");
    expect(created[0]?.type).toBe("text/plain");
    expect(screen.queryByText(/content-for-tests/)).toBeNull();
    expect(await screen.findByText("Datei heruntergeladen.")).toBeInTheDocument();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("sends the chosen stage, scope and json format and downloads json", async () => {
    const portal = fakePortal({ "POST env/export": { filename: "env.json", content: "{}", format: "json", keys: [], missing: [] } });
    const { user } = renderApp(<EnvDownload repo="acme-app" />);
    await pickOption(user, "Stage", /production/i);
    await pickOption(user, "Inhalt", /Variablen und Secrets|Alles|Secret/i);
    await pickOption(user, "Format", "JSON");
    await user.click(screen.getByRole("button", { name: "Datei herunterladen" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.type).toBe("application/json");
    expect(portal.callsTo("POST", "env/export")[0]?.body).toEqual({ repo: "acme-app", stage: "production", include: "all", format: "json" });
  });

  it("shows the error and downloads nothing when the export fails", async () => {
    fakePortal({ "POST env/export": { status: 400, body: { error: "no template" } } });
    const { user } = renderApp(<EnvDownload repo="acme-app" />);
    await user.click(screen.getByRole("button", { name: "Datei herunterladen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no template");
    expect(clicked).toHaveLength(0);
  });
});

describe("LaunchForm", () => {
  const SECRET = "made-up-launch-secret-for-tests_0123456789";
  const session = { csrf: "csrf-for-tests", user: "tester", demo: false, owner: "tester" };
  beforeEach(() => resetSessionForTests());

  it("keeps the button disabled until something is typed and rejects input that is no launch secret", async () => {
    const onSession = vi.fn();
    const { user } = renderApp(<LaunchForm onSession={onSession} />);
    const submit = screen.getByRole("button", { name: "Öffnen" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Startadresse oder Startgeheimnis"), "short");
    await user.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("Das ist keine Startadresse");
    expect(onSession).not.toHaveBeenCalled();
  });

  it("opens the session with the pasted secret and clears the field", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onSession = vi.fn();
    const { user } = renderApp(<LaunchForm onSession={onSession} />);
    const field = screen.getByLabelText("Startadresse oder Startgeheimnis");
    await user.type(field, `http://127.0.0.1:4747/?launch=${SECRET}`);
    await user.click(screen.getByRole("button", { name: "Öffnen" }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(session));
    expect(field).toHaveValue("");
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ "x-secret-desk-launch": SECRET });
  });

  it("tells a wrong secret apart from other failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "launch-required" }), { status: 401 })));
    const { user } = renderApp(<LaunchForm onSession={() => {}} />);
    await user.type(screen.getByLabelText("Startadresse oder Startgeheimnis"), SECRET);
    await user.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Das Startgeheimnis passt nicht");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "server broke" }), { status: 500 })));
    await user.click(screen.getByRole("button", { name: "Öffnen" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("server broke"));
  });

  it("shows plain errors and non-error rejections as text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { user } = renderApp(<LaunchForm onSession={() => {}} />);
    await user.type(screen.getByLabelText("Startadresse oder Startgeheimnis"), SECRET);
    await user.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    vi.stubGlobal("fetch", vi.fn(async () => { throw "plain-text-failure"; }));
    await user.click(screen.getByRole("button", { name: "Öffnen" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("plain-text-failure"));
  });
});
