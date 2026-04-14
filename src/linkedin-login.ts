import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import { chromium, type Page } from "playwright";
// otpStore is plain JS — no .d.ts
// @ts-expect-error -- moduleResolution resolves ./otpStore.js at runtime (tsx)
import { registerActiveWorkflow } from "./otpStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const LOGIN_URL =
  process.env.AVAILITY_LOGIN_URL?.trim() ||
  "https://essentials.availity.com/static/public/onb/onboarding-ui-apps/availity-fr-ui/#/login";

const DEFAULT_DASHBOARD_STAY_MS = 5 * 60 * 1000;
const AVAILITY_LOGIN_WORKFLOW = "availityLoginWorkflow";

function isAvailityHost(url: string): boolean {
  return /essentials\.availity\.com/i.test(url);
}

function isAvailityPostLogin(url: string): boolean {
  if (!isAvailityHost(url)) return false;
  if (/#\/?login\b/i.test(url)) return false;
  return true;
}

function sessionPath(): string {
  const p = process.env.SESSION_STORAGE_PATH?.trim();
  if (!p) return join(PROJECT_ROOT, ".availity-session.json");
  return isAbsolute(p) ? p : join(PROJECT_ROOT, p);
}

function firstNonEmpty(
  primary: string | undefined,
  alias: string | undefined,
  label: string,
): string {
  const value = (primary ?? alias)?.trim();
  if (!value) {
    throw new Error(
      `Missing ${label}. Set AVAILITY_USER_ID / AVAILITY_PASSWORD or LINKEDIN_EMAIL / LINKEDIN_PASSWORD (or LI_AT / LI_PW).`,
    );
  }
  return value;
}

function dashboardStayMs(): number {
  const raw = process.env.DASHBOARD_STAY_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DASHBOARD_STAY_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("DASHBOARD_STAY_MS must be a non-negative number (milliseconds).");
  }
  return n;
}

/** URL left the login hash (success dashboard or MFA / challenge). */
async function waitUntilPastLogin(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const u = window.location.href;
      if (!/essentials\.availity\.com/i.test(u)) return false;
      return !/#\/?login\b/i.test(u);
    },
    { timeout: timeoutMs },
  );
}

async function startTemporalWorkflow(): Promise<void> {
  if (process.env.TEMPORAL_AUTO_START === "false") {
    console.log("[Temporal] TEMPORAL_AUTO_START=false — skipping workflow start.");
    return;
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "availity-login";

  const workflowId =
    process.env.TEMPORAL_WORKFLOW_ID?.trim() || `availity-login-${randomUUID()}`;

  try {
    await registerActiveWorkflow(workflowId);
    const connection = await Connection.connect({ address });
    const client = new Client({ connection, namespace });
    await client.workflow.start(AVAILITY_LOGIN_WORKFLOW, {
      taskQueue,
      workflowId,
      args: [{}],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      workflowRunTimeout: "30m",
    });
    await connection.close();
    console.log(
      `[Temporal] Started workflow "${AVAILITY_LOGIN_WORKFLOW}"  id=${workflowId}  queue=${taskQueue}  @ ${address}`,
    );
    console.log(
      "[Temporal] A worker must be running (e.g. npm run start:app) or this run will sit queued until a worker polls.",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Temporal] Could not start workflow:", msg);
    console.error(
      "  Fix: temporal server start-dev  then  npm run start:app  (or npm start for embedded Temporal + app).",
    );
    console.error("  Or set TEMPORAL_AUTO_START=false to only run the browser login.");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const userId = firstNonEmpty(
    process.env.AVAILITY_USER_ID,
    process.env.LINKEDIN_EMAIL ?? process.env.LI_AT,
    "user id",
  );
  const password = firstNonEmpty(
    process.env.AVAILITY_PASSWORD,
    process.env.LINKEDIN_PASSWORD ?? process.env.LI_PW,
    "password",
  );

  const headless = process.env.HEADLESS === "true";
  const slowMoMs = Number(process.env.SLOW_MO_MS ?? "0");
  const launchOpts: { headless: boolean; slowMo?: number } = { headless };
  if (Number.isFinite(slowMoMs) && slowMoMs > 0) {
    launchOpts.slowMo = slowMoMs;
  }

  const waitMs = Number(process.env.LOGIN_WAIT_MS ?? "120000");

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });

    await page.getByLabel("User ID").fill(userId, { timeout: 30_000 });
    await page.getByRole("textbox", { name: "Password" }).fill(password, { timeout: 30_000 });
    await page.locator('button[type="submit"]').first().click();

    // Start workflow as soon as Sign In is clicked (parallel to in-page navigation / MFA).
    console.log("[Temporal] Submit clicked — starting workflow now (worker picks up in parallel)…");
    await startTemporalWorkflow();

    // SPA: wait until hash is no longer #/login (dashboard or challenge).
    await waitUntilPastLogin(page, waitMs);
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);

    const url = page.url();
    if (/#\/?login\b/i.test(url)) {
      throw new Error("Still on login after submit — check credentials or increase LOGIN_WAIT_MS.");
    }

    const finalPath = sessionPath();
    await mkdir(dirname(finalPath), { recursive: true });
    await context.storageState({ path: finalPath });

    if (isAvailityPostLogin(url)) {
      console.log("Availity login succeeded. Session saved:", finalPath);
      console.log("Current URL:", url);
    } else {
      console.log(
        "Past login screen (MFA/challenge possible). Session saved:",
        finalPath,
        "\nURL:",
        url,
      );
    }

    const stayMs = dashboardStayMs();
    if (stayMs > 0) {
      console.log(
        `Keeping browser open ${(stayMs / 60_000).toFixed(stayMs % 60_000 === 0 ? 0 : 2)} min (DASHBOARD_STAY_MS)…`,
      );
      await new Promise<void>((resolve) => {
        setTimeout(resolve, stayMs);
      });
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
