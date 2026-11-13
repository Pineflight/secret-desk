import { describe, expect, it } from "vitest";
import { base64ToBytes, base64ToUtf8, bytesToBase64, bytesToBase64Url, utf8ToBase64, utf8ToBase64Url } from "../src/base64.js";

const SAMPLES = ["", "plain ascii", "Grüße aus München: äöüÄÖÜß", "emoji \u{1F600}\u{1F680} and CJK 你好", "line\nbreak\r\nand\ttab", "\u0000nul"];

describe("portable Base64 helpers", () => {
  it("encodes UTF-8 text exactly like Buffer does", () => {
    for (const text of SAMPLES) {
      expect(utf8ToBase64(text)).toBe(Buffer.from(text, "utf8").toString("base64"));
      expect(utf8ToBase64Url(text)).toBe(Buffer.from(text, "utf8").toString("base64url"));
    }
  });

  it("round-trips umlauts, emoji and the empty string", () => {
    for (const text of SAMPLES) {
      expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
      expect(base64ToUtf8(utf8ToBase64Url(text))).toBe(text);
    }
    expect(utf8ToBase64("")).toBe("");
    expect(base64ToUtf8("")).toBe("");
  });

  it("round-trips a 1 MB input without overflowing the stack", () => {
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(Buffer.from(base64ToBytes(encoded)).equals(Buffer.from(bytes))).toBe(true);
    const text = "ä\u{1F600}x".repeat(300_000);
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });

  it("writes Base64URL without padding and without the + and / characters", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0xfa]);
    expect(bytesToBase64(bytes)).toBe("+//++g==");
    expect(bytesToBase64Url(bytes)).toBe("-__--g");
    expect(bytesToBase64Url(new Uint8Array([1]))).toBe("AQ");
    expect(bytesToBase64Url(new Uint8Array([]))).toBe("");
  });

  it("reads Base64 with line breaks, Base64URL and missing padding", () => {
    expect(base64ToUtf8("SGVs\nbG8g\r\nd29y bGQ=\n")).toBe("Hello world");
    expect(Array.from(base64ToBytes("-__-"))).toEqual([0xfb, 0xff, 0xfe]);
    expect(Array.from(base64ToBytes("-__-"))).toEqual(Array.from(base64ToBytes("+//+")));
    expect(base64ToUtf8("AQ")).toBe("\u0001");
    expect(base64ToUtf8("AQ==")).toBe("\u0001");
  });

  it("turns invalid UTF-8 into U+FFFD like Buffer does", () => {
    const invalid = Buffer.from([0xff, 0xfe, 0x41]).toString("base64");
    expect(base64ToUtf8(invalid)).toBe(Buffer.from(invalid, "base64").toString("utf8"));
  });

  it("throws on characters outside the alphabet", () => {
    expect(() => base64ToBytes("not base64 !!")).toThrow();
  });
});
