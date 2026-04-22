import type { BrowserContext, Page } from "playwright";
// JS module — see otpStore.js.d.ts (NodeNext + .js import resolution)
// @ts-expect-error TS module resolution for ../otpStore.js
import { clearOtp, peekOtp } from "../otpStore.js";
import { ohidOtpWorkflowId } from "./otp-api.js";
import { pollWithBackoffUntil } from "./utils.js";

type OhidPnmMfaTimeouts = {
  pnmMfaChoose: number;
  otpFieldWait: number;
  otpWait: number;
  otpPoll: number;
  fillAction: number;
};

/**
 * After clicking "Open" on PNM, OHID may show a "Two-step verification — Choose a method" page
 * (url contains ohid.verify.ohio.gov/authsvc…macotp…) before reaching the PNM app/Terms page.
 *
 * If that page appears within OH.pnmMfaChoose ms:
 *   1. Click "Send code" (email preferred; set OHID_MFA_METHOD=sms for SMS).
 *   2. Poll the OTP file store (same as POST /ingest-otp) until code arrives.
 *   3. Fill and submit the code.
 *
 * If the page does NOT appear (regular sessions) the function returns immediately and the caller
 * continues to the Terms/acceptance flow unchanged.
 */
export async function handlePnmMfaIfPresent(context: BrowserContext, OH: OhidPnmMfaTimeouts): Promise<void> {
  const mfaUrlPattern = /ohid\.verify\.ohio\.gov.*authsvc/i;
  const chooseHeadingPattern = /Choose a method/i;
  const twoStepPattern = /Two.?step verification/i;

  async function findMfaPage(): Promise<Page | null> {
    for (const p of context.pages().filter((pg) => !pg.isClosed())) {
      if (mfaUrlPattern.test(p.url())) {
        return p;
      }
      const heading = p.getByRole("heading", { name: chooseHeadingPattern }).or(
        p.getByText(twoStepPattern),
      );
      if (await heading.first().isVisible({ timeout: 300 }).catch(() => false)) {
        return p;
      }
    }
    return null;
  }

  const deadline = Date.now() + OH.pnmMfaChoose;
  let mfaPage: Page | null = null;
  while (Date.now() < deadline) {
    mfaPage = await findMfaPage();
    if (mfaPage) break;
    await new Promise<void>((r) => setTimeout(r, 350));
  }

  if (!mfaPage) {
    return;
  }

  const otpWorkflowIdForPnm = ohidOtpWorkflowId();
  // Without an API OTP workflow id, automated Send code + /ingest-otp cannot complete — let the user finish MFA in the browser.
  if (!otpWorkflowIdForPnm) {
    console.warn(
      "[OHID] Two-step verification detected. No OHID_WORKFLOW_RUN_ID (use POST /start-ohid-login or set OHID_OTP_WORKFLOW_ID) — complete verification in the browser; script will wait for the PNM terms checkbox.",
    );
    return;
  }

  console.log("[OHID] Two-step verification (Choose a method) detected — clicking Send code…");

  const preferMethod = (process.env.OHID_MFA_METHOD ?? "email").toLowerCase();

  // "Send code" links are inline with Email / Text message rows.
  // Strategy: find the row that contains the preferred method text, pick its "Send code" link.
  const emailSend = mfaPage
    .locator("*")
    .filter({ hasText: /^Email$/i })
    .locator("xpath=following::a[1]")
    .filter({ hasText: /Send code/i })
    .first();
  const smsSend = mfaPage
    .locator("*")
    .filter({ hasText: /^Text message$/i })
    .locator("xpath=following::a[1]")
    .filter({ hasText: /Send code/i })
    .first();
  // Fallback: any "Send code" link on the page (first = email in the screenshot).
  const anySend = mfaPage.getByRole("link", { name: /Send code/i }).first();

  const sendCandidates =
    preferMethod === "sms"
      ? [smsSend, emailSend, anySend]
      : [emailSend, smsSend, anySend];

  let sent = false;
  for (const c of sendCandidates) {
    try {
      if ((await c.count()) === 0) continue;
      await c.click({ timeout: 8_000 });
      sent = true;
      console.log("[OHID] Send code clicked.");
      break;
    } catch {
      // try next candidate
    }
  }
  if (!sent) {
    console.warn("[OHID] Could not click Send code — attempting to continue anyway.");
  }

  // OTP input appears on the same page after "Send code".
  const otpInput = mfaPage
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

  await otpInput.waitFor({ state: "visible", timeout: OH.otpFieldWait });
  console.log("[OHID] OTP input visible on MFA page.");

  console.log(`[OHID] Waiting for OTP from POST /ingest-otp (workflowId=${otpWorkflowIdForPnm})…`);

  const otpDeadline = Date.now() + OH.otpWait;
  await pollWithBackoffUntil(otpDeadline, OH.otpPoll, async () => {
    const row = await peekOtp(otpWorkflowIdForPnm);
    if (!(row?.otp && String(row.otp).trim().length >= 4)) return false;

    const code = String(row.otp).trim();
    await otpInput.fill(code);

    const submitBtn = mfaPage
      .getByRole("button", { name: /verify|continue|submit|next|sign[\s-]*in/i })
      .first();
    if ((await submitBtn.count()) > 0) {
      await submitBtn.click({ timeout: OH.fillAction });
    } else {
      await mfaPage.locator('button[type="submit"]').first().click({ timeout: OH.fillAction });
    }

    await mfaPage
      .waitForLoadState("domcontentloaded", { timeout: 30_000 })
      .catch(() => undefined);
    await clearOtp(otpWorkflowIdForPnm).catch(() => undefined);
    console.log("[OHID] PNM MFA OTP submitted — continuing to Terms page…");
    return true;
  });

  throw new Error(
    `[OHID] Timed out waiting for OTP (POST /ingest-otp) for PNM two-step verification. workflowId=${otpWorkflowIdForPnm}`,
  );
}
