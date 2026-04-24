/**
 * Ohio OHID login — https://auth.ohid.ohio.gov/login
 * Credentials: OHID_USERNAME / OHID_PASSWORD in .env (never commit .env).
 *
 * US VPN / egress:
 * - By default we DO NOT wait for a US IP — OHID opens immediately.
 * - Option A (your real Chrome + extensions): close all Chrome → `npm run chrome:cdp` → set OHID_CDP_PORT=9222 in .env → `npm run login:ohid`.
 *   Playwright attaches via CDP (OHID_CDP_URL / OHID_CDP_PORT) — not the bundled empty profile.
 * - System VPN: use OHID_PROXY or OS-level VPN with bundled Chromium.
 * - Set OHID_WAIT_FOR_US_IP=true to enable the US check.
 * - CDP: we avoid opening extra tabs (reduces VPN/extension tabs like 0.0.0.2 / data:). Noise tabs are closed unless OHID_CLOSE_JUNK_TABS=false.
 * - After login: optionally open Provider Network Management + Terms checkbox (OHID_OPEN_PNM=true, default).
 * - My Apps list: OHID_MY_APPS_SCROLL_STEPS / OHID_MY_APPS_SCROLL_PAUSE_MS (defaults tuned for speed; raise if the list is long or slow).
 * - PNM tile: if strict locators miss the row, a relaxed pass walks from the title text to an ancestor that contains Open (set OHID_PNM_RELAXED=false to disable).
 * - Optional OHID_PNM_SUBTITLE overrides the default subtitle regex (default matches “OMES PNM Module” on the Ohio card).
 * - Last-resort OHID_PNM_OPEN_NTH (default 1): index of the “Open” button under the “Other apps” heading (0 = first app, 1 = second — Provider Network Management when Career Navigator is first).
 * - MFA / email OTP (initial login): Temporal sets OHID_WORKFLOW_RUN_ID; n8n sends code to POST /ingest-otp; script polls data/otps. Set OHID_OTP_FROM_API=false to skip.
 * - PNM /Account/Login.aspx: if Maximus shows "Log in with OH|ID", we click it before terms/MFA. Tune wait with OHID_PNM_SSO_BUTTON_MS (default 25000).
 * - PNM two-step verification: if OHID shows "Choose a method" after clicking Open, script clicks Send code, then waits for POST /ingest-otp. Requires OHID_WORKFLOW_RUN_ID or OHID_OTP_WORKFLOW_ID.
 *   OHID_MFA_METHOD=email (default) or sms | OHID_PNM_MFA_CHOOSE_MS (default 8000, how long to wait for that page).
 * - Provider details: expand Self Service via #spanSelfServiceIcon; open Recipient Eligibility via id ending _lnkRecipientEligibilityMITS (falls back to role/link text).
 * - Search Eligibility (SearchEligibility.aspx): optional `medicateSearch` from POST /medicate-availability-check → env OHID_MEDICATE_SEARCH_JSON — scrolls, expands ELIGIBILITY SEARCH if needed, fills billing + DOB + From/To DOS, clicks Search.
 * - After medicate Search Eligibility (`OHID_MEDICATE_SEARCH_JSON`, with PNM path on): by default the script **ends** right after data scrape + stdout/artifact (`OHID_STOP_AFTER_ELIGIBILITY` defaults true). Set `OHID_STOP_AFTER_ELIGIBILITY=false` to keep post-login `OHID_STAY_MS` / `DASHBOARD_STAY_MS` tail (ATC automation was removed).
 * - Session file (`.ohid-session.json`): **ATC / atcemr.com** cookies and origins are **removed** on load and save so the browser does not resurrect `atc.atcemr.com` from an old session. CDP mode still uses your full Chrome profile — close ATC tabs there manually if needed.
 * - Speed tuning (optional ms / counts): OHID_GOTO_MS, OHID_NETWORK_IDLE_MS (post-login only), LOGIN_WAIT_MS,
 *   OHID_MY_APPS_LOAD_MS (0 = skip `load` wait on My Apps), OHID_MY_APPS_SECTION_MS, OHID_MY_APPS_NO_SCROLL_POLL_MS, OHID_MY_APPS_SCROLL_*,
 *   OHID_PNM_NAV_RACE_MS, OHID_TERMS_* , OHID_STAY_MS_DEFAULT (override stay with OHID_STAY_MS).
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "playwright";
// ✅ NEW CHANGE
import { reportSearchEligibilityPageData } from "./managed-care-plan-match.js";
import { handleOhidOtpFromStoreIfNeeded } from "./ohid/otp-api.js";
import { clickPnmLoginWithOhidIfPresent } from "./ohid/pnm-gateway.js";
import { handlePnmMfaIfPresent } from "./ohid/pnm-mfa.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const OHID_LOGIN_URL =
  process.env.OHID_LOGIN_URL?.trim() || "https://auth.ohid.ohio.gov/login";

const OHID_MY_APPS_URL =
  process.env.OHID_MY_APPS_URL?.trim() || "https://ohid.ohio.gov/manage-account/my-apps";

function nowStamp(): string {
  // Filesystem-safe timestamp.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ohidRunIdFromEnv(): string {
  const rid = (process.env.OHID_WORKFLOW_RUN_ID ?? "").trim();
  return rid && /^[a-zA-Z0-9._-]+$/.test(rid) ? rid : "manual";
}

function searchEligibilityScreenshotPath(): string {
  const base = (process.env.OHID_SCREENSHOT_DIR ?? "").trim() || join(PROJECT_ROOT, "data", "ohid-screenshots");
  const dir = isAbsolute(base) ? base : join(PROJECT_ROOT, base);
  return join(dir, `search-eligibility-${ohidRunIdFromEnv()}-${nowStamp()}.png`);
}

function tabsOverviewScreenshotPath(): string {
  const base = (process.env.OHID_SCREENSHOT_DIR ?? "").trim() || join(PROJECT_ROOT, "data", "ohid-screenshots");
  const dir = isAbsolute(base) ? base : join(PROJECT_ROOT, base);
  return join(dir, `tabs-overview-${ohidRunIdFromEnv()}-${nowStamp()}.png`);
}

async function captureTabsOverviewScreenshot(context: BrowserContext): Promise<string | null> {
  try {
    const pages = context.pages().filter((p) => !p.isClosed());
    const rows: Array<{ title: string; url: string; dataUrl?: string }> = [];

    for (const p of pages) {
      let url = "";
      let title = "";
      try {
        url = p.url();
        title = (await p.title().catch(() => "")) || "";
      } catch {
        /* ignore */
      }

      const u = (url || "").trim();
      if (!u || u === "about:blank") continue;
      if (u.startsWith("chrome://") || u.startsWith("devtools://") || u.startsWith("chrome-error://")) continue;

      const buf = await p.screenshot({ fullPage: false }).catch(() => null);
      const dataUrl =
        buf && Buffer.isBuffer(buf) ? `data:image/png;base64,${buf.toString("base64")}` : undefined;
      rows.push({ title: title || "(untitled)", url: u, ...(dataUrl ? { dataUrl } : {}) });
    }

    const overview = await context.newPage();
    const escapeHtml = (s: string) =>
      s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const itemsHtml =
      rows.length === 0
        ? `<p style="color:#555">No tabs captured.</p>`
        : rows
            .map((r, i) => {
              const thumb = r.dataUrl
                ? `<img src="${r.dataUrl}" style="width:100%;max-width:900px;border:1px solid #ddd;border-radius:8px" />`
                : `<div style="width:100%;max-width:900px;border:1px dashed #bbb;border-radius:8px;padding:12px;color:#666">Thumbnail unavailable</div>`;
              return `
                <div style="padding:14px 0;border-top:1px solid #eee">
                  <div style="font-weight:700;margin-bottom:6px">${i + 1}. ${escapeHtml(r.title)}</div>
                  <div style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size:12px; color:#333; word-break:break-all; margin-bottom:10px">
                    ${escapeHtml(r.url)}
                  </div>
                  ${thumb}
                </div>
              `;
            })
            .join("\n");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tabs overview</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 18px; }
    h1 { font-size: 18px; margin: 0 0 6px; }
    .meta { color:#555; font-size: 12px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Tabs overview</h1>
  <div class="meta">runId: ${escapeHtml(ohidRunIdFromEnv())} • captured: ${escapeHtml(new Date().toISOString())}</div>
  ${itemsHtml}
</body>
</html>`;

    await overview.setContent(html, { waitUntil: "domcontentloaded" });
    const p = tabsOverviewScreenshotPath();
    await mkdir(dirname(p), { recursive: true });
    await overview.screenshot({ path: p, fullPage: true }).catch(() => undefined);
    await overview.close().catch(() => undefined);
    return p;
  } catch {
    return null;
  }
}

/** Non-negative ms from env, or fallback (fast defaults; increase via .env on slow networks). */
function envMs(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (v === undefined || v === "") {
    return fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envSteps(name: string, fallback: number): number {
  return Math.max(0, Math.floor(envMs(name, fallback)));
}

/** Central timeouts — defaults are tight (~≤30s per wait unless noted). */
const OH = {
  goto: envMs("OHID_GOTO_MS", 45_000),
  /** After login redirect; My Apps uses `load` instead of `networkidle` (SPA rarely idles). */
  networkIdle: envMs("OHID_NETWORK_IDLE_MS", 12_000),
  /** Optional cap on `load` after My Apps (SPAs often delay `load`; leave 0 to skip). */
  myAppsLoad: envMs("OHID_MY_APPS_LOAD_MS", 0),
  /** Max wait for the PNM list row (OMES subtitle) to paint — target ~1–2s on a warm session. */
  myAppsSection: envMs("OHID_MY_APPS_SECTION_MS", 8_000),
  /** Poll for PNM row without scrolling (covers late React paint). */
  myAppsNoScrollPoll: envMs("OHID_MY_APPS_NO_SCROLL_POLL_MS", 2_000),
  loginWait: envMs("LOGIN_WAIT_MS", 45_000),
  fillAction: envMs("OHID_FILL_ACTION_MS", 5_000),
  scrollSteps: envSteps("OHID_MY_APPS_SCROLL_STEPS", 18),
  scrollPause: envMs("OHID_MY_APPS_SCROLL_PAUSE_MS", 60),
  scrollEndPause: envMs("OHID_MY_APPS_END_PAUSE_MS", 200),
  scrollRetryPause: envMs("OHID_MY_APPS_RETRY_PAUSE_MS", 250),
  /** Pixel delta for last inner scroll on My Apps (not milliseconds). */
  scrollFinalInner: envMs("OHID_MY_APPS_FINAL_SCROLL_DELTA", 600),
  pnmRowVisible: envMs("OHID_PNM_ROW_VISIBLE_MS", 8_000),
  pnmOpenBtn: envMs("OHID_PNM_OPEN_BTN_MS", 12_000),
  pnmOpenLink: envMs("OHID_PNM_OPEN_LINK_MS", 6_000),
  pnmClick: envMs("OHID_PNM_CLICK_MS", 12_000),
  pnmClickForce: envMs("OHID_PNM_CLICK_FORCE_MS", 15_000),
  pnmNavRace: envMs("OHID_PNM_NAV_RACE_MS", 30_000),
  pnmLoad: envMs("OHID_PNM_LOAD_MS", 25_000),
  pnmLoadShort: envMs("OHID_PNM_LOAD_SHORT_MS", 15_000),
  /** PNM terms checkbox can appear late (redirects, MFA, slow ASP.NET). */
  termsVisible: envMs("OHID_TERMS_VISIBLE_MS", 90_000),
  termsClick: envMs("OHID_TERMS_CLICK_MS", 30_000),
  termsLoad: envMs("OHID_TERMS_LOAD_MS", 35_000),
  regIdClick: envMs("OHID_REG_ID_CLICK_MS", 45_000),
  regIdNav: envMs("OHID_REG_ID_NAV_MS", 25_000),
  selfServiceExpand: envMs("OHID_SELF_SERVICE_EXPAND_MS", 12_000),
  recipientEligibilityClick: envMs("OHID_RECIPIENT_ELIGIBILITY_CLICK_MS", 12_000),
  recipientEligibilityNav: envMs("OHID_RECIPIENT_ELIGIBILITY_NAV_MS", 25_000),
  /** Wait for SearchEligibility.aspx after Recipient Eligibility navigation. */
  medicatePageWait: envMs("OHID_MEDICATE_PAGE_WAIT_MS", 90_000),
  /** Per-field timeout on Search Eligibility form. */
  medicateField: envMs("OHID_MEDICATE_FIELD_MS", 45_000),
  /** After clicking Search. */
  medicateAfterSearch: envMs("OHID_MEDICATE_AFTER_SEARCH_MS", 45_000),
  /** Stay on Search Eligibility results before exit (default 30s). */
  medicateHoldAfterSearch: envMs("OHID_MEDICATE_HOLD_AFTER_SEARCH_MS", 30_000),
  /** Wait for MFA/OTP input to appear after password submit (initial login). */
  otpFieldWait: envMs("OHID_OTP_FIELD_WAIT_MS", 45_000),
  /** Max time to receive OTP via POST /ingest-otp (file poll). */
  otpWait: envMs("OHID_OTP_WAIT_MS", 300_000),
  otpPoll: envMs("OHID_OTP_FILE_POLL_MS", 2_000),
  /** How long to wait for the PNM "Choose a method" MFA page to appear after clicking Open.
   *  Keep short — if MFA is not required the script moves on immediately after this. */
  pnmMfaChoose: envMs("OHID_PNM_MFA_CHOOSE_MS", 8_000),
  /** PNM /Account/Login.aspx — wait for "Log in with OH|ID" before clicking. */
  pnmSsoButton: envMs("OHID_PNM_SSO_BUTTON_MS", 25_000),
} as const;

const DEFAULT_POST_LOGIN_STAY_MS = envMs("OHID_STAY_MS_DEFAULT", 30_000);

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(`Missing ${name}. Add it to .env (see OHID_USERNAME / OHID_PASSWORD).`);
  }
  return v;
}
 
function sessionPath(): string {
  const p = process.env.OHID_SESSION_PATH?.trim();
  if (!p) return join(PROJECT_ROOT, ".ohid-session.json");
  return isAbsolute(p) ? p : join(PROJECT_ROOT, p);
}

type JsonStorageState = {
  cookies?: Array<{ domain?: string; [key: string]: unknown }>;
  origins?: Array<{ origin?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/** ATC (atc.atcemr.com) was removed from automation; strip its cookies so Chromium does not reopen that site. */
function stripAtcEmrFromStorageState(state: JsonStorageState): JsonStorageState {
  const cookies = (state.cookies ?? []).filter((c) => !/atcemr/i.test(String(c.domain ?? "")));
  const origins = (state.origins ?? []).filter((o) => !/atcemr/i.test(String(o.origin ?? "")));
  return { ...state, cookies, origins };
}

async function closeAtcTabsIfAny(context: BrowserContext): Promise<void> {
  for (const p of [...context.pages()]) {
    try {
      const h = new URL(p.url()).hostname;
      if (/atcemr/i.test(h)) {
        console.log("[OHID] Closing leftover ATC tab:", p.url());
        await p.close().catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Playwright does not bundle a VPN. Use either OS-level US VPN, or an explicit proxy
 * (many VPN apps offer localhost HTTP/SOCKS when connected to a US server).
 */
function proxyFromEnv(): BrowserContextOptions["proxy"] | undefined {
  const raw =
    process.env.OHID_PROXY?.trim() ||
    process.env.PLAYWRIGHT_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim();
  if (!raw) return undefined;
  const server = /:\/\//.test(raw) ? raw : `http://${raw}`;
  const username = process.env.PLAYWRIGHT_PROXY_USERNAME?.trim();
  const password = process.env.PLAYWRIGHT_PROXY_PASSWORD?.trim();
  if (username !== undefined && username !== "" && password !== undefined) {
    return { server, username, password };
  }
  return { server };
}

