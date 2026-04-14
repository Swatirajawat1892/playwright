/**
 * Temporal activities: Playwright (Availity Essentials) + OTP polling against otpStore.
 */
import { log } from "@temporalio/activity";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { clearOtp, peekOtp } from "../otpStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

function resolveNpmCliPath() {
  const fromEnv = process.env.npm_execpath?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  const req = createRequire(import.meta.url);
  try {
    return req.resolve("npm/bin/npm-cli.js");
  } catch {
    return null;
  }
}

async function runNpmScript(scriptName, envOverrides = undefined) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const start = Date.now();

  return await new Promise((resolve, reject) => {
    const env = { ...process.env, ...(envOverrides || {}) };

    const spawnViaNodeNpmCli = () => {
      const npmCli = resolveNpmCliPath();
      if (!npmCli) {
        throw new Error(
          "Could not resolve npm CLI path (npm/bin/npm-cli.js). Ensure Node.js is installed with npm and available to the worker process.",
        );
      }
      console.log(`[OHID][activity] npm not in PATH; falling back to node "${npmCli}" run ${scriptName}`);
      return spawn(process.execPath, [npmCli, "run", scriptName], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });
    };

    let child;
    try {
      child = spawn(npmCmd, ["run", scriptName], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });
    } catch (e) {
      try {
        child = spawnViaNodeNpmCli();
      } catch (fallbackErr) {
        reject(fallbackErr);
        return;
      }
    }

    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    const pushCapped = (arr, s) => {
      arr.push(s);
      if (arr.length > 250) arr.shift();
    };

    child.stdout?.on("data", (chunk) => pushCapped(out, chunk.toString()));
    child.stderr?.on("data", (chunk) => pushCapped(err, chunk.toString()));
    child.on("error", (err) => {
      // Common on Windows services / PATH-less environments: spawn npm.cmd ENOENT.
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        try {
          const fallback = spawnViaNodeNpmCli();
          child.stdout?.removeAllListeners();
          child.stderr?.removeAllListeners();
          child.removeAllListeners();
          child = fallback;
          child.stdout?.on("data", (chunk) => pushCapped(out, chunk.toString()));
          child.stderr?.on("data", (chunk) => pushCapped(err, chunk.toString()));
          child.on("error", reject);
          child.on("exit", (code, signal) => {
            resolve({
              pid: child.pid,
              exitCode: code,
              signal,
              elapsedMs: Date.now() - start,
              stdoutTail: out.join(""),
              stderrTail: err.join(""),
            });
          });
          return;
        } catch (fallbackErr) {
          reject(fallbackErr);
          return;
        }
      }
      reject(err);
    });
    child.on("exit", (code, signal) => {
      resolve({
        pid: child.pid,
        exitCode: code,
        signal,
        elapsedMs: Date.now() - start,
        stdoutTail: out.join(""),
        stderrTail: err.join(""),
      });
    });
  });
}

// ✅ NEW CHANGE — Parse marker line emitted by Playwright (managed-care-plan-match.ts)
const OHID_ELIGIBILITY_RESULT_PREFIX = "__OHID_ELIGIBILITY_RESULT__";
const OHID_ELIGIBILITY_RESULT_SUFFIX = "__END__";

// ✅ NEW CHANGE
function parseEligibilityCompanyMatchFromStdout(stdout) {
  if (typeof stdout !== "string" || !stdout.includes(OHID_ELIGIBILITY_RESULT_PREFIX)) {
    return undefined;
  }
  const start = stdout.indexOf(OHID_ELIGIBILITY_RESULT_PREFIX);
  const end = stdout.indexOf(OHID_ELIGIBILITY_RESULT_SUFFIX, start + OHID_ELIGIBILITY_RESULT_PREFIX.length);
  if (end === -1) {
    return undefined;
  }
  const jsonStr = stdout.slice(start + OHID_ELIGIBILITY_RESULT_PREFIX.length, end);
  try {
    return JSON.parse(jsonStr);
  } catch {
    return undefined;
  }
}

