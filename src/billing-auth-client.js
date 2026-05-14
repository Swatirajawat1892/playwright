/**
 * BillingAuth API — POST with Username/Password headers; returns JWT for downstream calls.
 * Shared by Temporal activity / OHID run (same env as worker).
 *
 * Env:
 * - BILLING_AUTH_URL      — optional; defaults to production ATC BillingAuth
 * - BILLING_AUTH_USERNAME — optional; defaults to production billing admin
 * - BILLING_AUTH_PASSWORD — optional; defaults to production billing admin password
 * - BILLING_AUTH_COOKIE           — optional; AWSALB load-balancer stickiness cookie
 * - BILLING_AUTH_ACCEPT_ENCODING — optional; default gzip, deflate. Set `identity` if needed.
 * - BILLING_AUTH_USER_AGENT      — optional; default mimics Postman (some gateways differ for Node fetch).
 * - BILLING_AUTH_DISABLE_NATIVE_HTTPS — set to `1` to skip node:https fallback (default: use fallback when body empty).
 * - BILLING_AUTH_POST_BODY       — optional raw POST body (e.g. `{}`); sets Content-Type to application/json if non-empty.
 * - BILLING_AUTH_BEARER_TOKEN    — optional; if set to a raw JWT (eyJ…), skip BillingAuth HTTP (use when API returns empty body from worker but Postman works).
 */

import https from "node:https";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { URL } from "node:url";

const DEFAULT_BILLING_AUTH_URL = "https://atc-api.atcemr.com/api/BillingAuth";
const DEFAULT_BILLING_AUTH_USERNAME = "billadminprod1@atc.com";
const DEFAULT_BILLING_AUTH_PASSWORD = "kD$3A*zR4$Pn";
const DEFAULT_BILLING_AUTH_COOKIE =
  "AWSALB=JqY1hqUMFLAmK8dexE3hdnOBlfmHrJrU+V73e8PvNmpLtS4TquzF4JWu7GWL0t58uioEqQkrsEjWKajwlq03PMCUdwLD1J9VhdxF1h54bTjDt5aIzboMB9WxGeF6; AWSALBCORS=JqY1hqUMFLAmK8dexE3hdnOBlfmHrJrU+V73e8PvNmpLtS4TquzF4JWu7GWL0t58uioEqQkrsEjWKajwlq03PMCUdwLD1J9VhdxF1h54bTjDt5aIzboMB9WxGeF6; AWSALBTG=708gJ9H28TaDctgCq3GgySRJcxpDK+WkFhswfl7pcxql19Na8xbZAF6JkJ7MOkkEyMSZo6SPg81VcP9t9/5UOLnP/8axGf896xM7Oib/E0rXqv9ctpH5NRxQ7rS2ZS3iPBYuQ9yT2TQtQen2aVQzmiOf5OoP6gUWxj4uuJTRZT6f; AWSALBTGCORS=708gJ9H28TaDctgCq3GgySRJcxpDK+WkFhswfl7pcxql19Na8xbZAF6JkJ7MOkkEyMSZo6SPg81VcP9t9/5UOLnP/8axGf896xM7Oib/E0rXqv9ctpH5NRxQ7rS2ZS3iPBYuQ9yT2TQtQen2aVQzmiOf5OoP6gUWxj4uuJTRZT6f";

/** Embedded search (e.g. JSON/HTML); segments allow base64url + optional `=`, `+`, `/`. */
const JWT_EMBEDDED_RE =
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_+/=-]+\.[A-Za-z0-9_+/=-]+\b/;

/**
 * BillingAuth returns the compact JWS as the raw body (Postman "Raw"). It may include stray
 * whitespace or quotes; `extractCompactJwsFromPlainText` is strict (no internal whitespace).
 * @param {string} text
 * @returns {string}
 */
function extractJwtFromBillingAuthBody(text) {
  let s = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (!s) return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).replace(/^\uFEFF/, "").trim();
  }
  const oneLine = s.replace(/\s+/g, "");
  for (const candidate of [s, oneLine]) {
    if (!candidate.startsWith("eyJ")) continue;
    let t = extractCompactJwsFromPlainText(candidate);
    if (t) return t;
    const idx = candidate.indexOf("eyJ");
    const fromEy = idx >= 0 ? candidate.slice(idx) : candidate;
    const m = fromEy.match(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_+/=-]+\.[A-Za-z0-9_+/=-]+/);
    if (m) return m[0];
  }
  const embedded = s.match(JWT_EMBEDDED_RE);
  if (embedded) return embedded[0];
  return "";
}