/**
 * Attach to Chrome with remote debugging (your profile + extensions).
 * Prefer: npm run chrome:cdp   (see scripts/start-chrome-cdp.ps1)
 */
function cdpEndpointFromEnv(): string | undefined {
  const explicit = process.env.OHID_CDP_URL?.trim() || process.env.PLAYWRIGHT_CDP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const port = process.env.OHID_CDP_PORT?.trim();
  if (port && /^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  return undefined;
}

function postLoginStayMs(): number {
  const raw = process.env.DASHBOARD_STAY_MS ?? process.env.OHID_STAY_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_POST_LOGIN_STAY_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("DASHBOARD_STAY_MS / OHID_STAY_MS must be a non-negative number (ms).");
  }
  return n;
}

async function fillAndSubmit(page: Page): Promise<void> {
  const user = requireEnv("OHID_USERNAME");
  const password = requireEnv("OHID_PASSWORD");

  const tryFill = async (label: string, actions: Array<() => Promise<void>>) => {
    let lastErr: unknown;
    for (const act of actions) {
      try {
        await act();
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `${label} not found. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  };

  await tryFill("Username field", [
    async () => page.getByRole("textbox", { name: /OHID\s*Username/i }).fill(user, { timeout: OH.fillAction }),
    async () => page.getByLabel(/OHID\s*Username/i).fill(user, { timeout: OH.fillAction }),
    async () => page.getByLabel(/username/i).fill(user, { timeout: OH.fillAction }),
    async () =>
      page
        .locator(
          'input[type="text"], input[type="email"], input[name*="user" i], input[id*="user" i], input[autocomplete="username"]',
        )
        .first()
        .fill(user, { timeout: OH.fillAction }),
  ]);

  await tryFill("Password field", [
    async () => page.getByLabel(/^Password$/i).fill(password, { timeout: OH.fillAction }),
    async () => page.getByLabel(/password/i).fill(password, { timeout: OH.fillAction }),
    async () =>
      page
        .locator(
          'input[type="password"], input[name*="pass" i], input[id*="pass" i], input[autocomplete="current-password"]',
        )
        .first()
        .fill(password, { timeout: OH.fillAction }),
  ]);

  await tryFill("Log in button", [
    async () => page.getByRole("button", { name: /^Log in$/i }).first().click({ timeout: OH.fillAction }),
    async () => page.getByRole("button", { name: /log\s*in/i }).first().click({ timeout: OH.fillAction }),
    async () => page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: OH.fillAction }),
  ]);
}

type IpWhoPayload = { success?: boolean; country_code?: string };

/** Extension VPN: fetch runs in this tab (no extra tab). Caller then navigates to OHID on the same page. */
async function getCountryCodeViaPage(page: Page): Promise<string | undefined> {
  try {
    await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 10_000 });
    const data = await page.evaluate(async () => {
      const r = await fetch("https://ipwho.is/", { method: "GET" });
      if (!r.ok) return null;
      return r.json() as Promise<IpWhoPayload>;
    });
    if (data && data.success !== false && data.country_code) {
      return data.country_code;
    }
  } catch {
    /* retry outer loop */
  }
  return undefined;
}

function isBadChromeTab(url: string): boolean {
  const u = url || "";
  return (
    u.startsWith("devtools://") ||
    u.includes("chrome-devtools://") ||
    u.startsWith("chrome-error://") ||
    u.startsWith("chrome://crash") ||
    u.startsWith("chrome://network-error")
  );
}

/** VPN/extensions sometimes open these; we navigate away or close (not “real” destinations). */
function isExtensionNoiseUrl(url: string): boolean {
  const u = (url || "").trim();
  if (u.startsWith("data:")) return true;
  if (/0\.0\.0\.2/i.test(u)) return true;
  try {
    const h = new URL(u).hostname;
    if (h === "0.0.0.2" || h === "0.0.0.0") return true;
  } catch {
    /* ignore */
  }
  return false;
}

function shouldCloseOptionalTab(url: string): boolean {
  return isBadChromeTab(url) || isExtensionNoiseUrl(url);
}

function tabReuseScore(url: string): number {
  const u = url || "";
  if (isBadChromeTab(u)) return -100;
  if (isExtensionNoiseUrl(u)) return -80;
  if (u === "about:blank" || u.startsWith("chrome://new-tab-page") || u.startsWith("chrome://newtab")) return 10;
  if (u.startsWith("https://") || u.startsWith("http://")) return 5;
  return 0;
}

/**
 * CDP: reuse ONE existing tab and navigate it to OHID. Avoids `newPage()` when possible —
 * new tabs often trigger VPN/extensions to open http://0.0.0.2/ and data: tabs.
 * Uses pages from ALL contexts. Only calls newPage() if there are zero pages.
 */
async function acquirePageForOhid(browser: Browser, cdpMode: boolean): Promise<{ page: Page; context: BrowserContext }> {
  if (!cdpMode) {
    const ctx = browser.contexts()[0];
    if (!ctx) {
      throw new Error("No browser context.");
    }
    console.log("[Playwright] Opening one tab for OHID.");
    const page = await ctx.newPage();
    return { page, context: ctx };
  }

  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());

  if (pages.length === 0) {
    const ctx = contexts[0]!;
    console.log("[CDP] No tabs open — opening one tab for OHID.");
    const page = await ctx.newPage();
    return { page, context: ctx };
  }

  const sorted = [...pages].sort((a, b) => tabReuseScore(b.url()) - tabReuseScore(a.url()));
  const best = sorted[0]!;
  await best.bringToFront().catch(() => undefined);
  const ctx = best.context();
  const u = best.url();
  console.log(
    "[CDP] Using one existing tab (no newPage — avoids extension spam tabs):",
    u.slice(0, 120) || "about:blank",
  );
  return { page: best, context: ctx };
}

/** Close noise tabs (0.0.0.2, data:, chrome-error) so only the OHID tab remains. Set OHID_CLOSE_JUNK_TABS=false to skip. */
async function closeNoiseTabsExcept(browser: Browser, keep: Page): Promise<void> {
  if (process.env.OHID_CLOSE_JUNK_TABS === "false") return;

  const all = browser.contexts().flatMap((c) => c.pages());
  for (const p of all) {
    if (p === keep) continue;
    const u = p.url();
    if (shouldCloseOptionalTab(u)) {
      await p.close().catch(() => undefined);
      console.log("[CDP] Closed noise tab:", u.slice(0, 96));
    }
  }
}

/**
 * Bundled Chromium: uses context.request (respects OHID_PROXY).
 * CDP-attached browser: uses in-page fetch so browser VPN extensions apply.
 */
async function waitForUsEgressThenProceed(
  context: BrowserContext,
  useInPageIpCheck: boolean,
  pageForExtensionCheck: Page | undefined,
): Promise<void> {
  if (process.env.OHID_WAIT_FOR_US_IP !== "true") {
    console.log("[VPN] OHID_WAIT_FOR_US_IP!=true — skipping US check, opening login URL.");
    return;
  }

  const pollMs = Number(process.env.OHID_US_POLL_MS ?? "5000");
  const maxWaitMs = Number(process.env.OHID_US_WAIT_MS ?? String(15 * 60 * 1000));
  const start = Date.now();

  console.log(
    useInPageIpCheck
      ? "[VPN] Waiting for US IP using your open browser (extension VPN applies). Connect USA in that browser if needed."
      : "[VPN] Waiting for a United States IP (same path as Playwright’s Chromium). Connect a USA VPN — OHID opens only after US is detected.",
  );

  while (Date.now() - start < maxWaitMs) {
    let code: string | undefined;
    try {
      if (useInPageIpCheck) {
        if (!pageForExtensionCheck) {
          throw new Error("Internal: page required for extension IP check");
        }
        code = await getCountryCodeViaPage(pageForExtensionCheck);
      } else {
        const res = await context.request.get("https://ipwho.is/", {
          timeout: 25_000,
          failOnStatusCode: false,
        });
        if (res.ok()) {
          const data = (await res.json()) as IpWhoPayload;
          if (data.success !== false && data.country_code) {
            code = data.country_code;
          }
        }
      }
    } catch {
      // retry
    }

    if (code === "US") {
      console.log("[VPN] US IP confirmed — opening OHID login page.");
      return;
    }

    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    const hint = code ? `Current: ${code}.` : "Could not read location yet.";
    console.log(
      `[VPN] ${hint} Waiting for US… (${elapsedSec}s / max ${Math.floor(maxWaitMs / 1000)}s)`,
    );
    await new Promise<void>((r) => {
      setTimeout(r, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 5000);
    });
  }

  throw new Error(
    `Timed out waiting for US IP (${maxWaitMs}ms). Connect to a USA VPN, or set OHID_WAIT_FOR_US_IP=false to skip this check.`,
  );
}
    
async function waitPastLoginPage(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      try {
        const u = new URL(window.location.href);
        return u.pathname !== "/login" || !/auth\.ohid\.ohio\.gov/i.test(u.hostname);
      } catch {
        return false;
      }
    },
    { timeout: timeoutMs },
  );
}

function shouldOpenProviderNetworkAfterLogin(): boolean {
  return process.env.OHID_OPEN_PNM !== "false";
}

/**
 * When `OHID_MEDICATE_SEARCH_JSON` is set, eligibility data is emitted inside `fillSearchEligibilityIfConfigured`.
 * Default: stop the run after that (session snapshot only) — no post-login stay in `main`.
 * Set `OHID_STOP_AFTER_ELIGIBILITY=false` for the previous long-running tail behavior.
 */
function shouldStopAfterSearchEligibility(): boolean {
  const hasMedicate = !!(process.env.OHID_MEDICATE_SEARCH_JSON?.trim());
  if (!hasMedicate) return false;
  // Search Eligibility fill/scrape only runs inside `openProviderNetworkAndAcceptTerms`.
  if (!shouldOpenProviderNetworkAfterLogin()) return false;
  return (process.env.OHID_STOP_AFTER_ELIGIBILITY ?? "true").trim().toLowerCase() !== "false";
}

/** My Apps often scrolls inside a div, not `window` — move the main scrollable region. */
async function scrollMyAppsInner(page: Page, deltaY: number): Promise<void> {
  const dy = Math.max(120, Math.min(900, deltaY));
  await page.evaluate((d: number) => {
    const scrollables: HTMLElement[] = [];
    const se = document.scrollingElement;
    if (se instanceof HTMLElement && se.scrollHeight > se.clientHeight + 8) {
      scrollables.push(se);
    }
    const stack: Element[] = [document.body];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node instanceof HTMLElement) {
        const st = getComputedStyle(node);
        const oy = st.overflowY;
        if ((oy === "auto" || oy === "scroll" || oy === "overlay") && node.scrollHeight > node.clientHeight + 8) {
          scrollables.push(node);
        }
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]!);
      }
    }

    let best: HTMLElement | null = null;
    let bestRoom = 0;
    for (const el of scrollables) {
      const room = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (room > bestRoom) {
        bestRoom = room;
        best = el;
      }
    }
    if (best && bestRoom > 4) {
      best.scrollTop = Math.min(best.scrollTop + d, best.scrollHeight - best.clientHeight);
      return;
    }
    window.scrollBy(0, d);
  }, dy);
}

/** Link/button Open, plus generic controls (some tiles use non-standard markup). */
function openControlLocator(page: Page): Locator {
  return page
    .getByRole("link", { name: /^Open$/i })
    .or(page.getByRole("button", { name: /^Open$/i }))
    .or(page.locator("[role='button'], [role='link']").filter({ hasText: /^Open$/i }))
    .or(page.locator("a, button").filter({ hasText: /^Open$/i }));
}

function pnmSubtitlePattern(): RegExp {
  const raw = process.env.OHID_PNM_SUBTITLE?.trim();
  if (!raw) {
    return /OMES PNM Module/i;
  }
  return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/**
 * From the “OMES PNM Module” line, take the nearest ancestor that already contains an Open control.
 * Avoids matching a large list wrapper that also has both title strings in its subtree (wrong Open).
 */
function providerNetworkPnmRowFromOmesSubtitle(page: Page): Locator {
  return page
    .getByText(pnmSubtitlePattern(), { exact: false })
    .first()
    .locator(
      "xpath=ancestor-or-self::*[.//button[contains(normalize-space(.),'Open')] or .//a[contains(normalize-space(.),'Open')]][1]",
    );
}

/**
 * Ohio My Apps “Other apps” cards: title + subtitle “OMES PNM Module” + Open (see screenshot).
 * Matching both lines avoids the other apps’ Open buttons (e.g. Ohio Career Navigator).
 */
function providerNetworkOhioCardLocator(page: Page): Locator {
  const openInTile = openControlLocator(page);
  const title = /Provider Network Management/i;
  const subtitle = pnmSubtitlePattern();
  return page
    .locator("div, article, section, li")
    .filter({ hasText: title })
    .filter({ hasText: subtitle })
    .filter({ has: openInTile });
}

/**
 * Prefer a small tile that contains both the PNM title and an Open control — not a huge div ancestor.
 */
function providerNetworkTileCandidates(page: Page): Locator[] {
  const openInTile = openControlLocator(page);
  const pnm = /Provider Network Management/i;
  return [
    providerNetworkPnmRowFromOmesSubtitle(page),
    providerNetworkOhioCardLocator(page),
    page.getByRole("listitem").filter({ hasText: pnm }).filter({ has: openInTile }),
    page.getByRole("row").filter({ hasText: pnm }).filter({ has: openInTile }),
    page.locator("article").filter({ hasText: pnm }).filter({ has: openInTile }),
    page.locator("li").filter({ hasText: pnm }).filter({ has: openInTile }),
    page
      .locator('[class*="card" i], [class*="tile" i], [class*="app-item" i]')
      .filter({ hasText: pnm })
      .filter({ has: openInTile }),
    page.locator("div, section, article, li").filter({ hasText: pnm }).filter({ has: openInTile }),
  ];
}

async function resolveProviderNetworkTile(page: Page): Promise<Locator | null> {
  for (const c of providerNetworkTileCandidates(page)) {
    if ((await c.count()) > 0) {
      return c.first();
    }
  }
  return null;
}

/**
 * When strict tile queries fail (custom DOM, non-list markup): start at the PNM label and pick the
 * smallest plausible ancestor that contains an Open control.
 */
async function resolveProviderNetworkTileRelaxed(page: Page): Promise<Locator | null> {
  if (process.env.OHID_PNM_RELAXED === "false") {
    return null;
  }

  const pnm = /Provider Network Management/i;
  const openIn = (root: Locator) =>
    root.locator("a, button, [role='button'], [role='link']").filter({ hasText: /^Open$/i });

  const heading = page.getByRole("heading", { name: pnm });
  const anchor =
    (await heading.count()) > 0 ? heading.first() : page.getByText(pnm).first();
  if ((await anchor.count()) === 0) {
    return null;
  }

  for (const tag of ["li", "tr", "article", "section"] as const) {
    const row = anchor.locator(`xpath=ancestor::${tag}[1]`);
    if ((await row.count()) === 0) {
      continue;
    }
    const cand = row.first();
    if ((await openIn(cand).count()) > 0 && (await cand.isVisible().catch(() => false))) {
      return cand;
    }
  }

  for (let d = 1; d <= 16; d++) {
    const row = anchor.locator(`xpath=ancestor::div[${d}]`);
    if ((await row.count()) === 0) {
      break;
    }
    const cand = row.first();
    if ((await openIn(cand).count()) === 0) {
      continue;
    }
    if (!(await cand.isVisible().catch(() => false))) {
      continue;
    }
    const box = await cand.boundingBox().catch(() => null);
    if (box && box.height > 0 && box.height < 1_200) {
      return cand;
    }
  }
  for (let d = 1; d <= 16; d++) {
    const row = anchor.locator(`xpath=ancestor::div[${d}]`);
    if ((await row.count()) === 0) {
      break;
    }
    const cand = row.first();
    if ((await openIn(cand).count()) > 0 && (await cand.isVisible().catch(() => false))) {
      return cand;
    }
  }

  const fallback = anchor.locator(
    "xpath=ancestor::div[contains(@class,'card') or contains(@class,'Card') or contains(@class,'tile') or contains(@class,'Tile')][1]",
  );
  if ((await fallback.count()) > 0 && (await openIn(fallback.first()).count()) > 0) {
    return fallback.first();
  }

  return null;
}

/**
 * Some My Apps UIs expose a direct PNM deep link with label "Open" before the title is visible as plain text.
 */
async function resolveProviderNetworkHrefRow(page: Page): Promise<Locator | null> {
  const sel =
    'a[href*="pnm"], a[href*="PNM"], a[href*="ohpnm"], a[href*="OHPNM"], a[href*="maximus"], a[href*="MAXIMUS"]';
  const link = page.locator(sel).filter({ hasText: /^Open$/i }).first();
  if ((await link.count()) === 0 || !(await link.isVisible().catch(() => false))) {
    return null;
  }
  const li = link.locator("xpath=ancestor::li[1]");
  if ((await li.count()) > 0) {
    return li.first();
  }
  const tr = link.locator("xpath=ancestor::tr[1]");
  if ((await tr.count()) > 0) {
    return tr.first();
  }
  const art = link.locator("xpath=ancestor::article[1]");
  if ((await art.count()) > 0) {
    return art.first();
  }
  return link;
}

async function resolveProviderNetworkTileAny(page: Page): Promise<Locator | null> {
  return (
    (await resolveProviderNetworkTile(page)) ??
    (await resolveProviderNetworkHrefRow(page)) ??
    (await resolveProviderNetworkTileRelaxed(page))
  );
}

/** Scroll My Apps until the PNM tile (with Open) exists and is centered — handles inner scroll containers. */
async function scrollUntilProviderNetworkTileReady(page: Page): Promise<Locator> {
  await page
    .getByRole("heading", { name: /other apps/i })
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);

  const tryResolveVisibleTile = async (): Promise<Locator | null> => {
    const tile = await resolveProviderNetworkTileAny(page);
    if (!tile || (await tile.count()) === 0) {
      return null;
    }
    const first = tile;
    if (!(await first.isVisible().catch(() => false))) {
      return null;
    }
    await first.scrollIntoViewIfNeeded();
    if (await first.isVisible().catch(() => false)) {
      return first;
    }
    return null;
  };

  const pollUntil = Date.now() + OH.myAppsNoScrollPoll;
  while (Date.now() < pollUntil) {
    const quick = await tryResolveVisibleTile();
    if (quick) {
      console.log("[OHID] Provider Network Management tile ready (no scroll — list hydrated).");
      return quick;
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }

  const maxSteps = OH.scrollSteps;
  const pauseMs = OH.scrollPause;

  for (let step = 0; step < maxSteps; step++) {
    const tile = await resolveProviderNetworkTileAny(page);
    if (tile && (await tile.count()) > 0 && (await tile.isVisible().catch(() => false))) {
      await tile.scrollIntoViewIfNeeded();
      if (await tile.isVisible().catch(() => false)) {
        console.log("[OHID] Provider Network Management tile in view after scroll step", step + 1);
        return tile;
      }
    }
    await scrollMyAppsInner(page, 520);
    await page.keyboard.press("PageDown").catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, Number.isFinite(pauseMs) && pauseMs > 0 ? pauseMs : OH.scrollPause));
  }

  await page.keyboard.press("End").catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, OH.scrollEndPause));
  await scrollMyAppsInner(page, OH.scrollFinalInner).catch(() => undefined);

  let tile: Locator | null = await resolveProviderNetworkTileAny(page);
  if (!tile || (await tile.count()) === 0) {
    await page.getByText(/Provider Network Management/i).first().scrollIntoViewIfNeeded().catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, OH.scrollRetryPause));
    tile = await resolveProviderNetworkTileAny(page);
  }
  if (!tile || (await tile.count()) === 0) {
    throw new Error(
      "Provider Network Management row not found after scrolling. Try OHID_MY_APPS_SCROLL_STEPS, HEADLESS=false, or confirm the app name on My Apps.",
    );
  }
  await tile.scrollIntoViewIfNeeded();
  console.log("[OHID] Finished scrolling My Apps (end + fallback).");
  return tile;
}

/** PNM may open a new tab; the My Apps tab can close. Poll every live page until the terms checkbox appears. */
async function pageWithTermsCheckbox(
  context: BrowserContext,
  pnmAppUrl: RegExp,
  timeoutMs: number,
): Promise<Page> {
  const agree = (p: Page) => p.getByRole("checkbox", { name: /Yes, I have read/i }).first();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pages = context.pages().filter((p) => !p.isClosed());
    for (const p of pages) {
      const box = agree(p);
      if (await box.isVisible().catch(() => false)) {
        return p;
      }
    }
    await new Promise<void>((r) => setTimeout(r, 250));
  }

  // Do not return a "PNM-looking" tab without a visible checkbox — that caused agree.click to time out.
  const pages = context.pages().filter((p) => !p.isClosed());
  const urls = pages.map((p) => p.url()).join(" | ");
  throw new Error(
    `Terms checkbox (Yes, I have read) not visible on any tab within ${timeoutMs}ms. Open URLs: ${urls || "(none)"}`,
  );
}

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickProviderRegIdIfConfigured(appPage: Page): Promise<void> {
  const raw = process.env.OHID_REG_ID?.trim();
  if (!raw) return;
  const id = raw;
  const escaped = escapeRegexLiteral(id);

  console.log(`[OHID] Clicking Reg ID ${id}…`);

  await appPage.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);

  /** After terms, PNM often lands on ProviderHomeNew.aspx; the Reg ID grid is on another view. */
  async function tryOpenProvidersListFromHome(): Promise<void> {
    if (!/ProviderHomeNew\.aspx/i.test(appPage.url())) return;
    const navCandidates: Locator[] = [
      appPage.getByRole("link", { name: /^My Providers$/i }).first(),
      appPage.getByRole("link", { name: /My Providers/i }).first(),
      appPage.getByRole("link", { name: /Current.*Applications?/i }).first(),
      appPage.getByRole("link", { name: /View.*Provider/i }).first(),
      appPage.getByRole("link", { name: /Enrollment/i }).first(),
    ];
    for (const loc of navCandidates) {
      try {
        if ((await loc.count()) === 0) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        console.log("[OHID] On provider home — opening provider list…");
        await loc.click({ timeout: 8_000 });
        await appPage.waitForLoadState("domcontentloaded", { timeout: OH.regIdNav }).catch(() => undefined);
        await new Promise<void>((r) => setTimeout(r, 500));
        console.log("[OHID] Navigated from home. URL:", appPage.url());
        return;
      } catch {
        /* try next */
      }
    }
  }

  await tryOpenProvidersListFromHome();

  const linkCandidates: Locator[] = [
    appPage.getByRole("link", { name: new RegExp(`^${escaped}$`) }).first(),
    appPage.locator(`a[href*="${id}"], a[href*="RegID"], a[href*="regID"]`).filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }).first(),
    appPage.locator("a").filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }).first(),
    appPage.locator("tr").filter({ hasText: new RegExp(`\\b${escaped}\\b`) }).getByRole("link").first(),
    appPage.getByRole("link", { name: new RegExp(`\\b${escaped}\\b`) }).first(),
  ];

  const deadline = Date.now() + OH.regIdClick;
  let link: Locator | null = null;
  let retriedHomeNav = false;
  while (Date.now() < deadline && !link) {
    if (
      !retriedHomeNav &&
      /ProviderHomeNew\.aspx/i.test(appPage.url()) &&
      Date.now() > deadline - OH.regIdClick / 2
    ) {
      retriedHomeNav = true;
      await tryOpenProvidersListFromHome();
    }
    for (const c of linkCandidates) {
      try {
        if ((await c.count()) === 0) continue;
        await c.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
        if (await c.isVisible().catch(() => false)) {
          link = c;
          break;
        }
      } catch {
        /* next */
      }
    }
    if (!link) {
      await new Promise<void>((r) => setTimeout(r, 400));
    }
  }

  if (!link) {
    throw new Error(
      `Reg ID ${id} link not found (URL: ${appPage.url()}). Open the list that shows Reg IDs, or increase OHID_REG_ID_CLICK_MS.`,
    );
  }

  const nav = appPage
    .waitForURL(
      (u) =>
        /ProviderDetailsNew\.aspx/i.test(u.href) ||
        /regID=/i.test(u.href) ||
        !/ProviderHomeNew\.aspx/i.test(u.href),
      { timeout: OH.regIdNav, waitUntil: "domcontentloaded" },
    )
    .catch(() => null);

  await link.click({ timeout: OH.regIdClick });
  await nav;
  await appPage.waitForLoadState("domcontentloaded", { timeout: OH.regIdNav }).catch(() => undefined);

  console.log(`[OHID] Reg ID ${id} clicked. Current URL: ${appPage.url()}`);
}

type ExpandResult = { clicked: boolean; method?: string; reason?: string };

/**
 * Click the "+" expander for the "Self Service" section on the Provider Details page.
 *
 * The "+" icon in this ASP.NET page is NOT always an <a> or <button>; it may be a <span>,
 * <td>, or other element with an `onclick` handler. We search broadly:
 *   1. Any [onclick] element inside the row that is NOT one of the visible navigation links.
 *   2. Any element with text exactly "+" (any tag) inside the row.
 *   3. The grey bar "Self Service Selections:" header itself (often the clickable toggle).
 */
async function clickSectionPlusViaJs(appPage: Page, selectionsText: string): Promise<ExpandResult> {
  return appPage.evaluate((selText: string): ExpandResult => {
    // Arrow functions only — esbuild does not instrument these with __name, which would break in browser.
    const textOf = (el: Element): string =>
      ((el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "");

    const isNavLink = (el: HTMLElement): boolean => {
      if (el.tagName !== "A") return false;
      const href = (el as HTMLAnchorElement).href ?? "";
      return /\.aspx/i.test(href) && !href.includes("__doPostBack") && !href.includes("javascript:");
    };

    // 1. Find the "XYZ Selections:" grey bar — prefer the shallowest (leaf) match.
    const candidates = Array.from(document.querySelectorAll("td, th, span, div, label, p")) as HTMLElement[];
    const selRe = new RegExp(`^${selText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    const headerEl =
      candidates
        .slice()
        .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)
        .find((el) => selRe.test(textOf(el))) ??
      candidates.find((el) => (el.textContent ?? "").includes(selText.replace(/:$/, ""))) ??
      null;

    if (!headerEl) return { clicked: false, reason: `"${selText}" not found in DOM` };

    // 2. Walk up to nearest <tr> or multi-child container.
    let row: Element | null = headerEl.closest("tr");
    if (!row) {
      let el: Element | null = headerEl.parentElement;
      for (let i = 0; i < 10 && el; i++) {
        if (el.children.length >= 2) { row = el; break; }
        el = el.parentElement;
      }
    }
    if (!row) return { clicked: false, reason: "no row/container ancestor" };

    const allInRow = Array.from(row.querySelectorAll("*")) as HTMLElement[];
    const notInHeader = allInRow.filter((el) => !headerEl.contains(el));

    // 3a. Any [onclick] element that is NOT a plain .aspx navigation link.
    const withOnclick = notInHeader.filter(
      (el) => (el.onclick !== null || el.hasAttribute("onclick")) && !isNavLink(el),
    );
    if (withOnclick.length > 0) {
      withOnclick[0]!.click();
      return { clicked: true, method: `onclick <${withOnclick[0]!.tagName}>` };
    }

    // 3b. Any element with text exactly "+" (covers <span>, <td>, <a>, etc.).
    const plusEl = notInHeader.find((el) => textOf(el) === "+" || textOf(el) === "\uFF0B");
    if (plusEl) {
      plusEl.click();
      return { clicked: true, method: `text=+ <${plusEl.tagName}>` };
    }

    // 3c. Non-navigation anchor in the row.
    const nonNav = notInHeader.find((el) => el.tagName === "A" && !isNavLink(el));
    if (nonNav) {
      nonNav.click();
      return { clicked: true, method: "non-nav anchor" };
    }

    // 3d. Click the grey bar header itself — the header IS the toggle in some ASP.NET skins.
    (headerEl as HTMLElement).click();
    return { clicked: true, method: "header bar click" };
  }, selectionsText);
}

type MedicateSearchFields = {
  medicaidBillingNumber: string;
  dateOfBirth: string;
  fromDos: string;
  toDos: string;
  /** Optional — forwarded from API; filled when a matching input exists on Search Eligibility. */
  companyName?: string;
};

function medicateSearchFromEnv(): MedicateSearchFields | null {
  const raw = process.env.OHID_MEDICATE_SEARCH_JSON?.trim();
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const medicaidBillingNumber = String(o.medicaidBillingNumber ?? "").trim();
    const dateOfBirth = String(o.dateOfBirth ?? "").trim();
    const fromDos = String(o.fromDos ?? "").trim();
    const toDos = String(o.toDos ?? "").trim();
    const companyName = String(o.companyName ?? "").trim();
    if (!medicaidBillingNumber || !dateOfBirth || !fromDos || !toDos) {
      console.warn("[OHID] OHID_MEDICATE_SEARCH_JSON must include all of medicaidBillingNumber, dateOfBirth, fromDos, toDos.");
      return null;
    }
    const out: MedicateSearchFields = { medicaidBillingNumber, dateOfBirth, fromDos, toDos };
    if (companyName) {
      out.companyName = companyName;
    }
    return out;
  } catch (e) {
    console.error("[OHID] Invalid OHID_MEDICATE_SEARCH_JSON:", e);
    return null;
  }
}

