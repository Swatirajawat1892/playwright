import type { Page } from "playwright";
// JS module — see otpStore.js.d.ts (NodeNext + .js import resolution)
// @ts-expect-error TS module resolution for ../otpStore.js
import { clearOtp, peekOtp } from "../otpStore.js";
import { pollWithBackoffUntil } from "./utils.js";

type OhidTimeoutsSubset = {
  otpFieldWait: number;
  otpWait: number;
  otpPoll: number;
  fillAction: number;
};

export function ohidOtpWorkflowId(): string | undefined {
  const w = process.env.OHID_WORKFLOW_RUN_ID?.trim() || process.env.OHID_OTP_WORKFLOW_ID?.trim();
  return w || undefined;
}

/**
 * After password submit, if an MFA/OTP field appears, poll `otpStore` until POST /ingest-otp delivers a code.
 * Requires OHID_WORKFLOW_RUN_ID (set by Temporal `runOhidLogin`) or OHID_OTP_WORKFLOW_ID for local testing.
 */
export async function handleOhidOtpFromStoreIfNeeded(page: Page, OH: OhidTimeoutsSubset): Promise<void> {
  if (process.env.OHID_OTP_FROM_API === "false") {
    return;
  }
  const workflowId = ohidOtpWorkflowId();
  if (!workflowId) {
    console.log(
      "[OHID] No OHID_WORKFLOW_RUN_ID — skipping Gmail/API OTP (set by Temporal when using POST /start-ohid-login).",
    );
    return;
  }

  const otpInput = page
    .locator(
      [
        'input[inputmode="numeric"]',
        'input[autocomplete="one-time-code"]',
        'input[type="tel"]',
        'input[name*="otp" i]',
        'input[name*="code" i]',
        'input[id*="otp" i]',
        'input[id*="code" i]',
        'input[aria-label*="code" i]',
        'input[aria-label*="verification" i]',
      ].join(", "),
    )
    .first();

  const appeared = await otpInput.waitFor({ state: "visible", timeout: OH.otpFieldWait }).catch(() => null);
  if (!appeared) {
    console.log("[OHID] No MFA/OTP field in time — continuing (no API OTP).");
    return;
  }

  console.log(`[OHID] MFA/OTP field visible — waiting for POST /ingest-otp (workflowId=${workflowId})…`);

  const deadline = Date.now() + OH.otpWait;
  await pollWithBackoffUntil(deadline, OH.otpPoll, async () => {
    const row = await peekOtp(workflowId);
    if (!(row?.otp && String(row.otp).trim().length >= 4)) return false;

    const code = String(row.otp).trim();
    await otpInput.fill(code);
    const submit = page.getByRole("button", { name: /verify|continue|submit|next|sign\s*in/i }).first();
    if ((await submit.count()) > 0) {
      await submit.click({ timeout: OH.fillAction });
    } else {
      await page.locator('button[type="submit"]').first().click({ timeout: OH.fillAction });
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    await clearOtp(workflowId).catch(() => undefined);
    console.log("[OHID] Submitted OTP from API store.");
    return true;
  });

  throw new Error(
    `Timed out waiting for OTP (POST /ingest-otp) for workflowId=${workflowId}. Check n8n and OTP_INGEST_API_KEY.`,
  );
}
