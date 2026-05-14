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
  ohidAddInsurancePolicy,
  ohidAddPatientStickyNote,
} =
  proxyActivities({
    startToCloseTimeout: "20 minutes",
    retry: {
      maximumAttempts: 1,
    },
  });

/**
 * Subtract one calendar month from a date string in MM/DD/YYYY format.
 * Deterministic — safe to call inside a Temporal workflow.
 * @param {string} mmddyyyy  e.g. "11/05/2025"
 * @returns {string}         e.g. "10/05/2025"
 */
function subtractOneMonthMmDdYyyy(mmddyyyy) {
  const parts = mmddyyyy.split("/");
  let month = parseInt(parts[0], 10);
  const day = parts[1] ?? "01";
  let year = parseInt(parts[2], 10);
  month -= 1;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return `${String(month).padStart(2, "0")}/${day}/${year}`;
}

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
 *   magiMentalHealthCheck?: object | null;
 *   magiFirstSearch?: object | null;
 *   magiFirstSearchMessage?: string | null;
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
  // Second eligibility search (DOS −1 month) runs **only** when the **first** scrape has: company did
  // not match AND no MAGI Mental Health Under Benefit/Assignment plan (see ohid-login.ts + magi-mental-health-assignment.js).
  // If the first scrape already matches the requested company, Playwright skips research; workflow uses LookupData + NonEncounterTask.
  const __play = await ohidPlaywrightEligibility({ runId, medicateSearch });
  const __parsed = await ohidParseEligibility({ runId, stdoutTail: __play.stdoutTail });

  const __magiCheck = __parsed?.magiMentalHealthCheck ?? null;
  const __magiFirst = __parsed?.magiFirstSearch ?? null;
  const __magiFirstMsg =
    __magiFirst != null &&
    typeof __magiFirst === "object" &&
    "message" in __magiFirst &&
    typeof __magiFirst.message === "string"
      ? __magiFirst.message
      : null;

  /** True when Playwright ran prior-month DOS research (second eligibility search). */
  const secondSearchProcessed =
    __magiFirst != null &&
    typeof __magiFirst === "object" &&
    "researchRan" in __magiFirst &&
    __magiFirst.researchRan === true;

  const __se = __parsed?.searchEligibility ?? null;
  const __recipient = __parsed?.recipientInformation ?? null;
  const __em =
    __parsed?.eligibilityCompanyMatch ??
    (__se && typeof __se === "object" ? __se.companyMatch : null) ??
    null;

  const companyNameMatched =
    __em != null && typeof __em === "object" && "match" in __em && __em.match === true;

  /** Company name was provided and UI did not match (same idea as "Company name did not match …"). */
  const companyEvaluatedNoMatch =
    __em != null &&
    typeof __em === "object" &&
    "match" in __em &&
    __em.match === false &&
    String(__em.inputCompanyName ?? "").trim() !== "";

  /** Final parsed eligibility: patient does NOT have strict MAGI Mental Health Under Benefit/Assignment row. */
  const noMagiPerFinalParse =
    __magiCheck != null &&
    typeof __magiCheck === "object" &&
    "found" in __magiCheck &&
    __magiCheck.found === false;

  /**
   * After DOS −1 month research, the **last** scrape can show MAGI even when the **first** did not.
   * Still run BillingAuth → InsurancePolicy → StickyNote when the first search + company state matched
   * "Company name did not match — patient does NOT have MAGI: Mental Health Under Benefit/Assignment Plan."
   */
  const noMagiPerFirstSearchWhenResearched =
    __magiFirst != null &&
    typeof __magiFirst === "object" &&
    __magiFirst.researchRan === true &&
    __magiFirst.hadMagiMentalHealthUnderBenefitAssignment === false &&
    companyEvaluatedNoMatch;

  const runBillingWhenCompanyNoMatchAndNoMagi =
    noMagiPerFinalParse || noMagiPerFirstSearchWhenResearched;

  /** Sticky note generator: prefer final `magiMentalHealthCheck`; else first-search summary message. */
  const magiForStickyNote =
    noMagiPerFinalParse && __magiCheck != null
      ? __magiCheck
      : noMagiPerFirstSearchWhenResearched
        ? {
            checked: true,
            found: false,
            plan: null,
            message:
              typeof __magiFirstMsg === "string" && __magiFirstMsg.trim()
                ? __magiFirstMsg
                : "Company name did not match — patient does NOT have MAGI: Mental Health Under Benefit/Assignment Plan.",
          }
        : __magiCheck;
  /** @type {{ ok: true; token: string } | { ok: false; error: string; status?: number } | { skipped: true; reason: string }} */
  let __billingAuth = { skipped: true, reason: "BillingAuth not run yet" };
  /** @type {{ taskCategories: unknown; priorities: unknown } | null} */
  let __lookup = null;
  /** @type {unknown | null} */
  let __nonEncounterTaskAdd = null;
  /** @type {unknown | null} */
  let __insurancePolicy = null;
  /** @type {unknown | null} */
  let __stickyNote = null;

  if (!companyNameMatched) {
    const _noMatchReason =
      __em == null
        ? "Company match not evaluated (provide medicateSearch.companyName); BillingAuth / LookupData / NonEncounterTask not called."
        : "Company name did not match; BillingAuth / LookupData / NonEncounterTask not called.";
    __billingAuth = { skipped: true, reason: _noMatchReason };
    __nonEncounterTaskAdd = { skipped: true, reason: _noMatchReason };

    // Insurance + Sticky only after **second search** (research). First-only no-match path does not call them.
    if (secondSearchProcessed && runBillingWhenCompanyNoMatchAndNoMagi) {
      log.info(
        "Second eligibility search completed — fetching BillingAuth for InsurancePolicy and PatientStickyNote",
      );
      __billingAuth = await ohidFetchBillingAuth();

      const atcJwt =
        __billingAuth != null &&
        typeof __billingAuth === "object" &&
        "ok" in __billingAuth &&
        __billingAuth.ok &&
        "token" in __billingAuth &&
        typeof __billingAuth.token === "string"
          ? __billingAuth.token
          : null;

      if (!atcJwt) {
        let err = "BillingAuth did not return a token.";
        if (__billingAuth != null && typeof __billingAuth === "object") {
          if ("error" in __billingAuth && typeof __billingAuth.error === "string" && __billingAuth.error.trim()) {
            err = __billingAuth.error;
          } else if ("reason" in __billingAuth && typeof __billingAuth.reason === "string") {
            err = __billingAuth.reason;
          }
        }
        log.info("BillingAuth failed; skipping InsurancePolicy and PatientStickyNote", { err });
        __insurancePolicy = { ok: false, error: err, step: "billingAuth" };
        __stickyNote = { ok: false, error: err, step: "billingAuth" };
      } else {
        log.info("Post-research path — calling InsurancePolicy API");
        __insurancePolicy = await ohidAddInsurancePolicy({ jwt: atcJwt });

        log.info("Post-research path — generating note and posting to PatientStickyNote");
        __stickyNote = await ohidAddPatientStickyNote({
          jwt: atcJwt,
          recipientInformation: __recipient,
          benefitAssignmentPlans: __se?.benefitAssignmentPlans ?? [],
          eligibilityCompanyMatch: __em,
          magiMentalHealthCheck: magiForStickyNote,
        });
      }
    } else {
      const _skipReason = secondSearchProcessed
        ? "Second search ran but final eligibility no longer qualifies for InsurancePolicy/StickyNote (e.g. MAGI Mental Health Under Benefit/Assignment found on final scrape)."
        : "InsurancePolicy/StickyNote run only after second eligibility search (company did not match and no MAGI Mental Health Under Benefit/Assignment on first search).";
      __insurancePolicy = { skipped: true, reason: _skipReason };
      __stickyNote = { skipped: true, reason: _skipReason };
    }
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
      if (secondSearchProcessed) {
        log.info(
          "Company matched after second eligibility search (DOS research) — skipping LookupData/NonEncounterTask; calling InsurancePolicy and PatientStickyNote",
        );
        __nonEncounterTaskAdd = {
          skipped: true,
          reason:
            "Skipped: second eligibility search completed — using InsurancePolicy/PatientStickyNote instead of LookupData/NonEncounterTask.",
        };
        log.info("Research path — calling InsurancePolicy API");
        __insurancePolicy = await ohidAddInsurancePolicy({ jwt });
        log.info("Research path — generating OpenAI note and posting to PatientStickyNote");
        __stickyNote = await ohidAddPatientStickyNote({
          jwt,
          recipientInformation: __recipient,
          benefitAssignmentPlans: __se?.benefitAssignmentPlans ?? [],
          eligibilityCompanyMatch: __em,
          magiMentalHealthCheck:
            __magiCheck != null
              ? __magiCheck
              : {
                  checked: true,
                  found: false,
                  plan: null,
                  message:
                    typeof __magiFirstMsg === "string" && __magiFirstMsg.trim()
                      ? __magiFirstMsg
                      : "Managed care company matched after eligibility research (second search; prior-month DOS).",
                },
        });
      } else {
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
      }
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
    ...(__magiCheck != null ? { magiMentalHealthCheck: __magiCheck } : {}),
    ...(__magiFirst != null ? { magiFirstSearch: __magiFirst } : {}),
    ...(__magiFirstMsg ? { magiFirstSearchMessage: __magiFirstMsg } : {}),
    billingAuth: __billingAuth,
    billingJwtToken,
    lookupData: __lookup != null && typeof __lookup === "object" ? __lookup : null,
    nonEncounterTaskAdd:
      __nonEncounterTaskAdd != null && typeof __nonEncounterTaskAdd === "object"
        ? __nonEncounterTaskAdd
        : null,
    insurancePolicy:
      __insurancePolicy != null && typeof __insurancePolicy === "object"
        ? __insurancePolicy
        : null,
    stickyNote:
      __stickyNote != null && typeof __stickyNote === "object"
        ? __stickyNote
        : null,
  };
}
