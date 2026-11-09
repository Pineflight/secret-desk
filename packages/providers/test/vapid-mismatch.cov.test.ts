import { beforeEach, describe, expect, it, vi } from "vitest";

// The pair guard and the point-shape check can only fail when node:crypto misbehaves, so crypto is faked here.
const state = vi.hoisted(() => ({ mode: "real" as "real" | "second-differs" | "short-point", calls: 0 }));

vi.mock("node:crypto", async (importActual) => {
  const actual = await importActual<typeof import("node:crypto")>();
  return {
    ...actual,
    createECDH: (curve: string) => {
      const real = actual.createECDH(curve);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === "getPublicKey") {
            return (...args: unknown[]) => {
              if (state.mode === "short-point") return Buffer.alloc(33, 2);
              state.calls += 1;
              if (state.mode === "second-differs" && state.calls > 1) return Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
              return (target.getPublicKey as (...a: unknown[]) => Buffer)(...args);
            };
          }
          const v = Reflect.get(target, prop) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
  };
});

const { vapidProvider: p } = await import("../src/vapid.js");
const { byId, issueCtx, mockFetch, verifyCtx } = await import("./helpers.js");

describe("vapid-keypair guards", () => {
  beforeEach(() => {
    state.mode = "real";
    state.calls = 0;
  });
  it("never offers a pair whose private key does not derive the public key", async () => {
    // generateVapidKeys derives once (in core, not faked); the guard derives again through the faked crypto and gets another point.
    state.mode = "second-differs";
    await expect(p.issue!(issueCtx(mockFetch().fetch, { publicKeyVariable: "vapid-public" }))).rejects.toThrow("Das erzeugte Schluesselpaar passt nicht zusammen");
  });
  it("fails the public key check when the derived point is not an uncompressed 65-byte point", async () => {
    state.mode = "short-point";
    const checks = await p.verify!(verifyCtx(mockFetch().fetch, {}, { value: Buffer.alloc(32, 1).toString("base64url") }));
    expect(byId(checks)["public"]).toBe("fail");
    expect(checks.find((c) => c.id === "public")!.actual).toBe("33 Byte");
  });
});
