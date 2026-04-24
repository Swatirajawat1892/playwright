/**
 * BillingAuth API — POST with Username/Password headers; returns JWT for downstream calls.
 * Shared by Temporal activity / OHID run (same env as worker).
 *
 * Env:
 * - BILLING_AUTH_URL — optional; default Talbot dev BillingAuth
 * - BILLING_AUTH_USERNAME — required (except explicit skip)
 * - BILLING_AUTH_PASSWORD — required
 */

const DEFAULT_BILLING_AUTH_URL =
  "https://talbot-dev-dc-codeupgrade-api10.atcemr.com/api/BillingAuth";

/** Embedded search (e.g. JSON/HTML); segments allow base64url + optional `=`, `+`, `/`. */
const JWT_EMBEDDED_RE =
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_+/=-]+\.[A-Za-z0-9_+/=-]+\b/;

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
 * @returns {Promise<
 *   | { ok: true; token: string; status: number }
 *   | { ok: false; error: string; status?: number }
 *   | { skipped: true; reason: string }
 * >}
 */
export async function fetchBillingAuthFromEnv() {
  const url = (process.env.BILLING_AUTH_URL || "").trim() || DEFAULT_BILLING_AUTH_URL;
  const username = (process.env.BILLING_AUTH_USERNAME || "").trim();
  const password = (process.env.BILLING_AUTH_PASSWORD || "").trim();

  if (!username || !password) {
    return {
      skipped: true,
      reason: "Set BILLING_AUTH_USERNAME and BILLING_AUTH_PASSWORD on the worker process (e.g. in .env loaded by npm run start:app).",
    };
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        Username: username,
        Password: password,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const status = res.status;
  const text = await res.text().catch(() => "");

  let token = "";
  const trimmed = text.replace(/^\uFEFF/, "").trim();

  // 1) Raw body is exactly a compact JWS (your BillingAuth case).
  token = extractCompactJwsFromPlainText(trimmed);
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

  if (!res.ok) {
    return {
      ok: false,
      error: `HTTP ${status}: ${text.slice(0, 800)}`,
      status,
    };
  }

  if (!token) {
    return {
      ok: false,
      error: `BillingAuth HTTP ${status} OK but no JWT found in body. First 500 chars: ${text.slice(0, 500)}`,
      status,
    };
  }

  return { ok: true, token, status };
}
