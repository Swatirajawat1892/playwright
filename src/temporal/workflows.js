/**
 * Availity login: OTP from Twilio webhook → otpStore → Temporal polling (30s) up to ~2 min.
 */
import {
  ApplicationFailure,
  log,
  proxyActivities,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";

/** @typedef {{ outcome: string, pendingPath?: string, challengeUrl?: string, message?: string }} LoginAttemptResult */

const POLL_INTERVAL = "30s";
const MAX_POLL_ATTEMPTS = 5;

const { performLoginAttempt, submitOtpAndConfirm } = proxyActivities({
  startToCloseTimeout: "12 minutes",
  retry: {
    maximumAttempts: 4,
    initialInterval: "3s",
    backoffCoefficient: 2,
    maximumInterval: "45s",
  },
});

const { pollOtpFromStore } = proxyActivities({
  startToCloseTimeout: "30 seconds",
  retry: {
    maximumAttempts: 5,
    initialInterval: "1s",
    backoffCoefficient: 2,
    maximumInterval: "10s",
  },
});

const { runOhidLogin } = proxyActivities({
  startToCloseTimeout: "20 minutes",
  retry: {
    maximumAttempts: 1,
  },
});

const {
  ohidPlaywrightLogin,
  ohidPlaywrightEligibility,
  ohidParseEligibility,
  ohidFetchBillingAuth,
  ohidFetchLookupData,
  ohidAddNonEncounterTask,
} =
  proxyActivities({
    startToCloseTimeout: "20 minutes",
    retry: {
      maximumAttempts: 1,
    },
  });

/**
 * @param {Record<string, never>} _input
 * @returns {Promise<{ success: boolean }>}
 */
export async function availityLoginWorkflow(_input) {
  const workflowId = workflowInfo().workflowId;

  /** @type {LoginAttemptResult} */
  const attempt = await performLoginAttempt({ workflowId });

  if (attempt.outcome === "SUCCESS") {
    return { success: true };
  }

  if (attempt.outcome === "FAILURE") {
    throw ApplicationFailure.create({
      message: attempt.message ?? "Login failed",
      nonRetryable: true,
    });
  }

  if (attempt.outcome !== "OTP_REQUIRED" || !attempt.pendingPath) {
    throw ApplicationFailure.create({
      message: `Unexpected login outcome: ${attempt.outcome}`,
      nonRetryable: true,
    });
  }

  log.info("OTP required");
  log.info("Waiting for OTP");

  /** @type {string | undefined} */
  let otp;

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const poll = await pollOtpFromStore({ workflowId });
    if (poll.found && poll.otp) {
      otp = poll.otp;
      break;
    }
    if (i === MAX_POLL_ATTEMPTS - 1) {
      break;
    }
    await sleep(POLL_INTERVAL);
  }

  if (!otp) {
    throw ApplicationFailure.create({
      message: "OTP not received within 2 minutes (Twilio / store)",
      nonRetryable: true,
    });
  }

  await submitOtpAndConfirm({
    otp,
    pendingPath: attempt.pendingPath,
    challengeUrl: attempt.challengeUrl ?? "",
    workflowId,
  });

  return { success: true };
}

/**
 * OHID login (Playwright) as a Temporal workflow.
 * Single execution: one `runOhidLogin` activity (activity retry policy is maximumAttempts: 1).
 * To run again, POST /medicate-availability-check again (new workflow id).
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
 * } | Record<string, never>} input
 * @returns {Promise<{
 *   ok: true;
 *   attempts: 1;
 *   searchEligibility: object | null;
 *   eligibilityCompanyMatch: object | null;
 *   billingAuth: { ok: true; token: string } | { ok: false; error: string; status?: number } | { skipped: true; reason: string };
 *   billingJwtToken: string | null;
 *   lookupData?: { taskCategories: object; priorities: object } | null;
 * }>}
 */
