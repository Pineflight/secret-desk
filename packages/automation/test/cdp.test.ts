import { describe, expect, it, vi } from "vitest";
import { cdpEndpointFrom, probeCdp, resolveCdpEndpoint } from "../src/index.js";

describe("cdpEndpointFrom", () => {
  it("prefers the environment variable over the configuration", () => {
    expect(cdpEndpointFrom("http://cfg:9222", { SECRET_DESK_BROWSER_CDP: "http://env:9222" })).toBe("http://env:9222");
    expect(cdpEndpointFrom("http://cfg:9222", {})).toBe("http://cfg:9222");
    expect(cdpEndpointFrom(undefined, { SECRET_DESK_BROWSER_CDP: "  " })).toBeUndefined();
    expect(cdpEndpointFrom("  ", {})).toBeUndefined();
  });
});

describe("resolveCdpEndpoint", () => {
  it("replaces a service name by its IP address (Chromium rejects other Host headers)", async () => {
    const lookup = vi.fn(async () => "172.18.0.5");
    expect(await resolveCdpEndpoint("http://browser:9222", lookup)).toBe("http://172.18.0.5:9222/");
    expect(lookup).toHaveBeenCalledWith("browser");
  });
  it("leaves IP addresses and localhost alone", async () => {
    const lookup = vi.fn(async () => "1.2.3.4");
    expect(await resolveCdpEndpoint("http://127.0.0.1:9222", lookup)).toBe("http://127.0.0.1:9222/");
    expect(await resolveCdpEndpoint("http://[::1]:9222", lookup)).toBe("http://[::1]:9222/");
    expect(await resolveCdpEndpoint("http://localhost:9222", lookup)).toBe("http://localhost:9222/");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("rejects other schemes without echoing the input", async () => {
    await expect(resolveCdpEndpoint("file:///etc/passwd")).rejects.toThrow(/only http, https, ws and wss/);
    await expect(resolveCdpEndpoint("ftp://user:hunter2@host")).rejects.not.toThrow(/hunter2/);
    await expect(resolveCdpEndpoint("not a url")).rejects.toThrow(/Invalid browser endpoint/);
  });
  it("names the host, not the address, when it does not resolve", async () => {
    await expect(resolveCdpEndpoint("http://u:p@nohost:9222", async () => Promise.reject(new Error("ENOTFOUND")))).rejects.toThrow("Cannot resolve the browser host nohost.");
  });
});

describe("probeCdp", () => {
  const lookup = async () => "10.0.0.2";
  it("reports the browser version when /json/version answers", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(JSON.stringify({ Browser: "Chrome/140.0.1" }), { status: 200 }));
    const r = await probeCdp("http://browser:9222", { fetch: fetchMock as unknown as typeof fetch, resolveHost: lookup });
    expect(r).toEqual({ reachable: true, browser: "Chrome/140.0.1", detail: null });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://10.0.0.2:9222/json/version");
  });
  it("sends credentials as a header, never in the URL, and never returns them", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response("nope", { status: 401 }));
    const r = await probeCdp("http://user:s3cret@browser:9222", { fetch: fetchMock as unknown as typeof fetch, resolveHost: lookup });
    expect(r).toEqual({ reachable: false, browser: null, detail: "The browser answered with HTTP 401." });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("s3cret");
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["authorization"]).toBe(`Basic ${Buffer.from("user:s3cret").toString("base64")}`);
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });
  it("is not reachable on a network error and on an invalid address", async () => {
    const down = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.2:9222");
    });
    const r = await probeCdp("http://browser:9222", { fetch: down as unknown as typeof fetch, resolveHost: lookup });
    expect(r).toMatchObject({ reachable: false, detail: "The browser endpoint is not reachable." });
    expect(JSON.stringify(r)).not.toContain("10.0.0.2");
    expect(await probeCdp("gopher://x")).toMatchObject({ reachable: false });
  });
});
