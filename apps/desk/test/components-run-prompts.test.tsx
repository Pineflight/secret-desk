import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccessPrompt, ApprovalNotice, CodePrompt, ConsentPrompt, CredentialsPrompt } from "@/components/RunPrompts";
import type { FacadeMethod, RunAsk } from "@/lib/facade";
import { renderApp } from "./helpers/render";
import { drainRequestsAfterEach } from "./helpers/drain";

drainRequestsAfterEach();

type Access = Extract<RunAsk, { type: "access" }>;
const choose = (over: Partial<Extract<Access, { stage: "choose" }>> = {}): Access => ({ type: "access", stage: "choose", methods: ["mobile", "code", "password"], attempt: 1, maxAttempts: 3, ...over });

describe("CodePrompt", () => {
  it("keeps the send button disabled for an invalid code and sends a valid one once, then clears the field", async () => {
    const onSend = vi.fn();
    const { user } = renderApp(<CodePrompt name="Stripe" pending={false} onSend={onSend} />);
    expect(screen.getByText(/Stripe hat einen Code geschickt/)).toBeInTheDocument();
    const send = screen.getByRole("button", { name: "Code senden" });
    const field = screen.getByLabelText("Einmalcode");
    expect(send).toBeDisabled();
    await user.type(field, "12");
    expect(send).toBeDisabled();
    fireEvent.submit(field.closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
    await user.type(field, "34 56");
    expect(send).toBeEnabled();
    await user.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("1234 56");
    expect(field).toHaveValue("");
    expect(send).toBeDisabled();
  });

  it("submits on Enter and disables the button while pending", async () => {
    const onSend = vi.fn();
    const { user, rerender } = renderApp(<CodePrompt name="Stripe" pending={false} onSend={onSend} />);
    await user.type(screen.getByLabelText("Einmalcode"), "ABCD{Enter}");
    expect(onSend).toHaveBeenCalledWith("ABCD");
    rerender(<CodePrompt name="Stripe" pending onSend={onSend} />);
    expect(screen.getByRole("button", { name: "Code senden" })).toBeDisabled();
  });
});

describe("ApprovalNotice", () => {
  it("shows the number only when the page shows one", () => {
    const { rerender } = renderApp(<ApprovalNotice name="Stripe" number="42" />);
    expect(screen.getByText("Wartet auf Bestätigung")).toBeInTheDocument();
    expect(screen.getByText("Wenn dein Gerät nach einer Zahl fragt, wähle 42.")).toBeInTheDocument();
    rerender(<ApprovalNotice name="Stripe" />);
    expect(screen.queryByText(/wähle/)).toBeNull();
    expect(screen.getByText(/Stripe wartet darauf/)).toBeInTheDocument();
  });
});

describe("ConsentPrompt", () => {
  it("lists the requested access and reports the answer", async () => {
    const onAnswer = vi.fn();
    const { user } = renderApp(<ConsentPrompt idp="GitHub" name="Stripe" scopes={"read:user; repo\nemail"} pending={false} onAnswer={onAnswer} />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["read:user", "repo", "email"]);
    await user.click(screen.getByRole("button", { name: "Autorisieren" }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Ablehnen" }));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
  });

  it("disables both answers while pending and shows no list without scopes", () => {
    renderApp(<ConsentPrompt idp="GitHub" name="Stripe" scopes={undefined} pending onAnswer={() => {}} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Autorisieren" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ablehnen" })).toBeDisabled();
  });
});

describe("CredentialsPrompt", () => {
  const methods = (over: Partial<FacadeMethod>[] = []): FacadeMethod[] => over.map((o, i) => ({ id: i === 0 ? "email" : "google", label: null, labelEn: null, ...o }));

  it("sends the trimmed email and the password once and clears both fields", async () => {
    const onSend = vi.fn();
    const { user } = renderApp(<CredentialsPrompt name="Peecho" methods={methods([{}])} pending={false} onSend={onSend} />);
    expect(screen.getByText("Bei Peecho anmelden")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
    const send = screen.getByRole("button", { name: "Anmelden" });
    expect(send).toBeDisabled();
    const email = screen.getByLabelText("E-Mail bei Peecho");
    const password = screen.getByLabelText("Passwort bei Peecho");
    await user.type(email, "  me@example.test  ");
    fireEvent.submit(email.closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
    await user.type(password, "password-for-tests");
    await user.click(send);
    expect(onSend).toHaveBeenCalledWith({ method: "email", username: "me@example.test", password: "password-for-tests" });
    expect(email).toHaveValue("");
    expect(password).toHaveValue("");
  });

  it("falls back to the email method for an empty method list and rejects overlong input", () => {
    renderApp(<CredentialsPrompt name="Peecho" methods={[]} pending={false} onSend={() => {}} />);
    const send = screen.getByRole("button", { name: "Anmelden" });
    fireEvent.change(screen.getByLabelText("E-Mail bei Peecho"), { target: { value: "a".repeat(255) } });
    fireEvent.change(screen.getByLabelText("Passwort bei Peecho"), { target: { value: "p" } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("E-Mail bei Peecho"), { target: { value: "a@b.test" } });
    fireEvent.change(screen.getByLabelText("Passwort bei Peecho"), { target: { value: "p".repeat(1025) } });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Passwort bei Peecho"), { target: { value: "p".repeat(1024) } });
    expect(send).toBeEnabled();
  });

  it("offers several sign-in methods with translated or own German labels and switches the field labels", async () => {
    const onSend = vi.fn();
    const { user } = renderApp(<CredentialsPrompt name="Peecho" methods={methods([{ label: "Mit Passwort" }, { labelEn: "Google (en)" }])} pending={false} onSend={onSend} />);
    expect(screen.getByText("Wie meldest du dich bei Peecho an?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Mit Passwort" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Mit Google anmelden" }));
    await user.type(screen.getByLabelText("E-Mail des Google-Kontos"), "me@example.test");
    await user.type(screen.getByLabelText("Google-Passwort"), "password-for-tests");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(onSend).toHaveBeenCalledWith({ method: "google", username: "me@example.test", password: "password-for-tests" });
  });

  it("shows English labels in the English interface, with a fallback for methods without one", () => {
    localStorage.setItem("sd-locale", "en");
    renderApp(<CredentialsPrompt name="Peecho" methods={methods([{ label: "Mit Passwort", labelEn: "With password" }, { label: "Google de" }])} pending={false} onSend={() => {}} />);
    expect(screen.getByRole("radio", { name: "With password" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("shows the busy state", () => {
    renderApp(<CredentialsPrompt name="Peecho" methods={[]} pending onSend={() => {}} />);
    expect(screen.getByRole("button", { name: "Anmelden" })).toBeDisabled();
  });
});

describe("AccessPrompt", () => {
  it("shows the number to tap for GitHub Mobile, or the plain request without a number", () => {
    const { rerender } = renderApp(<AccessPrompt name="GitHub" ask={{ type: "access", stage: "mobile", number: "37" }} pending={false} onSend={() => {}} />);
    expect(screen.getByText("Öffne GitHub Mobile und tippe 37.")).toBeInTheDocument();
    rerender(<AccessPrompt name="GitHub" ask={{ type: "access", stage: "mobile", number: "" }} pending={false} onSend={() => {}} />);
    expect(screen.getByText("Öffne GitHub Mobile und bestätige die Anfrage.")).toBeInTheDocument();
  });

  it("says the access is being checked", () => {
    renderApp(<AccessPrompt name="GitHub" ask={{ type: "access", stage: "checking", method: "code" }} pending={false} onSend={() => {}} />);
    expect(screen.getByText("GitHub prüft die Bestätigung ...")).toBeInTheDocument();
  });

  it("confirms with GitHub Mobile by default without asking for a value", async () => {
    const onSend = vi.fn();
    const { user } = renderApp(<AccessPrompt name="GitHub" ask={choose()} pending={false} onSend={onSend} />);
    expect(screen.getByRole("radio", { name: /GitHub Mobile/ })).toBeChecked();
    expect(screen.queryByLabelText("Code")).toBeNull();
    expect(screen.getByText(/Wähle, wie du bestätigst/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(onSend).toHaveBeenCalledWith({ method: "mobile" });
  });

  it("sends a code, validates it and clears it after sending, and resets the value when the method changes", async () => {
    const onSend = vi.fn();
    const { user } = renderApp(<AccessPrompt name="GitHub" ask={choose()} pending={false} onSend={onSend} />);
    await user.click(screen.getByRole("radio", { name: /Code/ }));
    const field = screen.getByLabelText("Code");
    expect(field).toHaveAttribute("type", "text");
    const send = screen.getByRole("button", { name: "Bestätigen" });
    expect(send).toBeDisabled();
    fireEvent.submit(field.closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
    await user.type(field, "123456");
    await user.click(screen.getByRole("radio", { name: "Passwort" }));
    expect(screen.getByLabelText("Passwort", { selector: "input[type=password]" })).toHaveValue("");
    await user.click(screen.getByRole("radio", { name: /Code/ }));
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(send);
    expect(onSend).toHaveBeenCalledWith({ method: "code", code: "123456" });
    expect(screen.getByLabelText("Code")).toHaveValue("");
  });

  it("sends a password of valid length only", async () => {
    const onSend = vi.fn();
    const { user } = renderApp(<AccessPrompt name="GitHub" ask={choose({ methods: ["password"] })} pending={false} onSend={onSend} />);
    const field = screen.getByLabelText("Passwort", { selector: "input[type=password]" });
    expect(field).toHaveAttribute("type", "password");
    const send = screen.getByRole("button", { name: "Bestätigen" });
    expect(send).toBeDisabled();
    fireEvent.change(field, { target: { value: "x".repeat(1025) } });
    expect(send).toBeDisabled();
    fireEvent.change(field, { target: { value: "password-for-tests" } });
    await user.click(send);
    expect(onSend).toHaveBeenCalledWith({ method: "password", password: "password-for-tests" });
  });

  it("starts with the first offered method when mobile is not offered and falls back to mobile for none", () => {
    const { rerender } = renderApp(<AccessPrompt name="GitHub" ask={choose({ methods: ["code", "password"] })} pending={false} onSend={() => {}} />);
    expect(screen.getByRole("radio", { name: /Code/ })).toBeChecked();
    rerender(<AccessPrompt name="GitHub" ask={choose({ methods: [] })} pending={false} onSend={() => {}} />);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("button", { name: "Bestätigen" })).toBeEnabled();
  });

  it("shows the attempt counter after the first attempt and the problem with a retry button", () => {
    const { rerender } = renderApp(<AccessPrompt name="GitHub" ask={choose({ attempt: 2, maxAttempts: 3 })} pending={false} onSend={() => {}} />);
    expect(screen.getByText("Versuch 2 von 3")).toBeInTheDocument();
    rerender(<AccessPrompt name="GitHub" ask={choose({ problem: "rejected" })} pending={false} onSend={() => {}} />);
    expect(screen.getByText(/GitHub hat die Bestätigung nicht akzeptiert/)).toBeInTheDocument();
    expect(screen.queryByText("Versuch 2 von 3")).toBeNull();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });

  it("disables the button while pending", () => {
    renderApp(<AccessPrompt name="GitHub" ask={choose()} pending onSend={() => {}} />);
    expect(screen.getByRole("button", { name: "Bestätigen" })).toBeDisabled();
  });
});