export async function ohidLoginWorkflow(input) {
  const runId = typeof input?.runId === "string" ? input.runId : workflowInfo().workflowId;
  const medicateSearch =
    input?.medicateSearch &&
    typeof input.medicateSearch.medicaidBillingNumber === "string" &&
    typeof input.medicateSearch.dateOfBirth === "string" &&
    typeof input.medicateSearch.fromDos === "string" &&
    typeof input.medicateSearch.toDos === "string"
      ? {
          medicaidBillingNumber: input.medicateSearch.medicaidBillingNumber,
          dateOfBirth: input.medicateSearch.dateOfBirth,
          fromDos: input.medicateSearch.fromDos,
          toDos: input.medicateSearch.toDos,
          ...(typeof input.medicateSearch.companyName === "string" &&
          input.medicateSearch.companyName.trim() !== ""
            ? { companyName: input.medicateSearch.companyName.trim() }
            : {}),
        }
      : undefined;

  log.info("Workflow started", {
    runId,
    hasMedicateSearch: !!medicateSearch,
    inputCompanyName: medicateSearch?.companyName ?? null,
  });

  // Split into multiple activities so Temporal Event History shows clear phases.
  await ohidPlaywrightLogin({ runId });
  // Keep PNM + Eligibility as ONE Temporal activity event.
  // The eligibility step will resume via run-state (lastUrl) when available,
  // otherwise it falls back to normal navigation (My Apps → Open PNM → Eligibility).
  const __play = await ohidPlaywrightEligibility({ runId, medicateSearch });
  const __parsed = await ohidParseEligibility({ runId, stdoutTail: __play.stdoutTail });

  const __se = __parsed?.searchEligibility ?? null;
  const __recipient = __parsed?.recipientInformation ?? null;
  const __em =
    __parsed?.eligibilityCompanyMatch ??
    (__se && typeof __se === "object" ? __se.companyMatch : null) ??
    null;

  const companyNameMatched =
    __em != null && typeof __em === "object" && "match" in __em && __em.match === true;

  /** @type {{ ok: true; token: string } | { ok: false; error: string; status?: number } | { skipped: true; reason: string }} */
  let __billingAuth = { skipped: true, reason: "BillingAuth not run yet" };
  /** @type {{ taskCategories: unknown; priorities: unknown } | null} */
  let __lookup = null;
  /** @type {unknown | null} */
  let __nonEncounterTaskAdd = null;

  if (!companyNameMatched) {
    __billingAuth = {
      skipped: true,
      reason:
        __em == null
          ? "Company match not evaluated (provide medicateSearch.companyName); BillingAuth / LookupData / NonEncounterTask not called."
          : "Company name did not match; BillingAuth / LookupData / NonEncounterTask not called.",
    };
    __nonEncounterTaskAdd = { skipped: true, reason: __billingAuth.reason };
  } else {
    __billingAuth = await ohidFetchBillingAuth();
    const jwt =
      __billingAuth != null &&
      typeof __billingAuth === "object" &&
      "ok" in __billingAuth &&
      __billingAuth.ok &&
      "token" in __billingAuth &&
      typeof __billingAuth.token === "string"
        ? __billingAuth.token
        : null;
    if (jwt) {
      __lookup = await ohidFetchLookupData({ jwt });
      const firstNameMi =
        __recipient != null &&
        typeof __recipient === "object" &&
        "firstNameMi" in __recipient &&
        typeof __recipient.firstNameMi === "string"
          ? __recipient.firstNameMi
          : "";
      __nonEncounterTaskAdd = await ohidAddNonEncounterTask({
        jwt,
        firstNameMi,
        screenshotPath: __parsed?.screenshotPath ?? "",
      });
    } else {
      __nonEncounterTaskAdd = { ok: false, error: "Missing billing JWT" };
    }
  }

  if (typeof __billingAuth === "object" && "ok" in __billingAuth && __billingAuth.ok) {
    log.info("Workflow result (BillingAuth JWT)", { ok: true, tokenLength: __billingAuth.token?.length ?? 0 });
  } else if (typeof __billingAuth === "object" && "skipped" in __billingAuth && __billingAuth.skipped) {
    log.info("Workflow result (BillingAuth JWT)", { skipped: true, reason: __billingAuth.reason });
  } else if (typeof __billingAuth === "object" && "ok" in __billingAuth && !__billingAuth.ok) {
    log.info("Workflow result (BillingAuth JWT)", { ok: false, error: __billingAuth.error });
  }

  if (__se != null && typeof __se === "object") {
    log.info("Workflow result (Search Eligibility JSON)", {
      benefitAssignmentPlans: __se.benefitAssignmentPlans?.length ?? 0,
      managedCarePlans: __se.managedCarePlans?.length ?? 0,
    });
  }
  if (__em != null && typeof __em === "object") {
    log.info("Workflow result (company match)", {
      match: __em.match,
      inputCompanyName: __em.inputCompanyName,
      uiCompanyName: __em.uiCompanyName,
      success: __em.success,
      message: __em.message,
    });
  }

  const billingJwtToken =
    __billingAuth != null &&
    typeof __billingAuth === "object" &&
    "ok" in __billingAuth &&
    __billingAuth.ok &&
    "token" in __billingAuth &&
    typeof __billingAuth.token === "string"
      ? __billingAuth.token
      : null;

  return {
    ok: true,
    attempts: 1,
    searchEligibility: __se ?? null,
    recipientInformation: __recipient,
    eligibilityCompanyMatch: __em ?? null,
    billingAuth: __billingAuth,
    billingJwtToken,
    lookupData: __lookup != null && typeof __lookup === "object" ? __lookup : null,
    nonEncounterTaskAdd:
      __nonEncounterTaskAdd != null && typeof __nonEncounterTaskAdd === "object"
        ? __nonEncounterTaskAdd
        : null,
  };
}
