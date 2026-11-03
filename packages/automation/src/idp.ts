import type { Condition, LoginMethodId } from "./recipe.js";
import type { Selector } from "./selector.js";

/**
 * Built-in identity-provider flows for "Sign in with Apple / Google / Microsoft / GitHub". A recipe declares only the
 * provider-side button; once the browser lands on one of the identity provider's hosts, the flow below types the credentials
 * the human gave the portal, asks the portal for codes and approvals, and hands back to the provider.
 *
 * The credentials are typed only on the hosts listed in `hosts`. Every selector and text here is NOT VERIFIED against the live
 * pages: each step waits for its element, so a wrong guess fails visibly instead of clicking something else.
 */

export type IdpId = Exclude<LoginMethodId, "email">;

export type IdpStep =
  | { waitFor: Condition; timeoutSeconds?: number }
  | { fill: Selector; value: "{{login.username}}" | "{{login.password}}" }
  | { click: Selector };

export interface IdpFlow {
  id: IdpId;
  /** The hosts the credentials may be typed into (exact host names). */
  hosts: readonly string[];
  /** From the first identity-provider page to submitting the password. */
  steps: readonly IdpStep[];
  /** The one-time code (authenticator, SMS, device code). */
  mfa: { detect: Condition; field: Selector; submit: Selector };
  /** Approval on another device. `number` reads the number the page shows, if any. */
  approval: { detect: Condition; message: string; messageEn: string; number?: Selector };
  /** A passkey prompt: the flow picks the code fallback instead. */
  passkey?: { detect: Condition; fallback: Selector };
  /** "Trust this browser", "Stay signed in": clicked when shown. */
  trust?: Selector;
  /** The first-use OAuth consent page. Never approved silently: the portal shows `scopes` and the human confirms. */
  consent?: { detect: Condition; scopes: Selector; approve: Selector };
  failure: readonly { detect: Condition; message: string; messageEn: string }[];
}

const css = (c: string): Selector => ({ css: c });
const vis = (c: string): Condition => ({ visible: css(c) });

export const IDP_FLOWS: Readonly<Record<IdpId, IdpFlow>> = {
  // not verified: Apple shows its sign-in in a frame of idmsa.apple.com; the selectors may need the frame.
  apple: {
    id: "apple",
    hosts: ["appleid.apple.com", "idmsa.apple.com"],
    steps: [
      { waitFor: vis("#account_name_text_field"), timeoutSeconds: 30 },
      { fill: css("#account_name_text_field"), value: "{{login.username}}" },
      { click: css("#sign-in") },
      { waitFor: vis("#password_text_field"), timeoutSeconds: 30 },
      { fill: css("#password_text_field"), value: "{{login.password}}" },
      { click: css("#sign-in") },
    ],
    mfa: { detect: vis("input.form-security-code-input, input[id^=char]"), field: css("input[id^=char] >> nth=0"), submit: css("button[type=submit]") },
    approval: { detect: { text: "Check your other devices" }, message: "Bestaetige die Anmeldung auf deinem Apple-Geraet.", messageEn: "Approve the sign-in on your device ..." },
    trust: css("button.trust-browser"),
    failure: [
      { detect: { text: "incorrect" }, message: "Apple hat Apple-Konto oder Passwort abgelehnt.", messageEn: "Apple rejected the Apple Account or the password." },
      { detect: { text: "locked" }, message: "Apple hat das Konto gesperrt. Spaeter erneut versuchen.", messageEn: "Apple has locked the account. Try again later." },
    ],
  },
  // not verified.
  google: {
    id: "google",
    hosts: ["accounts.google.com"],
    steps: [
      { waitFor: vis("input[type=email]"), timeoutSeconds: 30 },
      { fill: css("input[type=email]"), value: "{{login.username}}" },
      { click: css("#identifierNext") },
      { waitFor: vis("input[type=password]"), timeoutSeconds: 30 },
      { fill: css("input[type=password]"), value: "{{login.password}}" },
      { click: css("#passwordNext") },
    ],
    mfa: { detect: vis("input[name=totpPin], input[name=Pin]"), field: css("input[name=totpPin], input[name=Pin]"), submit: css("#totpNext, #idvPreregisteredPhoneNext") },
    approval: { detect: { text: "Check your phone" }, message: "Bestaetige die Anmeldung auf deinem Telefon.", messageEn: "Approve the sign-in on your device ...", number: css("[data-number], .fWWlmf") },
    failure: [
      { detect: { text: "Wrong password" }, message: "Google hat das Passwort abgelehnt.", messageEn: "Google rejected the password." },
      { detect: { text: "Couldn't find your Google Account" }, message: "Google kennt diese E-Mail-Adresse nicht.", messageEn: "Google does not know this email address." },
    ],
  },
  // not verified.
  microsoft: {
    id: "microsoft",
    hosts: ["login.microsoftonline.com", "login.live.com"],
    steps: [
      { waitFor: vis("input[name=loginfmt]"), timeoutSeconds: 30 },
      { fill: css("input[name=loginfmt]"), value: "{{login.username}}" },
      { click: css("#idSIButton9") },
      { waitFor: vis("input[name=passwd]"), timeoutSeconds: 30 },
      { fill: css("input[name=passwd]"), value: "{{login.password}}" },
      { click: css("#idSIButton9") },
    ],
    mfa: { detect: vis("input[name=otc]"), field: css("input[name=otc]"), submit: css("#idSubmit_SAOTCC_Continue") },
    approval: { detect: { text: "Approve sign in request" }, message: "Bestaetige die Anmeldung in der Authenticator-App.", messageEn: "Approve the sign-in on your device ...", number: css("#idRichContext_DisplaySign") },
    trust: css("#idBtn_Back"),
    failure: [
      { detect: { text: "password is incorrect" }, message: "Microsoft hat das Passwort abgelehnt.", messageEn: "Microsoft rejected the password." },
      { detect: { text: "account doesn't exist" }, message: "Microsoft kennt dieses Konto nicht.", messageEn: "Microsoft does not know this account." },
    ],
  },
  // not verified.
  github: {
    id: "github",
    hosts: ["github.com"],
    steps: [
      { waitFor: vis("#login_field"), timeoutSeconds: 30 },
      { fill: css("#login_field"), value: "{{login.username}}" },
      { fill: css("#password"), value: "{{login.password}}" },
      { click: css("input[name=commit]") },
    ],
    mfa: { detect: vis("#app_totp, #sms_totp, #otp"), field: css("#app_totp, #sms_totp, #otp"), submit: css("button[type=submit]") },
    approval: { detect: { text: "GitHub Mobile" }, message: "Bestaetige die Anmeldung in GitHub Mobile.", messageEn: "Approve on GitHub Mobile ...", number: css(".mobile-number, [data-testid=mobile-number]") },
    // A passkey prompt: GitHub offers "Use authenticator app" or "Use a verification code" as the way around it.
    passkey: { detect: { text: "passkey" }, fallback: { text: "authenticator app" } },
    consent: { detect: vis("button[name=authorize]"), scopes: css(".oauth-permissions, [data-testid=oauth-scopes]"), approve: css("button[name=authorize]") },
    failure: [{ detect: { text: "Incorrect username or password" }, message: "GitHub hat Benutzername oder Passwort abgelehnt.", messageEn: "GitHub rejected the username or password." }],
  },
};

/** Is `hostname` one of the hosts the flow of this identity provider may type credentials into? */
export function idpHostAllowed(id: IdpId, hostname: string): boolean {
  return IDP_FLOWS[id].hosts.includes(hostname.toLowerCase());
}
