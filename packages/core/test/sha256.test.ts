import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexBytes } from "../src/sha256.js";

const reference = (text: string): string => createHash("sha256").update(text).digest("hex");
const referenceBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("sha256Hex and sha256HexBytes match node:crypto", () => {
  it("returns the published test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256HexBytes(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexBytes(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches around the block boundaries", () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 65_537]) {
      const text = "a".repeat(length);
      expect(sha256Hex(text), `text of ${length}`).toBe(reference(text));
      const bytes = new Uint8Array(length).fill(0xff);
      expect(sha256HexBytes(bytes), `bytes of ${length}`).toBe(referenceBytes(bytes));
    }
  });

  it("matches for non-BMP and multi-byte characters", () => {
    for (const text of ["\u{1F600}", "a\u{1F680}b", "äöüß", "€", "\u{10FFFF}", "\u0000", "line\r\nbreak", "\u{1F468}‍\u{1F469}‍\u{1F467}"]) {
      expect(sha256Hex(text), JSON.stringify(text)).toBe(reference(text));
    }
  });

  it("treats a lone surrogate like node:crypto (both encode U+FFFD)", () => {
    for (const text of ["\ud800", "\udc00", "a\ud800b", "\ud83dx", "x\ude00", "\ud83d😀", "\ude00\ud83d"]) {
      expect(sha256Hex(text), JSON.stringify(text)).toBe(reference(text));
      expect(sha256Hex(text)).toBe(sha256Hex(text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�")));
    }
  });

  it("matches for a few hundred random inputs", () => {
    for (let i = 0; i < 300; i += 1) {
      const bytes = new Uint8Array(randomBytes(i % 200));
      expect(sha256HexBytes(bytes), `bytes ${i}`).toBe(referenceBytes(bytes));
      let text = "";
      for (let j = 0; j < i % 150; j += 1) text += String.fromCodePoint(Math.floor(Math.random() * 0x10000) % 0xd800 || 0x41, ...(j % 7 === 0 ? [0x1f600 + (j % 80)] : []));
      expect(sha256Hex(text), `text ${i}`).toBe(reference(text));
    }
  });

  it("random strings that may contain lone surrogates match as well", () => {
    for (let i = 0; i < 200; i += 1) {
      let text = "";
      for (let j = 0; j < i % 60; j += 1) text += String.fromCharCode(Math.floor(Math.random() * 0x10000));
      expect(sha256Hex(text), `text ${i}`).toBe(reference(text));
    }
  });
});