/**
 * BillingAuth often returns the raw compact JWS only (no JSON). Cognito-style tokens start with
 * `eyJ` (base64url header). Match by structure: exactly two dots, three non-empty segments.
 * @param {string} raw
 * @returns {string}
 */
export function extractCompactJwsFromPlainText(raw) {
  const t = String(raw ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^["']+|["']+$/g, "");
  if (!t.startsWith("eyJ")) return "";
  if (/\s/.test(t)) return "";
  const parts = t.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return "";
  return t;
}

/**
 * Scan every response header value for a JWT (some APIs use non-standard header names).
 * @param {Response} res
 * @returns {string}
 */
function extractJwtFromAllResponseHeaders(res) {
  try {
    const h = res.headers;
    const entries = typeof h.entries === "function" ? [...h.entries()] : [];
    for (const [, value] of entries) {
      if (!value || typeof value !== "string") continue;
      const t = extractJwtFromBillingAuthBody(value);
      if (t) return t;
      const m = value.match(JWT_EMBEDDED_RE);
      if (m) return m[0];
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Some ATC stacks return the JWT on a response header instead of the body.
 * @param {Response} res
 * @returns {string}
 */
function extractJwtFromResponseHeaders(res) {
  try {
    const h = res.headers;
    const entries = typeof h.entries === "function" ? [...h.entries()] : [];
    for (const [key, value] of entries) {
      if (!value || typeof value !== "string") continue;
      const kl = key.toLowerCase();
      if (
        kl !== "authorization" &&
        !/token|jwt|bearer|auth/i.test(kl)
      ) {
        continue;
      }
      const s = value.replace(/^Bearer\s+/i, "").trim();
      let t = extractJwtFromBillingAuthBody(s);
      if (!t) t = extractCompactJwsFromPlainText(s);
      if (!t) {
        const m = s.match(JWT_EMBEDDED_RE);
        if (m) t = m[0];
      }
      if (t) return t;
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Walk JSON (or nested objects) for a JWT string.
 * @param {unknown} val
 * @param {number} depth
 * @returns {string}
 */
function deepFindJwtString(val, depth = 0) {
  if (depth > 12 || val == null) return "";
  if (typeof val === "string") {
    const plain = extractCompactJwsFromPlainText(val);
    if (plain) return plain;
    const m = val.match(JWT_EMBEDDED_RE);
    return m ? m[0] : "";
  }
  if (typeof val !== "object") return "";
  if (Array.isArray(val)) {
    for (const item of val) {
      const t = deepFindJwtString(item, depth + 1);
      if (t) return t;
    }
    return "";
  }
  const o = /** @type {Record<string, unknown>} */ (val);
  const keyCandidates = [
    "token",
    "Token",
    "accessToken",
    "access_token",
    "jwt",
    "Jwt",
    "JWT",
    "bearerToken",
    "BearerToken",
    "authToken",
    "AuthToken",
    "id_token",
    "idToken",
  ];
  for (const k of keyCandidates) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      const plain = extractCompactJwsFromPlainText(v);
      if (plain) return plain;
      const m = v.match(JWT_EMBEDDED_RE);
      if (m) return m[0];
      if (v.startsWith("eyJ") && v.includes(".")) return v.trim();
    }
  }
  for (const v of Object.values(o)) {
    const t = deepFindJwtString(v, depth + 1);
    if (t) return t;
  }
  return "";
}

/**
 * `https.request` returns raw bytes; decompress when `Content-Encoding` is set (Postman does this automatically).
 * @param {Buffer} buf
 * @param {string | string[] | undefined} contentEncoding
 * @returns {string}
 */
function decodeCompressedBody(buf, contentEncoding) {
  if (!buf || buf.length === 0) return "";
  const ce = Array.isArray(contentEncoding)
    ? contentEncoding.join(",").toLowerCase()
    : String(contentEncoding || "").toLowerCase();
  try {
    if (ce.includes("br")) return brotliDecompressSync(buf).toString("utf8");
    if (ce.includes("gzip")) return gunzipSync(buf).toString("utf8");
    if (ce.includes("deflate")) return inflateSync(buf).toString("utf8");
  } catch {
    /* ignore */
  }
  return buf.toString("utf8");
}

/**
 * @returns {Promise<
 *   | { ok: true; token: string; status: number }
 *   | { ok: false; error: string; status?: number }
 *   | { skipped: true; reason: string }
 * >}
 */
export async function fetchBillingAuthFromEnv() {
  const url = (process.env.BILLING_AUTH_URL || "").trim() || DEFAULT_BILLING_AUTH_URL;
  const username = (process.env.BILLING_AUTH_USERNAME || "").trim() || DEFAULT_BILLING_AUTH_USERNAME;
  const password = (process.env.BILLING_AUTH_PASSWORD || "").trim() || DEFAULT_BILLING_AUTH_PASSWORD;
  const cookie = (process.env.BILLING_AUTH_COOKIE || "").trim() || DEFAULT_BILLING_AUTH_COOKIE;
  const encodingFromEnv = (process.env.BILLING_AUTH_ACCEPT_ENCODING || "").trim();

  const staticBearer = (process.env.BILLING_AUTH_BEARER_TOKEN || "").trim();
  if (staticBearer) {
    const extracted =
      extractJwtFromBillingAuthBody(staticBearer) ||
      (staticBearer.match(JWT_EMBEDDED_RE)?.[0] ?? "");
    if (extracted) return { ok: true, token: extracted, status: 200 };
  }

  /** @param {Response} response */
  async function readBodyText(response) {
    try {
      const ab = await response.arrayBuffer();
      return new TextDecoder("utf-8", { fatal: false }).decode(ab);
    } catch {
      try {
        return await response.text();
      } catch {
        return "";
      }
    }
  }

  /** @param {string} text @param {Response} response */
  function parseTokenFromResponse(text, response) {
    const trimmed = String(text ?? "").replace(/^\uFEFF/, "").trim();
    let token = extractJwtFromBillingAuthBody(trimmed);
    if (!token) {
      try {
        const json = JSON.parse(text);
        token = deepFindJwtString(json);
      } catch {
        token = deepFindJwtString({ raw: text });
      }
    }
    if (!token) {
      const m = trimmed.match(JWT_EMBEDDED_RE);
      if (m) token = m[0];
    }
    if (!token) token = extractJwtFromResponseHeaders(response);
    if (!token) token = extractJwtFromAllResponseHeaders(response);
    return { token, trimmed };
  }

  const userAgent =
    (process.env.BILLING_AUTH_USER_AGENT || "").trim() ||
    "PostmanRuntime/7.43.0";

  /** @type {Record<string, string>} */
  const baseHeaders = {
    Accept: "*/*",
    Connection: "keep-alive",
    "User-Agent": userAgent,
    Username: username,
    Password: password,
    ...(cookie ? { Cookie: cookie } : {}),
  };

  /**
   * Native HTTPS (HTTP/1.1) — matches Postman/curl more closely than undici when the server
   * returns Content-Length: 0 to fetch but a JWT to other clients.
   * @param {string | undefined} acceptEncoding
   */
  function billingAuthPostNativeHttps(acceptEncoding) {
    const u = new URL(url);
    /** @type {Record<string, string>} */
    const headers = { ...baseHeaders };
    if (acceptEncoding !== undefined) {
      headers["Accept-Encoding"] = acceptEncoding;
    } else {
      delete headers["Accept-Encoding"];
    }
    const postBodyRaw = (process.env.BILLING_AUTH_POST_BODY || "").trim();
    const bodyBuf = postBodyRaw ? Buffer.from(postBodyRaw, "utf8") : Buffer.alloc(0);
    headers["Content-Length"] = String(bodyBuf.length);
    if (bodyBuf.length > 0 && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    return new Promise((resolve, reject) => {
      const opts = {
        method: "POST",
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers,
        ALPNProtocols: ["http/1.1"],
      };
      const req = https.request(opts, (incoming) => {
        const chunks = [];
        incoming.on("data", (c) => chunks.push(c));
        incoming.on("end", () => {
          const raw = Buffer.concat(chunks);
          const text = decodeCompressedBody(raw, incoming.headers["content-encoding"]);
          resolve({
            status: incoming.statusCode ?? 0,
            text,
            rawHeaders: incoming.headers,
          });
        });
      });
      req.on("error", reject);
      if (bodyBuf.length) req.write(bodyBuf);
      req.end();
    });
  }

  /** @param {{ status: number; text: string; rawHeaders: import("node:http").IncomingHttpHeaders }} native */
  function parseTokenFromNativeResult(native) {
    let tok = extractJwtFromBillingAuthBody(native.text);
    if (!tok) {
      try {
        const json = JSON.parse(native.text);
        tok = deepFindJwtString(json);
      } catch {
        tok = deepFindJwtString({ raw: native.text });
      }
    }
    if (!tok) {
      const m = native.text.match(JWT_EMBEDDED_RE);
      if (m) tok = m[0];
    }
    if (!tok && native.rawHeaders) {
      for (const v of Object.values(native.rawHeaders)) {
        const s = Array.isArray(v) ? v.join(" ") : String(v ?? "");
        const t = extractJwtFromBillingAuthBody(s);
        if (t) {
          tok = t;
          break;
        }
        const m = s.match(JWT_EMBEDDED_RE);
        if (m) {
          tok = m[0];
          break;
        }
      }
    }
    return tok;
  }

  /**
   * @param {string | undefined} acceptEncoding  pass undefined to omit header (uncompressed response)
   */
  async function doAuthFetch(acceptEncoding) {
    /** @type {Record<string, string>} */
    const headers = { ...baseHeaders };
    if (acceptEncoding !== undefined) {
      headers["Accept-Encoding"] = acceptEncoding;
    }
    const postBodyRaw = (process.env.BILLING_AUTH_POST_BODY || "").trim();
    if (postBodyRaw) {
      return fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: postBodyRaw,
      });
    }
    return fetch(url, { method: "POST", headers });
  }

  const skipNative = (process.env.BILLING_AUTH_DISABLE_NATIVE_HTTPS || "").trim() === "1";
  let nativeAttemptLog = "";

  // 1) node:https first — HTTP/1.1 + manual gzip/br deflate (Postman decompresses automatically).
  if (!skipNative) {
    const order = /** @type {(string | undefined)[]} */ ([
      undefined,
      "gzip, deflate",
      "gzip, deflate, br",
    ]);
    if (
      encodingFromEnv &&
      encodingFromEnv !== "gzip, deflate" &&
      encodingFromEnv !== "gzip, deflate, br"
    ) {
      order.splice(1, 0, encodingFromEnv);
    }
    const seen = new Set();
    for (const enc of order) {
      const key = enc === undefined ? "__none__" : enc;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const native = await billingAuthPostNativeHttps(enc);
        nativeAttemptLog += `;native[${key}]=${native.status}/${native.text.length}b`;
        const t = parseTokenFromNativeResult(native);
        if (t) return { ok: true, token: t, status: native.status };
        if (native.status < 200 || native.status >= 300) {
          return {
            ok: false,
            error: `BillingAuth native HTTPS HTTP ${native.status}: ${native.text.slice(0, 800)}${nativeAttemptLog}`,
            status: native.status,
          };
        }
      } catch (err) {
        nativeAttemptLog += `;nativeErr=${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // 2) global fetch (undici) as fallback
  let res;
  try {
    res = await doAuthFetch(encodingFromEnv || "gzip, deflate");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${message}${nativeAttemptLog}` };
  }

  let text = await readBodyText(res);
  let { token } = parseTokenFromResponse(text, res);

  if (!token && res.ok && text.length === 0) {
    try {
      const res2 = await doAuthFetch(undefined);
      const text2 = await readBodyText(res2);
      const second = parseTokenFromResponse(text2, res2);
      if (second.token) {
        return { ok: true, token: second.token, status: res2.status };
      }
      if (!res2.ok) {
        return {
          ok: false,
          error: `BillingAuth HTTP ${res2.status} (retry): ${text2.slice(0, 800)}${nativeAttemptLog}`,
          status: res2.status,
        };
      }
      res = res2;
      text = text2;
      token = second.token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `BillingAuth retry failed: ${message}${nativeAttemptLog}` };
    }
  }

  const status = res.status;

  if (!res.ok) {
    return {
      ok: false,
      error: `HTTP ${status}: ${text.slice(0, 800)}`,
      status,
    };
  }

  if (!token) {
    const ce = res.headers.get("content-encoding") ?? "";
    const cl = res.headers.get("content-length") ?? "";
    const ct = res.headers.get("content-type") ?? "";
    /** @type {string[]} */
    const headerKeys = [];
    try {
      res.headers.forEach((_v, k) => headerKeys.push(k));
    } catch {
      /* ignore */
    }
    headerKeys.sort();
    return {
      ok: false,
      error: `BillingAuth HTTP ${status} OK but no JWT found. bodyLen=${text.length} content-type=${ct} content-encoding=${ce} content-length=${cl} responseHeaderKeys=${headerKeys.join("|")} bodyPreview=${JSON.stringify(text.slice(0, 120))} attempts=${nativeAttemptLog || "(no native)"}. cookieLen=${cookie.length}. Set BILLING_AUTH_BEARER_TOKEN=eyJ… from Postman to bypass HTTP, or paste fresh Cookie from Postman into BILLING_AUTH_COOKIE.`,
      status,
    };
  }

  return { ok: true, token, status };
}
