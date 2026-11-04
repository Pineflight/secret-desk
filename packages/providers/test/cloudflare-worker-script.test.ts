import { describe, expect, it } from "vitest";
import { ParamsInvalidError } from "@secret-desk/core";
import { createDefaultRegistry } from "../src/index.js";
import { connections, routeFetch } from "./helpers.js";

const token = createDefaultRegistry().get("cloudflare-token")!;
const dctx = (f: typeof fetch, params: Record<string, unknown> = {}) => ({ connections: connections("cloudflare"), fetch: f, params, hint: { repos: [] } });

describe("cloudflare.workerScript discovery (place editor of Worker secrets)", () => {
  it("is declared as a discover kind of the cloudflare integration without being a parameter", () => {
    expect(token.discoverKinds).toContain("cloudflare.workerScript");
    expect((token.params ?? []).some((s) => s.discover === "cloudflare.workerScript")).toBe(false);
  });

  it("lists the deployed Workers of the account, read-only", async () => {
    const { fetch, calls } = routeFetch({ url: "/accounts/acc1/workers/scripts", reply: { body: { result: [{ id: "acme-portal", modified_on: "2026-11-01T00:00:00Z" }, { id: "acme-portal-staging" }, { nope: true }] } } });
    const options = await token.discover!("cloudflare.workerScript", dctx(fetch, { accountId: "acc1" }));
    expect(options.map((o) => o.value)).toEqual(["acme-portal", "acme-portal-staging"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
  });

  it("needs the account first", async () => {
    const { fetch, calls } = routeFetch();
    await expect(token.discover!("cloudflare.workerScript", dctx(fetch))).rejects.toBeInstanceOf(ParamsInvalidError);
    expect(calls).toHaveLength(0);
  });
});
