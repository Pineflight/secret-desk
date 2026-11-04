import { describe, expect, it } from "vitest";
import { stripeKeyCarriesAccount } from "../src/connection-check.js";

// Keys are assembled at run time so secret scanners do not mistake the fixtures for real keys.
const key = (prefix: string, body: string) => `${prefix}_${body}`;

describe("stripeKeyCarriesAccount", () => {
  const acct = "acct_1AbCdEfGhIjKlMn";
  it("accepts restricted and secret keys of the account in both modes", () => {
    expect(stripeKeyCarriesAccount(key("rk_test", "51AbCdEfGhIjKlMnXyz0123456789"), acct)).toBe(true);
    expect(stripeKeyCarriesAccount(key("rk_live", "51AbCdEfGhIjKlMnXyz0123456789"), acct)).toBe(true);
    expect(stripeKeyCarriesAccount(key("sk_test", "51AbCdEfGhIjKlMnXyz0123456789"), acct)).toBe(true);
  });
  it("rejects a key of another account", () => {
    expect(stripeKeyCarriesAccount(key("rk_test", "51ZzZzZzZzZzZzZzXyz0123456789"), acct)).toBe(false);
  });
  it("rejects keys without the 51 marker, publishable keys and malformed accounts", () => {
    expect(stripeKeyCarriesAccount(key("rk_test", "AbCdEfGhIjKlMnXyz0123456789"), acct)).toBe(false);
    expect(stripeKeyCarriesAccount(key("pk_test", "51AbCdEfGhIjKlMnXyz0123456789"), acct)).toBe(false);
    expect(stripeKeyCarriesAccount(key("rk_test", "51AbCdEfGhIjKlMnXyz0123456789"), "acct_2AbCdEfGhIjKlMn")).toBe(false);
    expect(stripeKeyCarriesAccount(key("rk_test", "51AbCXyz"), "acct_1AbC")).toBe(false);
  });
});