/**
 * PNM may open Search Eligibility in the same tab or another tab — use whichever has the form.
 */
/** If the ELIGIBILITY SEARCH block is collapsed, open it so #txtMBN is visible. */
async function ensureEligibilitySearchPanelOpen(formPage: Page): Promise<void> {
  const mbn = formPage.locator("#txtMBN, [id$='txtMBN']").first();
  if (await mbn.isVisible().catch(() => false)) return;

  const toggles: Locator[] = [
    formPage.getByRole("link", { name: /ELIGIBILITY\s*SEARCH/i }).first(),
    formPage.getByRole("button", { name: /ELIGIBILITY\s*SEARCH/i }).first(),
    formPage.locator("a, span, div, h2, h3, h4, td").filter({ hasText: /^[\s+]*ELIGIBILITY\s*SEARCH/i }).first(),
  ];
  for (const t of toggles) {
    try {
      if ((await t.count()) === 0) continue;
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.scrollIntoViewIfNeeded().catch(() => undefined);
      await t.click({ timeout: 8_000, force: true });
      await new Promise<void>((r) => setTimeout(r, 500));
      if (await mbn.isVisible().catch(() => false)) {
        console.log("[OHID] Expanded ELIGIBILITY SEARCH panel.");
        return;
      }
    } catch {
      /* try next */
    }
  }
}

