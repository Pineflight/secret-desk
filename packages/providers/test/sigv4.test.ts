import { describe, expect, it } from "vitest";
import { amzDate, sha256Hex, signRequest } from "../src/sigv4.js";

describe("sigv4", () => {
  it("hashes with SHA-256 (known vector)", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("formats the signing date", () => {
    expect(amzDate(new Date("2015-08-30T12:36:00.000Z"))).toBe("20150830T123600Z");
  });
  it("matches the AWS test suite vector get-vanilla", () => {
    const s = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(s.canonicalRequest).toBe("GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(s.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(s.headers["Authorization"]).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(s.headers["host"]).toBeUndefined();
  });
  it("sorts and encodes the query and signs the content hash header for S3", () => {
    const s = signRequest({ method: "GET", url: "https://acc.r2.cloudflarestorage.com/my bucket?max-keys=1&list-type=2", region: "auto", service: "s3", accessKeyId: "id", secretAccessKey: "secret", now: new Date("2026-11-01T10:00:00Z"), contentSha256Header: true });
    expect(s.canonicalRequest.split("\n").slice(0, 3)).toEqual(["GET", "/my%20bucket", "list-type=2&max-keys=1"]);
    expect(s.headers["x-amz-content-sha256"]).toBe(sha256Hex(""));
    expect(s.headers["Authorization"]).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });
});