/**
 * Runs the OHID Playwright login flow as a Temporal activity.
 * This executes `npm run login:ohid` in the worker process environment.
 *
 * @param {{
 *   runId?: string;
 *   medicateSearch?: {
 *     medicaidBillingNumber: string;
 *     dateOfBirth: string;
 *     fromDos: string;
 *     toDos: string;
 *     companyName?: string;
 *   };
 * }} input
 */
export async function runOhidLogin(input) {
  const runId = input?.runId ? String(input.runId) : "";
  if (globalThis.__OHID_ACTIVITY_RUNNING__ === true) {
    throw new Error("OHID login already running in this worker process.");
  }
  globalThis.__OHID_ACTIVITY_RUNNING__ = true;
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  try {
    log.info("Starting OHID Playwright (npm run login:ohid)");
    console.log("[OHID][activity] Starting OHID Playwright (npm run login:ohid)");
    /** @type {Record<string, string>} */
    const envOverrides = {};
    if (runId) {
      envOverrides.OHID_WORKFLOW_RUN_ID = runId;
    }
    if (
      input?.medicateSearch &&
      typeof input.medicateSearch.medicaidBillingNumber === "string" &&
      typeof input.medicateSearch.dateOfBirth === "string" &&
      typeof input.medicateSearch.fromDos === "string" &&
      typeof input.medicateSearch.toDos === "string"
    ) {
      envOverrides.OHID_MEDICATE_SEARCH_JSON = JSON.stringify(input.medicateSearch);
      console.log("[OHID][activity] medicateSearch payload present (OHID_MEDICATE_SEARCH_JSON).");
      // Hold after Search is only OHID_MEDICATE_HOLD_AFTER_SEARCH_MS in ohid-login — avoid stacking DASHBOARD_STAY_MS too.
      envOverrides.OHID_STAY_MS = "0";
      envOverrides.DASHBOARD_STAY_MS = "0";
    }
    const res = await runNpmScript("login:ohid", Object.keys(envOverrides).length ? envOverrides : undefined);
    if (res.exitCode !== 0) {
      const msg = `OHID Playwright failed (exitCode=${res.exitCode}, signal=${res.signal ?? ""}).`;
      console.error("[OHID][activity]", msg);
      globalThis.__OHID_LAST_ACTIVITY__ = {
        kind: "ohid",
        runId,
        startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        exitCode: res.exitCode,
        signal: res.signal,
        stderrTail: res.stderrTail,
        stdoutTail: res.stdoutTail,
      };
      throw new Error(`${msg}\n\nstderr:\n${res.stderrTail}\n\nstdout:\n${res.stdoutTail}`);
    }

    // ✅ NEW CHANGE: Eligibility company match from Playwright stdout (visible in Temporal activity logs)
    const eligibilityCompanyMatch = parseEligibilityCompanyMatchFromStdout(res.stdoutTail);
    if (eligibilityCompanyMatch != null) {
      log.info("Playwright eligibility company match", {
        match: eligibilityCompanyMatch.match,
        inputCompanyName: eligibilityCompanyMatch.inputCompanyName,
        uiCompanyName: eligibilityCompanyMatch.uiCompanyName,
        success: eligibilityCompanyMatch.success,
        message: eligibilityCompanyMatch.message,
      });
      console.log("[OHID][activity] ----- PLAYWRIGHT RESULT -----");
      console.log("[OHID][activity] UI Company:", eligibilityCompanyMatch.uiCompanyName);
      console.log("[OHID][activity] Input Company:", eligibilityCompanyMatch.inputCompanyName);
      console.log("[OHID][activity] Match:", eligibilityCompanyMatch.match);
      console.log("[OHID][activity] -----------------------------");
    }

    globalThis.__OHID_LAST_ACTIVITY__ = {
      kind: "ohid",
      runId,
      startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
      finishedAt: new Date().toISOString(),
      status: "succeeded",
      pid: res.pid,
      elapsedMs: res.elapsedMs,
      stdoutTail: res.stdoutTail,
      // ✅ NEW CHANGE
      eligibilityCompanyMatch: eligibilityCompanyMatch ?? null,
    };
    return {
      ok: true,
      elapsedMs: res.elapsedMs,
      pid: res.pid,
      stdoutTail: res.stdoutTail,
      // ✅ NEW CHANGE
      ...(eligibilityCompanyMatch != null ? { eligibilityCompanyMatch } : {}),
    };
  } finally {
    globalThis.__OHID_ACTIVITY_RUNNING__ = false;
  }
}