async function resolveSearchEligibilityPage(context: BrowserContext, preferred: Page): Promise<Page> {
  const tryPick = (): Page | null => {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      try {
        if (/SearchEligibility\.aspx/i.test(p.url())) return p;
      } catch {
        /* cross-origin */
      }
    }
    return null;
  };
  let found = tryPick();
  if (found) return found;
  if (/SearchEligibility\.aspx/i.test(preferred.url())) return preferred;
  for (let i = 0; i < 120; i++) {
    await new Promise<void>((r) => setTimeout(r, 250));
    found = tryPick();
    if (found) return found;
  }
  console.warn("[OHID] No tab with SearchEligibility.aspx — using preferred page:", preferred.url());
  return preferred;
}

/**
 * SearchEligibility.aspx — fills using ONLY Playwright locators (no page.evaluate TypeScript).
 *
 * Confirmed IDs from diagnostic dump (2026-04-09):
 *   #txtMBN   = Medicaid Billing Number  (type="number")
 *   #txtDOB   = Date of Birth            (type="text", hasDatepicker, onblur=formatDatewithZero)
 *   #txtFDOS  = From DOS                 (type="text", hasDatepicker)
 *   #txtTDOS  = To DOS                   (type="text", hasDatepicker)
 *   #btnSearch = Search button
 * Optional companyName: tries common provider/company inputs if present in JSON.
 */
