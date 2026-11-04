import { createHash, createHmac } from "node:crypto";

/** Minimal AWS Signature Version 4 for single requests, built on node:crypto only (no SDK). */

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters is percent-encoded. */
const encode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
  /** Extra headers to sign (names are lower-cased). `host` and `x-amz-date` are added. */
  headers?: Record<string, string>;
  /** Request body; empty by default. */
  body?: string;
  /** Add and sign `x-amz-content-sha256` (required by S3 and R2). */
  contentSha256Header?: boolean;
}

export interface Signed {
  headers: Record<string, string>;
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

/** `20150830T123600Z` */
export const amzDate = (d: Date): string => d.toISOString().replace(/[:-]|\.\d{3}/g, "");

/** Signs a request and returns the headers to send (Authorization included). Path segments are encoded once, as S3 expects. */
export function signRequest(input: SignInput): Signed {
  const url = new URL(input.url);
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const payloadHash = sha256Hex(input.body ?? "");
  const headers: Record<string, string> = { host: url.host, "x-amz-date": date };
  if (input.contentSha256Header) headers["x-amz-content-sha256"] = payloadHash;
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const path = url.pathname.split("/").map((p) => encode(decodeURIComponent(p))).join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [input.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // `host` is signed but not sent explicitly: fetch sets it from the URL.
  const { host: _host, ...send } = headers;
  return { headers: { ...send, Authorization: authorization }, signature, canonicalRequest, stringToSign };
}