/** Availity Essentials login (SPA). See https://essentials.availity.com/ */
const LOGIN_URL =
  process.env.AVAILITY_LOGIN_URL?.trim() ||
  "https://essentials.availity.com/static/public/onb/onboarding-ui-apps/availity-fr-ui/#/login";

const OTP_INPUT_SELECTORS = [
  "input#input__email_verification_pin",
  'input[name="pin"]',
  'input[inputmode="numeric"]',
  'input[autocomplete="one-time-code"]',
  'input[aria-label*="code" i]',
  'input[aria-label*="verification" i]',
  'input[aria-label*="one-time" i]',
];

function isAvailityHost(url) {
  return /essentials\.availity\.com/i.test(url);
}

/** Logged in: on Availity host and hash route is no longer the login screen. */
function isAvailityPostLogin(url) {
  if (!isAvailityHost(url)) return false;
  if (/#\/?login\b/i.test(url)) return false;
  return true;
}

function looksLikeOtpOrMfaPage(url) {
  const u = url.toLowerCase();
  return (
    /(mfa|verify|otp|challenge|2fa|one[-_]time|authenticat)/i.test(u) ||
    (isAvailityHost(url) && /#\/(verify|mfa|otp)/i.test(u))
  );
}

function envString(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v.trim();
}

function userId() {
  return envString("AVAILITY_USER_ID", envString("LINKEDIN_EMAIL", envString("LI_AT")));
}

function password() {
  return envString("AVAILITY_PASSWORD", envString("LINKEDIN_PASSWORD", envString("LI_PW")));
}

function sessionPath() {
  const p = envString("SESSION_STORAGE_PATH");
  if (!p) return join(PROJECT_ROOT, ".availity-session.json");
  return isAbsolute(p) ? p : join(PROJECT_ROOT, p);
}

function pendingStoragePathForWorkflow(workflowId) {
  const base = envString("SESSION_DATA_DIR");
  const dir = base
    ? isAbsolute(base)
      ? base
      : join(PROJECT_ROOT, base)
    : join(PROJECT_ROOT, "data", "availity-sessions");
  return join(dir, `${workflowId}-pending.json`);
}

async function pathExists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function launchContext(storageStatePath) {
  const headless = process.env.HEADLESS === "true";
  const slowMo = Number(process.env.SLOW_MO_MS ?? "0");
  const launchOpts = { headless };
  const channel = envString("CHROME_CHANNEL");
  if (channel) launchOpts.channel = channel;
  if (Number.isFinite(slowMo) && slowMo > 0) {
    launchOpts.slowMo = slowMo;
  }
  const browser = await chromium.launch(launchOpts);
  const statePath = storageStatePath && (await pathExists(storageStatePath)) ? storageStatePath : undefined;
  const context = await browser.newContext(
    statePath ? { storageState: statePath } : {},
  );
  return { browser, context };
}

async function dismissCookieBannerIfPresent(page) {
  try {
    const btn = page.getByRole("button", { name: /accept/i }).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
    }
  } catch {
    /* ignore */
  }
}

async function isOtpUiVisible(page) {
  for (const sel of OTP_INPUT_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      return loc;
    }
  }
  return null;
}

/**
 * @param {{ workflowId: string }} input
 */
export async function pollOtpFromStore(input) {
  const { workflowId } = input;
  const row = await peekOtp(workflowId);
  if (row?.otp && String(row.otp).trim().length >= 4) {
    log.info("OTP received from Twilio");
    console.log("OTP received from Twilio");
    return { found: true, otp: String(row.otp).trim() };
  }
  return { found: false };
}

/**
 * @param {{ workflowId: string }} input
 */