async function fillSearchEligibilityIfConfigured(appPage: Page): Promise<void> {
  const cfg = medicateSearchFromEnv();
  if (!cfg) {
    console.log("[OHID] No OHID_MEDICATE_SEARCH_JSON — skipping Search Eligibility fill.");
    return;
  }

  console.log("[OHID] Medicate Search Eligibility: filling form from API payload…");
  console.log("[OHID] payload:", JSON.stringify(cfg));

  const context = appPage.context();
  const formPage = await resolveSearchEligibilityPage(context, appPage);
  console.log("[OHID] formPage URL:", formPage.url());

  await formPage
    .waitForURL(/SearchEligibility\.aspx/i, { timeout: OH.medicatePageWait, waitUntil: "domcontentloaded" })
    .catch(() => console.warn("[OHID] URL check failed — current:", formPage.url()));
  await formPage.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, 600));

  await ensureEligibilitySearchPanelOpen(formPage);

  // ── Scroll: bring billing field into viewport ────────────────────────────
  const billingLoc = formPage.locator("#txtMBN, [id$='txtMBN'], [name='Medicaid Billing Number']").first();
  await billingLoc.waitFor({ state: "visible", timeout: OH.medicateField });
  await billingLoc.scrollIntoViewIfNeeded().catch(() => undefined);

  const vp = formPage.viewportSize();
  await formPage.mouse.move((vp?.width ?? 1280) / 2, (vp?.height ?? 720) / 2);
  for (let i = 0; i < 8; i++) {
    await formPage.mouse.wheel(0, 350);
    await new Promise<void>((r) => setTimeout(r, 25));
  }
  await new Promise<void>((r) => setTimeout(r, 250));

  // ── Helper: click → clear → fill → Tab ────────────────────────────────────
  async function fillField(locator: Locator, value: string, name: string): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: 10_000, force: true });
    await locator.press("Control+a");
    await locator.press("Backspace");
    await locator.fill(value, { timeout: OH.medicateField });
    await locator.press("Tab");
    const got = await locator.inputValue().catch(() => "?");
    console.log(`[OHID] Filled ${name}: got="${got}" expected="${value}"`);
  }

  /**
   * #txtMBN is often type="number"; alphanumeric Medicaid billing IDs need value set in page and type relaxed.
   */
  async function fillMedicaidBillingNumber(locator: Locator, value: string): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: 10_000, force: true });
    const hasLetters = /[a-zA-Z]/.test(value);
    try {
      if (!hasLetters) {
        await locator.press("Control+a");
        await locator.press("Backspace");
        await locator.fill(value, { timeout: OH.medicateField });
      } else {
        throw new Error("use DOM path for alphanumeric MBN");
      }
    } catch {
      await formPage.evaluate((v) => {
        const el =
          (document.getElementById("txtMBN") as HTMLInputElement | null) ??
          (document.querySelector('[id$="txtMBN"]') as HTMLInputElement | null);
        if (!el) return;
        el.removeAttribute("readonly");
        el.type = "text";
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, value);
    }
    await locator.press("Tab").catch(() => undefined);
    const got = await locator.inputValue().catch(() => "?");
    console.log(`[OHID] Filled txtMBN: got="${got}" expected="${value}"`);
  }

  // ── 1. Medicaid Billing Number ────────────────────────────────────────────
  await fillMedicaidBillingNumber(billingLoc, cfg.medicaidBillingNumber);

  // ── 1b. Optional company / provider name (not on all builds of Search Eligibility)
  if (cfg.companyName) {
    const companyCandidates: Locator[] = [
      formPage.locator("#txtCompanyName, #txtProviderName, #txtBusinessName").first(),
      formPage.locator("[id$='txtCompanyName'], [id$='txtProviderName'], [id$='txtBusinessName']").first(),
      formPage.getByRole("textbox", { name: /company|provider\s*name|business|organization/i }).first(),
    ];
    let filledCompany = false;
    for (const loc of companyCandidates) {
      try {
        if ((await loc.count()) === 0) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        await fillField(loc, cfg.companyName, "companyName");
        filledCompany = true;
        break;
      } catch {
        /* try next */
      }
    }
    if (!filledCompany) {
      console.log(
        "[OHID] companyName was provided but no matching visible field was found — continuing (billing/DOB/DOS only).",
      );
    }
  }

  // ── 2. Date of Birth ─────────────────────────────────────────────────────
  const dobLoc = formPage.locator("#txtDOB, [id$='txtDOB']").first();
  await dobLoc.waitFor({ state: "visible", timeout: OH.medicateField });
  // Date strings are forwarded to the OHID UI as entered (expected mm/dd/yyyy).
  await fillField(dobLoc, cfg.dateOfBirth, "txtDOB");

  // ── 3. From DOS ──────────────────────────────────────────────────────────
  const fromLoc = formPage.locator("#txtFDOS, [id$='txtFDOS']").first();
  await fromLoc.waitFor({ state: "visible", timeout: OH.medicateField });
  // Expected mm/dd/yyyy.
  await fillField(fromLoc, cfg.fromDos, "txtFDOS");

  // ── 4. To DOS ────────────────────────────────────────────────────────────
  const toLoc = formPage.locator("#txtTDOS, [id$='txtTDOS']").first();
  await toLoc.waitFor({ state: "visible", timeout: OH.medicateField });
  // Expected mm/dd/yyyy.
  await fillField(toLoc, cfg.toDos, "txtTDOS");

  await new Promise<void>((r) => setTimeout(r, 300));

  // ── 5. Click Search ───────────────────────────────────────────────────────
  const searchLoc = formPage.locator("#btnSearch, [id$='btnSearch'], button.buttonBoxFocus").first();
  await searchLoc.waitFor({ state: "visible", timeout: OH.medicateField });
  await searchLoc.scrollIntoViewIfNeeded().catch(() => undefined);
  await searchLoc.click({ timeout: OH.medicateField, force: true });
  console.log("[OHID] Clicked Search.");

  await formPage.waitForLoadState("domcontentloaded", { timeout: OH.medicateAfterSearch }).catch(() => undefined);
  console.log("[OHID] Search Eligibility done. URL:", formPage.url());

  async function expandAccordionIfCollapsed(titleRe: RegExp, contentWait?: Locator): Promise<void> {
    // Keep this bounded: never hang the whole run on a flaky accordion.
    const titleLabel = String(titleRe).replace(/^\/|\/[gimsuy]*$/g, "");

    const containerHandle = await formPage.evaluateHandle(({ source, flags }) => {
      const re = new RegExp(source, flags);
      const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

      const candidates = Array.from(document.querySelectorAll<HTMLElement>("a, button, div, span, td, th"));
      const titleEl =
        candidates.find((el) => re.test(el.innerText || el.textContent || "")) ??
        candidates.find((el) => re.test(normalize(el.innerText || el.textContent || "")));
      if (!titleEl) return null;

      const iconLike = (el: Element | null | undefined) => {
        if (!el) return false;
        const t = (el.textContent || "").trim();
        return t === "+" || t === "-";
      };

      let container: HTMLElement | null =
        (titleEl.closest("tr") as HTMLElement | null) ||
        (titleEl.closest("div") as HTMLElement | null) ||
        (titleEl.parentElement as HTMLElement | null);
      for (let i = 0; i < 8 && container; i++) {
        const hasIcon = Array.from(container.querySelectorAll("*")).some((n) => iconLike(n));
        if (hasIcon) break;
        container = container.parentElement as HTMLElement | null;
      }
      return container;
    }, { source: titleRe.source, flags: titleRe.flags });

    const containerEl = containerHandle.asElement();
    if (!containerEl) return;

    const state = await formPage
      .evaluate((el) => {
        const iconLike = (n: Element | null | undefined) => {
          if (!n) return false;
          const t = (n.textContent || "").trim();
          return t === "+" || t === "-";
        };
        const icons = Array.from(el.querySelectorAll("*")).filter((n) => iconLike(n));
        const hasPlus = icons.some((n) => (n.textContent || "").trim() === "+");
        const hasMinus = icons.some((n) => (n.textContent || "").trim() === "-");
        return { hasPlus, hasMinus };
      }, containerEl)
      .catch(() => null);

    if (!state) return;
    if (state.hasMinus && !state.hasPlus) return; // expanded
    if (!state.hasPlus && !state.hasMinus) return; // unknown; don't toggle blindly

    await containerEl.scrollIntoViewIfNeeded().catch(() => undefined);
    await containerEl.click({ timeout: 10_000 }).catch(() => undefined);

    const expanded = await formPage
      .waitForFunction(
        ({ source, flags }) => {
          const re = new RegExp(source, flags);
          const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
          const candidates = Array.from(document.querySelectorAll<HTMLElement>("a, button, div, span, td, th"));
          const titleEl =
            candidates.find((el) => re.test(el.innerText || el.textContent || "")) ??
            candidates.find((el) => re.test(normalize(el.innerText || el.textContent || "")));
          if (!titleEl) return true;

          const iconLike = (el: Element | null | undefined) => {
            if (!el) return false;
            const t = (el.textContent || "").trim();
            return t === "+" || t === "-";
          };

          let container: HTMLElement | null =
            (titleEl.closest("tr") as HTMLElement | null) ||
            (titleEl.closest("div") as HTMLElement | null) ||
            (titleEl.parentElement as HTMLElement | null);
          for (let i = 0; i < 8 && container; i++) {
            const hasIcon = Array.from(container.querySelectorAll("*")).some((n) => iconLike(n));
            if (hasIcon) break;
            container = container.parentElement as HTMLElement | null;
          }
          if (!container) return true;
          const icons = Array.from(container.querySelectorAll("*")).filter((n) => iconLike(n));
          const hasPlus = icons.some((n) => (n.textContent || "").trim() === "+");
          const hasMinus = icons.some((n) => (n.textContent || "").trim() === "-");
          return hasMinus && !hasPlus;
        },
        { source: titleRe.source, flags: titleRe.flags },
        { timeout: 12_000 },
      )
      .then(() => true)
      .catch(() => false);

    if (!expanded) {
      console.warn(`[OHID] Accordion did not confirm expanded within timeout: ${titleLabel}`);
      return;
    }

    if (contentWait) {
      await contentWait.waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
    }
  }

  async function expandAllEligibilityAccordions(): Promise<void> {
    // Expand all major accordion sections shown on SearchEligibility.aspx.
    // We key off the visible "+" icon: if present, the panel is collapsed.
    const benefitTable = formPage
      .locator("table")
      .filter({ has: formPage.locator("th, td").filter({ hasText: /Benefit\s*\/\s*Assignment\s*Plan/i }) })
      .first();
    const managedTable = formPage
      .locator("table")
      .filter({ has: formPage.locator("th, td").filter({ hasText: /^Plan\s*Name$/i }) })
      .first();

    const sections: Array<{ re: RegExp; wait?: Locator }> = [
      { re: /RECIPIENT\s+INFORMATION/i },
      { re: /BENEFIT\s*\/\s*ASSIGNMENT\s*PLAN/i, wait: benefitTable },
      { re: /MANAGED\s+CARE\s+PLANS/i, wait: managedTable },
      { re: /THIRD\s+PARTY\s+LIABILITY/i },
      { re: /PATIENT\s+LIABILITY/i },
      { re: /LONG\s+TERM\s+CARE\s+FACILITY\s+PLACEMENTS/i },
      { re: /\bLOCK\s*IN\b/i },
      { re: /\bMEDICARE\b/i },
      { re: /SERVICE\s+LIMITATION/i },
      { re: /RESTRICTED\s+COVERAGE/i },
      { re: /ASSOCIATED\s+CHILD/i },
    ];

    for (const s of sections) {
      await expandAccordionIfCollapsed(s.re, s.wait);
    }
  }

  console.log("[OHID] Expanding all accordion panels before screenshot…");
  await expandAllEligibilityAccordions().catch((e) => {
    console.warn("[OHID] Could not expand all panels (continuing):", e instanceof Error ? e.message : e);
  });

  const holdMs = OH.medicateHoldAfterSearch;
  if (holdMs > 0) {
    console.log(`[OHID] Holding ${(holdMs / 1000).toFixed(0)}s on results before Playwright exits…`);
    await new Promise<void>((r) => setTimeout(r, holdMs));
    console.log("[OHID] Hold complete.");
  }

  // BENEFIT/ASSIGNMENT + MANAGED CARE tables → JSON stdout marker for Temporal workflow result
  // Capture return value so we can use recipientInformation.firstNameMi for the screenshot name.
  const eligibilityPayload = await reportSearchEligibilityPageData(formPage, cfg).catch((e) => {
    console.error("[OHID] reportSearchEligibilityPageData:", e instanceof Error ? e.message : e);
    return null;
  });

  // After expanding everything, capture the final Search Eligibility screen (full page).
  try {
    const sanitizePart = (s: string) =>
      s
        .trim()
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);

    // firstNameMi comes from the recipient information already extracted above (reliable).
    // medicaidBillingNumber comes directly from cfg (the value we searched with).
    const firstNameMi = String(eligibilityPayload?.recipientInformation?.firstNameMi || "").trim();
    const mbn = String(cfg.medicaidBillingNumber || "").trim();

    console.log("[OHID] Screenshot name — firstNameMi:", JSON.stringify(firstNameMi), "| mbn:", JSON.stringify(mbn));

    const baseDir = dirname(searchEligibilityScreenshotPath());
    let fileName: string;
    if (firstNameMi && mbn) {
      fileName = `${sanitizePart(firstNameMi)}_${sanitizePart(mbn)}.png`;
    } else if (firstNameMi) {
      fileName = `${sanitizePart(firstNameMi)}_${nowStamp()}.png`;
    } else if (mbn) {
      fileName = `${sanitizePart(mbn)}_${nowStamp()}.png`;
    } else {
      fileName = `search-eligibility-${ohidRunIdFromEnv()}-${nowStamp()}.png`;
    }
    console.log("[OHID] Screenshot will be saved as:", fileName);

    const p = join(baseDir, fileName);
    await mkdir(dirname(p), { recursive: true });
    await formPage.screenshot({ path: p, fullPage: true }).catch(() => undefined);
    console.log("[OHID] Saved Search Eligibility screenshot:", p);
  } catch (e) {
    console.warn(
      "[OHID] Could not write Search Eligibility screenshot (continuing):",
      e instanceof Error ? e.message : e,
    );
  }
}

