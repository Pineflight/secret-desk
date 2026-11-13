// Portable (no Node built-ins): shared by platform.ts and the evidence id rule.

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Windows-reservierte Geraetenamen (CON, NUL, COM1 ...), auch mit Endung (`nul.txt`) und nachgestellten Punkten/Leerzeichen. */
export function isReservedWindowsName(name: string): boolean {
  const base = name.replace(/[. ]+$/, "").split(".")[0]!.trimEnd();
  return RESERVED.test(base);
}
