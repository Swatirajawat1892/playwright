/**
 * Temporal activities: Availity Essentials login (Playwright) + OTP polling against otpStore.
 */
import { log } from "@temporalio/activity";
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearOtp, peekOtp } from "../otpStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

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
