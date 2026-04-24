/**
 * Talbot LookupData APIs — Bearer JWT from BillingAuth.
 *
 * Env:
 * - BILLING_API_BASE_URL — optional; default derived from BILLING_AUTH_URL or Talbot dev `/api`
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const DEFAULT_BILLING_AUTH_URL =
  "https://talbot-dev-dc-codeupgrade-api10.atcemr.com/api/BillingAuth";

/**
 * @returns {string}
 */
export function resolveBillingApiBase() {
  const explicit = (process.env.BILLING_API_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const authUrl = (process.env.BILLING_AUTH_URL || "").trim() || DEFAULT_BILLING_AUTH_URL;
  const stripped = authUrl.replace(/\/BillingAuth\/?$/i, "").replace(/\/$/, "");
  return stripped || "https://talbot-dev-dc-codeupgrade-api10.atcemr.com/api";
}

/**
 * @param {string} pathSuffix e.g. LookupData/TaskCategories
 * @param {string} token JWT
 * @param {RequestInit} [init]
 * @returns {Promise<{ ok: true; data: unknown } | { ok: false; error: string; status?: number }>}
 */
export async function fetchBillingLookupJson(pathSuffix, token, init = {}) {
  const base = resolveBillingApiBase();
  const path = String(pathSuffix ?? "").replace(/^\/+/, "");
  const url = `${base}/${path}`;
  const jwt = String(token ?? "").trim();
  if (!jwt) {
    return { ok: false, error: "Missing billing JWT" };
  }

  const initHeaders =
    init.headers != null &&
    typeof init.headers === "object" &&
    !(init.headers instanceof Headers) &&
    !Array.isArray(init.headers)
      ? /** @type {Record<string, string>} */ ({ ...init.headers })
      : {};

  /** @type {RequestInit} */
  const merged = {
    method: "GET",
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${jwt}`,
      ...initHeaders,
    },
  };

  let res;
  try {
    res = await fetch(url, merged);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const status = res.status;
  const text = await res.text().catch(() => "");

  if (!res.ok) {
    return {
      ok: false,
      error: `HTTP ${status}: ${text.slice(0, 800)}`,
      status,
    };
  }

  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return { ok: true, data: null };
  }

  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    return {
      ok: false,
      error: `HTTP ${status} OK but response is not JSON. First 400 chars: ${trimmed.slice(0, 400)}`,
      status,
    };
  }
}

/**
 * @param {string} token
 * @returns {Promise<{
 *   taskCategories: { ok: true; data: unknown } | { ok: false; error: string; status?: number };
 *   priorities: { ok: true; data: unknown } | { ok: false; error: string; status?: number };
 * }>}
 */
export async function fetchBillingLookupDataWithToken(token) {
  const [taskCategories, priorities] = await Promise.all([
    fetchBillingLookupJson("LookupData/TaskCategories", token),
    fetchBillingLookupJson("LookupData/Priorities", token, {
      headers: { "Content-Type": "application/json" },
    }),
  ]);
  return { taskCategories, priorities };
}

/**
 * POST multipart/form-data dto JSON to NonEncounterTask/Add.
 *
 * @param {string} token
 * @param {unknown} dto
 * @param {{ filePaths?: string[] }} [options]
 * @returns {Promise<{ ok: true; data: unknown } | { ok: false; error: string; status?: number }>}
 */
export async function addNonEncounterTaskWithToken(token, dto, options = {}) {
  const base = resolveBillingApiBase();
  const url = `${base}/NonEncounterTask/Add`;
  const jwt = String(token ?? "").trim();
  if (!jwt) return { ok: false, error: "Missing billing JWT" };

  const filePaths = Array.isArray(options.filePaths)
    ? options.filePaths.map((p) => String(p ?? "").trim()).filter(Boolean)
    : [];

  // Node 18+ has FormData/Blob globals; this project already uses fetch.
  const form = new FormData();
  form.append("dto", typeof dto === "string" ? dto : JSON.stringify(dto));

  for (const fp of filePaths) {
    try {
      const buf = await readFile(fp);
      const name = basename(fp) || "screenshot.png";
      const blob = new Blob([buf], { type: "image/png" });
      form.append("files", blob, name);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Cannot read screenshot for upload: ${fp}: ${message}` };
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
      body: form,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const status = res.status;
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, error: `HTTP ${status}: ${text.slice(0, 800)}`, status };
  }

  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(trimmed) };
  } catch {
    return { ok: true, data: trimmed };
  }
}