async function expandSelfServiceAndOpenRecipientEligibility(appPage: Page): Promise<void> {
  if (!/ProviderDetailsNew\.aspx/i.test(appPage.url())) return;

  console.log("[OHID] Scrolling to Manage Application / Self Service…");

  const selfServiceLabel = appPage.getByText(/^Self Service$/i).first();
  await selfServiceLabel.waitFor({ state: "visible", timeout: OH.selfServiceExpand });
  await selfServiceLabel.scrollIntoViewIfNeeded().catch(() => undefined);
  // Small nudge so the row header and "+" icon are fully in the viewport.
  await appPage.evaluate(() => window.scrollBy(0, 120)).catch(() => undefined);
  await new Promise<void>((r) => setTimeout(r, 300));

  console.log("[OHID] Expanding Self Service (+ icon)…");

  // Inspect: the "+" is <span id="spanSelfServiceIcon">+</span> (cursor:pointer) — not an <a>.
  const spanSelfServicePlus = appPage.locator("#spanSelfServiceIcon");
  // Inspect: Recipient Eligibility is <a id="..._lnkRecipientEligibilityMITS" ...> (DoPostBack).
  const recipientByStableId = appPage.locator('[id$="_lnkRecipientEligibilityMITS"]').first();
  const recipientByIdLoose = appPage.locator('a[id*="lnkRecipientEligibility"]').first();
  const recipientByRole = appPage.getByRole("link", { name: /Recipient\s*Eligibility/i }).first();

  const alreadyOpen =
    (await recipientByStableId.isVisible().catch(() => false)) ||
    (await recipientByIdLoose.isVisible().catch(() => false)) ||
    (await recipientByRole.isVisible().catch(() => false));

  if (!alreadyOpen) {
    // Attempt 0: stable id from PNM markup (avoids clicking Provider Correspondence by mistake).
    if ((await spanSelfServicePlus.count()) > 0) {
      await spanSelfServicePlus.scrollIntoViewIfNeeded().catch(() => undefined);
      if (await spanSelfServicePlus.isVisible().catch(() => false)) {
        await spanSelfServicePlus.click({ timeout: OH.selfServiceExpand });
        console.log("[OHID] Self Service expanded via #spanSelfServiceIcon.");
      }
    }

    // If still collapsed (span missing or click no-op), fall back to JS / row locators.
    const stillCollapsed =
      !(await recipientByStableId.isVisible().catch(() => false)) &&
      !(await recipientByIdLoose.isVisible().catch(() => false)) &&
      !(await recipientByRole.isVisible().catch(() => false));

    if (stillCollapsed) {
    // Attempt 1: JS — locates "Self Service Selections:" grey bar, walks to ancestor <tr>,
    // clicks __doPostBack expander in that row (works even when "+" is a CSS pseudo-element).
    const jsResult = await clickSectionPlusViaJs(appPage, "Self Service Selections:");
    if (jsResult.clicked) {
      console.log(`[OHID] Self Service '+' clicked via JS (${jsResult.method}).`);
    } else {
      console.warn(`[OHID] JS expand failed (${jsResult.reason}) — trying Playwright locators.`);

      // Attempt 2: Playwright locators scoped to the same <tr> as "Self Service Selections:".
      const selectionsBar = appPage.getByText(/Self Service Selections:?/i).first();
      const playwrightCandidates: Locator[] = [
        // onclick attribute in the row (the "+" may be a <span onclick> or <td onclick>)
        selectionsBar.locator("xpath=ancestor::tr[1]//*[@onclick][1]"),
        selfServiceLabel.locator("xpath=ancestor::tr[1]//*[@onclick][1]"),
        // __doPostBack anchor in the same row
        selectionsBar.locator("xpath=ancestor::tr[1]//a[contains(@href,'__doPostBack')][1]"),
        selfServiceLabel.locator("xpath=ancestor::tr[1]//a[contains(@href,'__doPostBack')][1]"),
        // Any first anchor in the same row
        selectionsBar.locator("xpath=ancestor::tr[1]//a[1]"),
        selfServiceLabel.locator("xpath=ancestor::tr[1]//a[1]"),
        // The header bar itself may be the toggle
        selectionsBar,
      ];

      let clicked = false;
      for (const c of playwrightCandidates) {
        try {
          if ((await c.count()) === 0) continue;
          await c.scrollIntoViewIfNeeded().catch(() => undefined);
          await c.click({ timeout: 6_000, force: true });
          console.log("[OHID] Self Service '+' clicked via Playwright locator.");
          clicked = true;
          break;
        } catch {
          // try next
        }
      }

      if (!clicked) {
        // Diagnostic dump + last-resort click.
        const diag = await appPage.evaluate(() => {
          const bars = Array.from(document.querySelectorAll("td, th, span, div")).filter(
            (el) => /Self Service Selections/i.test(el.textContent?.trim() ?? ""),
          );
          if (bars.length === 0) return "no 'Self Service Selections' element found";
          const bar = bars[0]!;
          const tr = bar.closest("tr");
          if (!tr) return `bar found (tag=${bar.tagName}) but no <tr> ancestor`;
          const all = Array.from(tr.querySelectorAll("*")) as HTMLElement[];
          const summary = all.slice(0, 20).map(
            (el) =>
              `<${el.tagName.toLowerCase()} onclick="${el.getAttribute("onclick")?.slice(0, 40) ?? ""}" href="${(el as HTMLAnchorElement).href?.slice(0, 50) ?? ""}" text="${el.textContent?.trim().slice(0, 15)}">`,
          );
          return `tr has ${all.length} descendants. First 20: ${summary.join(" | ")}`;
        });
        console.warn(`[OHID] All locators failed. DOM: ${diag}`);
        console.warn("[OHID] Falling back to label click.");
        await selfServiceLabel.click({ timeout: OH.selfServiceExpand, force: true }).catch(() => undefined);
      }
    }
    }

    // Allow the ASP.NET panel to expand (postback or CSS toggle).
    await appPage.waitForLoadState("domcontentloaded", { timeout: 6_000 }).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 600));
  } else {
    console.log("[OHID] Self Service already expanded — skipping '+'.");
  }

  // Wait for Recipient Eligibility link to become visible.
  console.log("[OHID] Waiting for Recipient Eligibility link…");
  await Promise.race([
    recipientByStableId.waitFor({ state: "visible", timeout: OH.selfServiceExpand }),
    recipientByIdLoose.waitFor({ state: "visible", timeout: OH.selfServiceExpand }),
    recipientByRole.waitFor({ state: "visible", timeout: OH.selfServiceExpand }),
  ]).catch(() => undefined);

  let recipientToClick: Locator = recipientByRole;
  if ((await recipientByStableId.count()) > 0 && (await recipientByStableId.isVisible().catch(() => false))) {
    recipientToClick = recipientByStableId;
  } else if ((await recipientByIdLoose.count()) > 0 && (await recipientByIdLoose.isVisible().catch(() => false))) {
    recipientToClick = recipientByIdLoose;
  }

  if (!(await recipientToClick.isVisible().catch(() => false))) {
    throw new Error(
      "Recipient Eligibility link did not appear after expanding Self Service. " +
        "Try HEADLESS=false to inspect the page, or increase OHID_SELF_SERVICE_EXPAND_MS.",
    );
  }

  await recipientToClick.scrollIntoViewIfNeeded().catch(() => undefined);
  console.log("[OHID] Clicking Recipient Eligibility…");

  // Recipient Eligibility is an ASP.NET __doPostBack link — may fully reload the same .aspx URL.
  // waitForNavigation handles both same-URL reloads and real navigations.
  await Promise.all([
    appPage
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: OH.recipientEligibilityNav })
      .catch(() => null),
    recipientToClick.click({ timeout: OH.recipientEligibilityClick, force: true }),
  ]);

  await appPage
    .waitForLoadState("domcontentloaded", { timeout: OH.recipientEligibilityNav })
    .catch(() => undefined);

  console.log("[OHID] Recipient Eligibility opened. Current URL:", appPage.url());
}