export async function performLoginAttempt(input) {
  const { workflowId } = input;
  const uid = userId();
  const pw = password();
  if (!uid || !pw) {
    throw new Error(
      "Set AVAILITY_USER_ID and AVAILITY_PASSWORD (or LINKEDIN_EMAIL / LINKEDIN_PASSWORD or LI_AT / LI_PW).",
    );
  }

  log.info("Starting login");
  console.log("Starting login");

  const finalSession = sessionPath();
  const pendingPath = pendingStoragePathForWorkflow(workflowId);
  await mkdir(dirname(pendingPath), { recursive: true });

  const { browser, context } = await launchContext(finalSession);
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await dismissCookieBannerIfPresent(page);

    if (isAvailityPostLogin(page.url())) {
      await mkdir(dirname(finalSession), { recursive: true });
      await context.storageState({ path: finalSession });
      log.info("Login successful");
      console.log("Login successful");
      return { outcome: "SUCCESS" };
    }

    await page.getByLabel("User ID").fill(uid, { timeout: 30_000 });
    await page.getByRole("textbox", { name: "Password" }).fill(pw, { timeout: 30_000 });

    const navigation = page
      .waitForURL(
        (u) => isAvailityPostLogin(u.href) || looksLikeOtpOrMfaPage(u.href),
        { timeout: 90_000 },
      )
      .catch(() => null);

    await page.locator('button[type="submit"]').first().click();
    await navigation;
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => null);

    const url = page.url();
    if (isAvailityPostLogin(url)) {
      await mkdir(dirname(finalSession), { recursive: true });
      await context.storageState({ path: finalSession });
      log.info("Login successful");
      console.log("Login successful");
      return { outcome: "SUCCESS" };
    }

    const otpInput = await isOtpUiVisible(page);
    const onChallenge = looksLikeOtpOrMfaPage(url) || Boolean(otpInput);

    if (onChallenge) {
      await context.storageState({ path: pendingPath });
      log.info("OTP required");
      console.log("OTP required");
      return {
        outcome: "OTP_REQUIRED",
        pendingPath,
        challengeUrl: url,
      };
    }

    const msg = `Unexpected state after login (url: ${url})`;
    log.warn(msg);
    return { outcome: "FAILURE", message: msg };
  } finally {
    await browser.close();
  }
}

/**
 * @param {{ otp: string, pendingPath: string, challengeUrl: string, workflowId: string }} input
 */
export async function submitOtpAndConfirm(input) {
  const { otp, pendingPath, challengeUrl, workflowId } = input;
  if (!otp || !String(otp).trim()) {
    throw new Error("OTP is required");
  }

  log.info("Entering OTP");
  console.log("Entering OTP");

  const finalSession = sessionPath();
  await mkdir(dirname(finalSession), { recursive: true });

  const { browser, context } = await launchContext(pendingPath);
  const page = await context.newPage();

  try {
    const target = challengeUrl && challengeUrl.length > 0 ? challengeUrl : LOGIN_URL;
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 });

    let otpLocator = await isOtpUiVisible(page);
    if (!otpLocator) {
      for (const sel of OTP_INPUT_SELECTORS) {
        try {
          await page.waitForSelector(sel, { state: "visible", timeout: 15_000 });
          otpLocator = page.locator(sel).first();
          break;
        } catch {
          /* try next */
        }
      }
    }
    if (!otpLocator) {
      throw new Error("Could not find OTP input on challenge page.");
    }

    await otpLocator.fill(String(otp).trim(), { timeout: 15_000 });

    const submit = page.getByRole("button", { name: /verify|submit|continue|sign in/i }).first();
    await submit.click({ timeout: 15_000 }).catch(async () => {
      await page.locator('button[type="submit"]').first().click({ timeout: 10_000 });
    });

    await page.waitForURL((u) => isAvailityPostLogin(u.href), { timeout: 120_000 });
    await context.storageState({ path: finalSession });
    await clearOtp(workflowId);
    log.info("Login successful");
    console.log("Login successful");
    return { outcome: "SUCCESS" };
  } finally {
    await browser.close();
  }
}
