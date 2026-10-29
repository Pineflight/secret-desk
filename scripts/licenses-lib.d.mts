export const ALLOWED: string[];
export const WARN: string[];
export type LicenseStatus = "allowed" | "warn" | "review" | "denied" | "unknown";
export interface LicenseEntry { name: string; version: string; license: string; source: string; status: LicenseStatus; platformFamily?: boolean }
export function normalizeLicense(pj: Record<string, unknown>): string;
export function classify(expression: string): LicenseStatus;
export function platformFamily(name: string): string | null;
export interface LicenseData { entries: LicenseEntry[]; families: { name: string; licenses: string[] }[] }
export function collect(root: string, listJson?: unknown): LicenseData;
export function summarize(entries: LicenseEntry[]): Record<LicenseStatus, LicenseEntry[]>;
export function renderNotices(data: LicenseData): string;
export function renderJson(data: LicenseData): string;
export function policyReport(data: LicenseData): { fail: LicenseEntry[]; warn: LicenseEntry[]; ok: boolean };