/**
 * My Apps → Provider Network Management → Terms modal → check agreement.
 * Set OHID_OPEN_PNM=false to skip.
 */
async function openProviderNetworkAndAcceptTerms(page: Page, context: BrowserContext): Promise<void> {
  console.log("[OHID] Navigating to My Apps, then opening Provider Network Management…");

  await page.goto(OHID_MY_APPS_URL, { waitUntil: "domcontentloaded", timeout: OH.goto });
  await page
    .waitForURL(/manage-account\/my-apps/i, { timeout: OH.goto, waitUntil: "domcontentloaded" })
    .catch(() => undefined);
  if (OH.myAppsLoad > 0) {
    await page.waitForLoadState("load", { timeout: OH.myAppsLoad }).catch(() => undefined);
  }
  // One wait: OMES line on the PNM card (avoids sequential heading + subtitle + `load` delays on SPAs).
  await page
    .getByText(pnmSubtitlePattern(), { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: OH.myAppsSection });

  const pnmRow = await scrollUntilProviderNetworkTileReady(page);
  await pnmRow.waitFor({ state: "visible", timeout: OH.pnmRowVisible });
  await pnmRow.scrollIntoViewIfNeeded();

  console.log("[OHID] Clicking Open on Provider Network Management…");

  const openBtn = pnmRow.getByRole("button", { name: /^Open$/i }).first();
  const openLink = pnmRow.getByRole("link", { name: /^Open$/i }).first();
  await openBtn.waitFor({ state: "visible", timeout: OH.pnmOpenBtn }).catch(() =>
    openLink.waitFor({ state: "visible", timeout: OH.pnmOpenLink }).catch(() => undefined),
  );

  const openCandidates: Locator[] = [
    openBtn,
    openLink,
    pnmRow
      .locator(
        'a[href*="pnm"], a[href*="PNM"], a[href*="ohpnm"], a[href*="OHPNM"], a[href*="maximus"], a[href*="MAXIMUS"]',
      )
      .first(),
    pnmRow.locator("a, button, [role='button']").filter({ hasText: /^Open$/i }).first(),
    pnmRow.getByText(/^Open$/).first(),
  ];

  let clicked = false;
  let lastErr: unknown;
  for (const loc of openCandidates) {
    try {
      if ((await loc.count()) === 0) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => undefined);
      await loc.click({ timeout: OH.pnmClick });
      clicked = true;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!clicked) {
    try {
      await pnmRow
        .locator("a, button, [role='button']")
        .filter({ hasText: /^Open$/i })
        .first()
        .click({ force: true, timeout: OH.pnmClickForce });
      clicked = true;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!clicked) {
    try {
      const k = Math.max(0, Math.floor(Number(process.env.OHID_PNM_OPEN_NTH ?? "1")));
      const underOtherApps = page
        .locator("div, section, main")
        .filter({ has: page.getByRole("heading", { name: /^Other apps$/i }) })
        .first();
      await underOtherApps.getByRole("button", { name: /^Open$/i }).nth(k).click({ timeout: OH.pnmClick });
      console.log("[OHID] Open clicked via Other apps section (OHID_PNM_OPEN_NTH=", k, ").");
      clicked = true;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!clicked) {
    throw new Error(
      `Could not click Provider Network Management Open. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  const pnmAppUrl =
    /ohpnm|omes\.maximus|PNM|OH_PNM|maximus|medicaid|ohio\.gov\/.*pnm/i;
  let appPage: Page = page;

  try {
    const next = await Promise.race([
      page.waitForURL(pnmAppUrl, { timeout: OH.pnmNavRace, waitUntil: "domcontentloaded" }).then(() => page),
      context.waitForEvent("page", { timeout: OH.pnmNavRace }),
    ]);
    if (next !== page && typeof (next as Page).url === "function") {
      appPage = next as Page;
      await appPage.waitForLoadState("domcontentloaded", { timeout: OH.pnmLoad }).catch(() => undefined);
    }
  } catch {
    const openPages = context.pages().filter((p) => !p.isClosed());
    const byUrl = openPages.find((p) => pnmAppUrl.test(p.url()));
    appPage = byUrl ?? openPages[openPages.length - 1] ?? page;
    if (appPage !== page && !appPage.isClosed()) {
      await appPage.waitForLoadState("domcontentloaded", { timeout: OH.pnmLoadShort }).catch(() => undefined);
    }
  }

  if (appPage.isClosed()) {
    const openPages = context.pages().filter((p) => !p.isClosed());
    const byUrl = openPages.find((p) => pnmAppUrl.test(p.url()));
    appPage = byUrl ?? openPages[openPages.length - 1] ?? appPage;
  }

  // PNM may show /Account/Login.aspx with "Log in with OH|ID" before OHID redirect / terms.
  await clickPnmLoginWithOhidIfPresent(appPage, OH);

  // Handle optional OHID "Two-step verification — Choose a method" that appears before the PNM app.
  await handlePnmMfaIfPresent(context, OH);

  appPage = await pageWithTermsCheckbox(context, pnmAppUrl, OH.termsVisible);

  const agree = appPage.getByRole("checkbox", { name: /Yes, I have read/i }).first();
  await agree.waitFor({ state: "visible", timeout: OH.termsClick });
  // ASP.NET __doPostBack: the checkbox click submits and navigates; .check() waits for a stable checked state and times out.
  await agree.click({ noWaitAfter: true, timeout: OH.termsClick });
  await appPage.waitForLoadState("domcontentloaded", { timeout: OH.termsLoad }).catch(() => undefined);

  const maybeContinue = appPage
    .getByRole("button", {
      name: /^(Continue|Accept|I agree|Proceed|OK)$/i,
    })
    .first();
  if (await maybeContinue.isVisible().catch(() => false)) {
    await maybeContinue.click().catch(() => undefined);
  }

  console.log("[OHID] Provider Network Management: agreement checkbox checked.");

  await clickProviderRegIdIfConfigured(appPage);
  await expandSelfServiceAndOpenRecipientEligibility(appPage);
  await fillSearchEligibilityIfConfigured(appPage);
}

async function persistOhidSession(context: BrowserContext, pageForLog: Page): Promise<void> {
  await closeAtcTabsIfAny(context);
  const finalPath = sessionPath();
  await mkdir(dirname(finalPath), { recursive: true });
  const state = await context.storageState();
  const cleaned = stripAtcEmrFromStorageState(state);
  await writeFile(finalPath, JSON.stringify(cleaned, null, 2), "utf8");
  console.log("OHID flow completed. Session saved (ATC / atcemr cookies stripped):", finalPath);
  try {
    console.log("Current URL:", pageForLog.url());
  } catch {
    /* page may be detached */
  }
}

async function main(): Promise<void> {
  const headless = process.env.HEADLESS === "true";
  const slowMoMs = Number(process.env.SLOW_MO_MS ?? "0");
  const channel = process.env.PLAYWRIGHT_CHANNEL?.trim();
  const launchOpts: Parameters<typeof chromium.launch>[0] = { headless };
  if (Number.isFinite(slowMoMs) && slowMoMs > 0) {
    launchOpts.slowMo = slowMoMs;
  }
  if (channel) {
    launchOpts.channel = channel as NonNullable<Parameters<typeof chromium.launch>[0]>["channel"];
  }

  const cdpUrl = cdpEndpointFromEnv();
  const proxy = proxyFromEnv();

  if (cdpUrl) {
    console.log("[CDP] OHID_CDP_URL / OHID_CDP_PORT — attaching to your open browser (do not call browser.close on exit).");
  } else if (proxy) {
    console.log("[Network] Using proxy:", proxy.server);
  } else {
    console.log(
      "[Network] No OHID_CDP_* — launching bundled Chromium. For extension VPN: set OHID_CDP_PORT=9222 and start Chrome with --remote-debugging-port=9222.",
    );
  }

  const loginWaitMs = OH.loginWait;

  let browser: Browser;
  let context: BrowserContext;
  /** If false, we attached via CDP — must not browser.close() or we kill the user’s window. */
  let weOwnBrowser = true;
  /** In-page IP check matches browser-extension VPN. */
  let useInPageIpCheck = false;

  if (cdpUrl) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[CDP] connectOverCDP failed:", msg);
      console.error(
        "  Fix: 1) Close ALL Chrome. 2) npm run chrome:cdp  (must include --remote-allow-origins=*). 3) Open http://127.0.0.1:9222/json/version in a browser — if it fails, CDP is not up.",
      );
      throw err;
    }
    weOwnBrowser = false;
    useInPageIpCheck = true;
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error(
        "[CDP] No browser contexts found. Open Chrome/Edge with --remote-debugging-port and keep at least one window open.",
      );
    }
    console.log("[CDP] Attached — using your Chrome profile (extensions apply). Contexts:", contexts.length);
  } else {
    browser = await chromium.launch(launchOpts);
    const sPath = sessionPath();
    const sessionExists = existsSync(sPath);
    const ctxOpts = proxy ? { proxy } : {};
    if (sessionExists) {
      console.log("[Session] Loading saved session from", sPath, "(stripping any ATC / atcemr cookies)");
      let storageState: BrowserContextOptions["storageState"] = sPath;
      try {
        const raw = JSON.parse(await readFile(sPath, "utf8")) as JsonStorageState;
        storageState = stripAtcEmrFromStorageState(raw) as NonNullable<BrowserContextOptions["storageState"]>;
      } catch (e) {
        console.warn("[Session] Could not parse session JSON; loading path as-is:", e instanceof Error ? e.message : e);
      }
      context = await browser.newContext({ ...ctxOpts, storageState });
    } else {
      context = await browser.newContext(ctxOpts);
    }
  }

  let page: Page;
  if (cdpUrl) {
    const acquired = await acquirePageForOhid(browser, true);
    page = acquired.page;
    context = acquired.context;
  } else {
    context = browser.contexts()[0]!;
    page = (await acquirePageForOhid(browser, false)).page;
  }

  await waitForUsEgressThenProceed(context, useInPageIpCheck, useInPageIpCheck ? page : undefined);

  if (cdpUrl) {
    await closeNoiseTabsExcept(browser, page);
  }

  try {
    await page.goto(OHID_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: OH.goto });

    if (cdpUrl) {
      await closeNoiseTabsExcept(browser, page);
    }

    const landedOnLogin = /auth\.ohid\.ohio\.gov\/login/i.test(page.url());
    if (!landedOnLogin) {
      console.log("[Session] Saved session valid — already past login. URL:", page.url());
    } else {
      try {
        await fillAndSubmit(page);
      } catch (err) {
        const debugPath = join(PROJECT_ROOT, ".ohid-debug.png");
        await page.screenshot({ path: debugPath, fullPage: true }).catch(() => undefined);
        console.error("[OHID] Could not fill login form. Screenshot saved:", debugPath);
        throw err;
      }

      await handleOhidOtpFromStoreIfNeeded(page, OH);

      await waitPastLoginPage(page, loginWaitMs).catch(async () => {
        const url = page.url();
        if (/auth\.ohid\.ohio\.gov\/login/i.test(url)) {
          throw new Error(
            "Still on OHID login after submit — check credentials, 2FA, or increase LOGIN_WAIT_MS.",
          );
        }
      });

      await page.waitForLoadState("networkidle", { timeout: OH.networkIdle }).catch(() => undefined);
    }

    if (shouldOpenProviderNetworkAfterLogin()) {
      await openProviderNetworkAndAcceptTerms(page, context);
    }

    if (shouldStopAfterSearchEligibility()) {
      console.log(
        "[OHID] Stopping after Search Eligibility (data already emitted). Set OHID_STOP_AFTER_ELIGIBILITY=false for post-login stay only.",
      );
      await persistOhidSession(context, page);
      return;
    }

    await persistOhidSession(context, page);

    const stayMs = postLoginStayMs();
    if (stayMs > 0) {
      console.log(
        `Keeping browser open ${(stayMs / 60_000).toFixed(stayMs % 60_000 === 0 ? 0 : 2)} min…`,
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, stayMs);
      });
    }
  } finally {
    if (weOwnBrowser) {
      await browser.close();
    } else {
      console.log("[CDP] Finished — left your Chrome tabs open (no tab closed).");
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
