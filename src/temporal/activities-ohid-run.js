/**
 * Temporal activities: OHID Playwright runner (`npm run login:ohid`) + eligibility artifact/stdout parsing.
 */
import { log } from "@temporalio/activity";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { safeParseOhidEligibilityStdoutPayload } from "../ohid-eligibility-schema.js";
import { acquireOhidRunLock, releaseOhidRunLock } from "../ohid/run-lock.js";
import { fetchBillingAuthFromEnv } from "../billing-auth-client.js";
import { addNonEncounterTaskWithToken, fetchBillingLookupDataWithToken } from "../billing-lookup-data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

function eligibilityArtifactPath(runId) {
  const rid = typeof runId === "string" ? runId.trim() : "";
  if (!rid) return null;
  const base =
    (process.env.OHID_ELIGIBILITY_ARTIFACT_DIR || "").trim() ||
    join(PROJECT_ROOT, "data", "ohid-eligibility-results");
  const dir = isAbsolute(base) ? base : join(PROJECT_ROOT, base);
  return join(dir, `${rid}.json`);
}

async function tryReadEligibilityArtifact(runId) {
  const p = eligibilityArtifactPath(runId);
  if (!p) return null;
  try {
    const raw = JSON.parse(await readFile(p, "utf8"));
    const parsed = safeParseOhidEligibilityStdoutPayload(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

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

// Parse marker line emitted by Playwright (managed-care-plan-match.ts)
const OHID_ELIGIBILITY_RESULT_PREFIX = "__OHID_ELIGIBILITY_RESULT__";
const OHID_ELIGIBILITY_RESULT_SUFFIX = "__END__";

/** @returns {Record<string, unknown> | undefined} */
function parseOhidEligibilityResultFromStdout(stdout) {
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
    const raw = JSON.parse(jsonStr);
    const parsed = safeParseOhidEligibilityStdoutPayload(raw);
    if (parsed.success) {
      return parsed.data;
    }
    // Legacy shape support: older runs emitted just companyMatch-like object.
    if (
      raw &&
      typeof raw === "object" &&
      typeof raw.match === "boolean" &&
      typeof raw.inputCompanyName === "string"
    ) {
      return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** @param {string | undefined} stdout */
function extractSearchEligibilityScreenshotPathFromStdout(stdout) {
  if (typeof stdout !== "string" || !stdout) return null;
  const lines = stdout.split(/\r?\n/);
  /** @type {string | null} */
  let last = null;
  for (const line of lines) {
    const m = line.match(/^\[OHID\] Saved Search Eligibility screenshot:\s*(.+)$/);
    if (m) last = m[1].trim().replace(/^["']|["']$/g, "");
  }
  return last;
}

/**
 * Resolves the Search Eligibility PNG path.
 * Primary:  parse the "[OHID] Saved Search Eligibility screenshot: <path>" stdout line.
 * Fallback: find the newest PNG in the screenshot dir that contains the runId,
 *           OR (if no runId match) the newest PNG written within the last 10 minutes.
 *
 * @param {string | undefined} stdout
 * @param {string} runId
 * @returns {Promise<string | null>}
 */
async function resolveSearchEligibilityScreenshotPath(stdout, runId) {
  const fromStdout = extractSearchEligibilityScreenshotPathFromStdout(stdout);
  if (fromStdout && existsSync(fromStdout)) return fromStdout;

  const base = (process.env.OHID_SCREENSHOT_DIR || "").trim() || join(PROJECT_ROOT, "data", "ohid-screenshots");
  const absDir = isAbsolute(base) ? base : join(PROJECT_ROOT, base);
  try {
    const names = await readdir(absDir);
    const rid = typeof runId === "string" ? runId.trim() : "";
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

    /** @type {{ p: string; mtimeMs: number } | null} */
    let bestByRunId = null;
    /** @type {{ p: string; mtimeMs: number } | null} */
    let bestRecent = null;

    for (const n of names) {
      if (!n.toLowerCase().endsWith(".png")) continue;
      const p = join(absDir, n);
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) continue;

      // Primary fallback: file name contains the run ID
      if (rid && n.includes(rid)) {
        if (!bestByRunId || st.mtimeMs > bestByRunId.mtimeMs) bestByRunId = { p, mtimeMs: st.mtimeMs };
      }

      // Secondary fallback: any PNG written in the last 10 minutes
      if (st.mtimeMs >= tenMinutesAgo) {
        if (!bestRecent || st.mtimeMs > bestRecent.mtimeMs) bestRecent = { p, mtimeMs: st.mtimeMs };
      }
    }

    return bestByRunId?.p ?? bestRecent?.p ?? null;
  } catch {
    return null;
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
  /** @type {{ path: string, fd: import("node:fs/promises").FileHandle } | null} */
  let runLock = null;
  runLock = await acquireOhidRunLock(runId);
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
      // Exit soon after Search Eligibility scrape (no ATC automation). Hold timing is OHID_MEDICATE_HOLD_AFTER_SEARCH_MS in ohid-login.
      envOverrides.OHID_STAY_MS = envOverrides.OHID_STAY_MS ?? "0";
      envOverrides.DASHBOARD_STAY_MS = envOverrides.DASHBOARD_STAY_MS ?? "0";
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

    // Prefer artifact file (less brittle than parsing logs), fallback to stdout marker.
    const artifact = await tryReadEligibilityArtifact(runId);
    const parsed = artifact ?? parseOhidEligibilityResultFromStdout(res.stdoutTail);
    /** @type {object | null} */
    let searchEligibility = null;
    /** @type {object | null} */
    let eligibilityCompanyMatch = null;
    /** @type {object | null} */
    let recipientInformation = null;

    if (parsed != null && typeof parsed === "object") {
      if (Array.isArray(parsed.benefitAssignmentPlans) && Array.isArray(parsed.managedCarePlans)) {
        searchEligibility = parsed;
        eligibilityCompanyMatch = parsed.companyMatch ?? null;
        recipientInformation = parsed.recipientInformation ?? null;
        log.info("Playwright Search Eligibility JSON", {
          benefitRows: parsed.benefitAssignmentPlans?.length ?? 0,
          managedCareRows: parsed.managedCarePlans?.length ?? 0,
          hasCompanyMatch: parsed.companyMatch != null,
        });
        console.log("[OHID][activity] searchEligibility (tables + optional companyMatch) parsed from stdout.");
        if (eligibilityCompanyMatch != null) {
          log.info("Playwright eligibility company match", {
            match: eligibilityCompanyMatch.match,
            inputCompanyName: eligibilityCompanyMatch.inputCompanyName,
            uiCompanyName: eligibilityCompanyMatch.uiCompanyName,
          });
        }
      } else if (typeof parsed.match === "boolean" && "inputCompanyName" in parsed) {
        eligibilityCompanyMatch = parsed;
        searchEligibility = { benefitAssignmentPlans: [], managedCarePlans: [], companyMatch: parsed };
        log.info("Playwright eligibility company match (legacy stdout shape)", {
          match: parsed.match,
          inputCompanyName: parsed.inputCompanyName,
        });
      }
    }

    const companyNameMatched =
      eligibilityCompanyMatch != null &&
      typeof eligibilityCompanyMatch === "object" &&
      "match" in eligibilityCompanyMatch &&
      eligibilityCompanyMatch.match === true;

    /** @type {{ ok: true; token: string } | { ok: false; error: string; status?: number } | { skipped: true; reason: string }} */
    let billingAuth = { skipped: true, reason: "BillingAuth not run yet" };
    /** @type {{ taskCategories: unknown; priorities: unknown } | null} */
    let lookupData = null;
    /** @type {unknown | null} */
    let nonEncounterTaskAdd = null;

    if (!companyNameMatched) {
      const reason =
        eligibilityCompanyMatch == null
          ? "Company match not evaluated (provide medicateSearch.companyName); BillingAuth / LookupData / NonEncounterTask not called."
          : "Company name did not match; BillingAuth / LookupData / NonEncounterTask not called.";
      billingAuth = { skipped: true, reason };
      nonEncounterTaskAdd = { skipped: true, reason };
      log.info("Billing chain skipped (company name not matched)", {
        hasCompanyMatch: eligibilityCompanyMatch != null,
        match: eligibilityCompanyMatch?.match ?? null,
      });
      console.log("[OHID][activity] Billing chain skipped:", reason);
    } else {
      try {
        const auth = await fetchBillingAuthFromEnv();
        if ("skipped" in auth && auth.skipped) {
          billingAuth = { skipped: true, reason: auth.reason };
          log.info("BillingAuth JWT", { skipped: true, reason: auth.reason });
          console.log("[OHID][activity] BillingAuth skipped:", auth.reason);
        } else if ("ok" in auth && auth.ok && "token" in auth) {
          billingAuth = { ok: true, token: auth.token };
          log.info("BillingAuth JWT", { ok: true, tokenLength: auth.token.length });
          console.log("[OHID][activity] BillingAuth JWT obtained, length=", auth.token.length);
        } else if ("ok" in auth && !auth.ok) {
          billingAuth = {
            ok: false,
            error: auth.error,
            ...(auth.status != null ? { status: auth.status } : {}),
          };
          log.warn("BillingAuth JWT failed", { error: auth.error, status: auth.status });
          console.warn("[OHID][activity] BillingAuth failed:", auth.error);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        billingAuth = { ok: false, error: msg };
        log.warn("BillingAuth JWT exception", { message: msg });
        console.warn("[OHID][activity] BillingAuth exception:", msg);
      }

      if (
        billingAuth != null &&
        typeof billingAuth === "object" &&
        "ok" in billingAuth &&
        billingAuth.ok &&
        "token" in billingAuth &&
        typeof billingAuth.token === "string" &&
        billingAuth.token.trim() !== ""
      ) {
        try {
          lookupData = await fetchBillingLookupDataWithToken(billingAuth.token);
          log.info("Billing LookupData", {
            taskCategoriesOk: lookupData.taskCategories?.ok === true,
            prioritiesOk: lookupData.priorities?.ok === true,
          });
          console.log(
            "[OHID][activity] LookupData TaskCategories:",
            JSON.stringify(lookupData.taskCategories, null, 2),
          );
          console.log(
            "[OHID][activity] LookupData Priorities:",
            JSON.stringify(lookupData.priorities, null, 2),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lookupData = {
            taskCategories: { ok: false, error: msg },
            priorities: { ok: false, error: msg },
          };
          log.warn("Billing LookupData exception", { message: msg });
          console.warn("[OHID][activity] LookupData exception:", msg);
        }
      }

      const jwt =
        billingAuth != null &&
        typeof billingAuth === "object" &&
        "ok" in billingAuth &&
        billingAuth.ok &&
        "token" in billingAuth &&
        typeof billingAuth.token === "string"
          ? billingAuth.token
          : null;
      const firstNameMi =
        recipientInformation != null &&
        typeof recipientInformation === "object" &&
        "firstNameMi" in recipientInformation &&
        typeof recipientInformation.firstNameMi === "string" &&
        recipientInformation.firstNameMi.trim() !== ""
          ? recipientInformation.firstNameMi.trim()
          : null;

      if (jwt && firstNameMi) {
        try {
          const dto = {
            name: firstNameMi,
            description: "TestTestTestTestTestTestTest",
            taskCategoryId: 155,
            priorityId: 3,
            taskStatusId: 1,
            assignedToId: null,
            assignedToRoleId: 1,
            isAssignedToRole: true,
            dueDate: "2026-04-22T10:06:13.807Z",
            taskNotes: [],
          };
          const patientIdRaw = (process.env.NON_ENCOUNTER_TASK_PATIENT_ID || "").trim();
          if (/^\d+$/.test(patientIdRaw)) {
            dto.patientId = Number(patientIdRaw);
          }
          const screenshotPath = await resolveSearchEligibilityScreenshotPath(res.stdoutTail, runId);
          const filePaths = screenshotPath && existsSync(screenshotPath) ? [screenshotPath] : [];
          if (screenshotPath && filePaths.length === 0) {
            console.warn("[OHID][activity] Search Eligibility screenshot path not on disk:", screenshotPath);
          } else if (filePaths.length) {
            console.log("[OHID][activity] NonEncounterTask/Add attaching screenshot:", filePaths[0]);
          } else {
            console.warn("[OHID][activity] No Search Eligibility screenshot found to upload.");
          }
          nonEncounterTaskAdd = await addNonEncounterTaskWithToken(jwt, dto, { filePaths });
          console.log(
            "[OHID][activity] NonEncounterTask/Add result:",
            JSON.stringify(nonEncounterTaskAdd, null, 2),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          nonEncounterTaskAdd = { ok: false, error: msg };
        }
      } else {
        nonEncounterTaskAdd = {
          ok: false,
          error: !jwt
            ? "Missing billing JWT"
            : "Missing recipientInformation.firstNameMi",
        };
      }
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
      searchEligibility,
      eligibilityCompanyMatch,
      ...(recipientInformation != null ? { recipientInformation } : {}),
      billingAuth,
      ...(lookupData != null ? { lookupData } : {}),
      ...(nonEncounterTaskAdd != null ? { nonEncounterTaskAdd } : {}),
    };
    return {
      ok: true,
      elapsedMs: res.elapsedMs,
      pid: res.pid,
      stdoutTail: res.stdoutTail,
      billingAuth,
      ...(searchEligibility != null ? { searchEligibility } : {}),
      ...(eligibilityCompanyMatch != null ? { eligibilityCompanyMatch } : {}),
      ...(recipientInformation != null ? { recipientInformation } : {}),
      ...(lookupData != null ? { lookupData } : {}),
      ...(nonEncounterTaskAdd != null ? { nonEncounterTaskAdd } : {}),
    };
  } finally {
    await releaseOhidRunLock(runLock);
  }
}
