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
import { isMagiMentalHealthUnderBenefitAssignmentPlan } from "../magi-mental-health-assignment.js";
import { acquireOhidRunLock, releaseOhidRunLock } from "../ohid/run-lock.js";
import { fetchBillingAuthFromEnv } from "../billing-auth-client.js";
import { addNonEncounterTaskWithToken, fetchBillingLookupDataWithToken } from "../billing-lookup-data.js";
import { generateStickyNoteWithOpenAI, postPatientStickyNote } from "../ohid-sticky-note.js";

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
  // 1. Prefer npm_execpath if set by a parent npm process
  const fromEnv = process.env.npm_execpath?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  // 2. Try resolving the npm package from node_modules (works in some setups)
  const req = createRequire(import.meta.url);
  try {
    return req.resolve("npm/bin/npm-cli.js");
  } catch {
    // not in local node_modules — continue
  }
  // 3. Look for npm bundled alongside the current Node.js executable
  //    e.g. C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
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
      // shell:true is required on Windows so that .cmd files (npm.cmd) are executed
      // correctly via cmd.exe rather than being spawned directly (which fails with ENOENT).
      child = spawn(npmCmd, ["run", scriptName], {
        cwd: PROJECT_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
        shell: process.platform === "win32",
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
  // Multiple markers possible (e.g. initial search + DOS −1 month retry); use the last complete block.
  let searchFrom = 0;
  let lastStart = -1;
  let lastEnd = -1;
  for (;;) {
    const start = stdout.indexOf(OHID_ELIGIBILITY_RESULT_PREFIX, searchFrom);
    if (start === -1) break;
    const end = stdout.indexOf(
      OHID_ELIGIBILITY_RESULT_SUFFIX,
      start + OHID_ELIGIBILITY_RESULT_PREFIX.length,
    );
    if (end === -1) break;
    lastStart = start;
    lastEnd = end;
    searchFrom = end + OHID_ELIGIBILITY_RESULT_SUFFIX.length;
  }
  if (lastStart === -1 || lastEnd === -1) {
    return undefined;
  }
  const jsonStr = stdout.slice(lastStart + OHID_ELIGIBILITY_RESULT_PREFIX.length, lastEnd);
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
 * Step 1: run Playwright (`npm run login:ohid`).
 * Returns the stdout tail so later activities can parse markers.
 */
export async function ohidRunPlaywright(input) {
  const runId = input?.runId ? String(input.runId) : "";
  /** @type {{ path: string, fd: import("node:fs/promises").FileHandle } | null} */
  let runLock = null;
  runLock = await acquireOhidRunLock(runId);
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
    step: "playwright",
  };
  try {
    log.info("OHID step: Playwright run (npm run login:ohid)");
    /** @type {Record<string, string>} */
    const envOverrides = {};
    if (runId) envOverrides.OHID_WORKFLOW_RUN_ID = runId;
    if (
      input?.medicateSearch &&
      typeof input.medicateSearch.medicaidBillingNumber === "string" &&
      typeof input.medicateSearch.dateOfBirth === "string" &&
      typeof input.medicateSearch.fromDos === "string" &&
      typeof input.medicateSearch.toDos === "string"
    ) {
      envOverrides.OHID_MEDICATE_SEARCH_JSON = JSON.stringify(input.medicateSearch);
      envOverrides.OHID_STAY_MS = envOverrides.OHID_STAY_MS ?? "0";
      envOverrides.DASHBOARD_STAY_MS = envOverrides.DASHBOARD_STAY_MS ?? "0";
    }

    const res = await runNpmScript("login:ohid", Object.keys(envOverrides).length ? envOverrides : undefined);
    if (res.exitCode !== 0) {
      const msg = `OHID Playwright failed (exitCode=${res.exitCode}, signal=${res.signal ?? ""}).`;
      globalThis.__OHID_LAST_ACTIVITY__ = {
        kind: "ohid",
        runId,
        startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        step: "playwright",
        exitCode: res.exitCode,
        signal: res.signal,
        stderrTail: res.stderrTail,
        stdoutTail: res.stdoutTail,
      };
      throw new Error(`${msg}\n\nstderr:\n${res.stderrTail}\n\nstdout:\n${res.stdoutTail}`);
    }

    globalThis.__OHID_LAST_ACTIVITY__ = {
      kind: "ohid",
      runId,
      startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
      finishedAt: new Date().toISOString(),
      status: "succeeded",
      step: "playwright",
      pid: res.pid,
      elapsedMs: res.elapsedMs,
    };

    return { ok: true, runId, pid: res.pid, elapsedMs: res.elapsedMs, stdoutTail: res.stdoutTail };
  } finally {
    await releaseOhidRunLock(runLock);
  }
}

async function runOhidPlaywrightScriptStep(scriptInput, envOverrides) {
  const runId = scriptInput?.runId ? String(scriptInput.runId) : "";
  /** @type {{ path: string, fd: import("node:fs/promises").FileHandle } | null} */
  let runLock = null;
  runLock = await acquireOhidRunLock(runId);
  try {
    const res = await runNpmScript("login:ohid", envOverrides);
    if (res.exitCode !== 0) {
      const msg = `OHID Playwright failed (exitCode=${res.exitCode}, signal=${res.signal ?? ""}).`;
      throw new Error(`${msg}\n\nstderr:\n${res.stderrTail}\n\nstdout:\n${res.stdoutTail}`);
    }
    return { ok: true, runId, pid: res.pid, elapsedMs: res.elapsedMs, stdoutTail: res.stdoutTail };
  } finally {
    await releaseOhidRunLock(runLock);
  }
}

export async function ohidPlaywrightLogin(input) {
  const runId = input?.runId ? String(input.runId) : "";
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
    step: "playwright:login",
  };
  const envOverrides = {
    ...(runId ? { OHID_WORKFLOW_RUN_ID: runId } : {}),
    OHID_STEP: "login",
    OHID_OPEN_PNM: "false",
    // ensure a short exit (no "stay" tail)
    OHID_STAY_MS: "0",
    DASHBOARD_STAY_MS: "0",
  };
  const out = await runOhidPlaywrightScriptStep(input, envOverrides);
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
    finishedAt: new Date().toISOString(),
    status: "succeeded",
    step: "playwright:login",
    pid: out.pid,
    elapsedMs: out.elapsedMs,
  };
  return out;
}

export async function ohidPlaywrightOpenPnm(input) {
  const runId = input?.runId ? String(input.runId) : "";
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
    step: "playwright:pnm",
  };
  const envOverrides = {
    ...(runId ? { OHID_WORKFLOW_RUN_ID: runId } : {}),
    OHID_STEP: "pnm",
    OHID_OPEN_PNM: "true",
    // Ensure eligibility fill is skipped in this step
    OHID_MEDICATE_SEARCH_JSON: "",
    OHID_STAY_MS: "0",
    DASHBOARD_STAY_MS: "0",
  };
  const out = await runOhidPlaywrightScriptStep(input, envOverrides);
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
    finishedAt: new Date().toISOString(),
    status: "succeeded",
    step: "playwright:pnm",
    pid: out.pid,
    elapsedMs: out.elapsedMs,
  };
  return out;
}

export async function ohidPlaywrightEligibility(input) {
  const runId = input?.runId ? String(input.runId) : "";
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: new Date().toISOString(),
    status: "running",
    step: "playwright:eligibility",
  };
  /** @type {Record<string, string>} */
  const envOverrides = {
    ...(runId ? { OHID_WORKFLOW_RUN_ID: runId } : {}),
    OHID_STEP: "eligibility",
    OHID_OPEN_PNM: "true",
    OHID_STAY_MS: "0",
    DASHBOARD_STAY_MS: "0",
  };
  if (
    input?.medicateSearch &&
    typeof input.medicateSearch.medicaidBillingNumber === "string" &&
    typeof input.medicateSearch.dateOfBirth === "string" &&
    typeof input.medicateSearch.fromDos === "string" &&
    typeof input.medicateSearch.toDos === "string"
  ) {
    envOverrides.OHID_MEDICATE_SEARCH_JSON = JSON.stringify(input.medicateSearch);
  }
  const out = await runOhidPlaywrightScriptStep(input, envOverrides);
  globalThis.__OHID_LAST_ACTIVITY__ = {
    kind: "ohid",
    runId,
    startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
    finishedAt: new Date().toISOString(),
    status: "succeeded",
    step: "playwright:eligibility",
    pid: out.pid,
    elapsedMs: out.elapsedMs,
  };
  return out;
}

/**
 * Step 2: parse eligibility + company match + recipient info.
 */
export async function ohidParseEligibility(input) {
  const runId = input?.runId ? String(input.runId) : "";
  const stdoutTail = typeof input?.stdoutTail === "string" ? input.stdoutTail : "";
  /** @type {{ path: string, fd: import("node:fs/promises").FileHandle } | null} */
  let runLock = null;
  runLock = await acquireOhidRunLock(runId);
  try {
    globalThis.__OHID_LAST_ACTIVITY__ = {
      kind: "ohid",
      runId,
      startedAt: new Date().toISOString(),
      status: "running",
      step: "parseEligibility",
    };

    const artifact = await tryReadEligibilityArtifact(runId);
    const parsed = artifact ?? parseOhidEligibilityResultFromStdout(stdoutTail);
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
      } else if (typeof parsed.match === "boolean" && "inputCompanyName" in parsed) {
        eligibilityCompanyMatch = parsed;
        searchEligibility = { benefitAssignmentPlans: [], managedCarePlans: [], companyMatch: parsed };
      }
    }

    // ── MAGI Mental-Health check (company-name-no-match scenario) ─────────────
    // When the company name did NOT match (or was never provided), check whether
    // the patient holds "MAGI: Mental Health Under Benefit/Assignment …" (not e.g. "MAGI: Ohio Mental Health" alone).
    // Result is included in the return value as `magiMentalHealthCheck`.
    const _companyMatched =
      eligibilityCompanyMatch != null &&
      typeof eligibilityCompanyMatch === "object" &&
      "match" in eligibilityCompanyMatch &&
      /** @type {{ match: boolean }} */ (eligibilityCompanyMatch).match === true;

    /** @type {{ checked: boolean, found: boolean, plan: object | null, message: string } | null} */
    let magiMentalHealthCheck = null;

    if (!_companyMatched && searchEligibility != null) {
      const _benefitPlans = Array.isArray(searchEligibility.benefitAssignmentPlans)
        ? searchEligibility.benefitAssignmentPlans
        : [];
      const _magiPlan = _benefitPlans.find(
        (p) =>
          typeof p?.benefitAssignmentPlan === "string" &&
          isMagiMentalHealthUnderBenefitAssignmentPlan(p.benefitAssignmentPlan),
      ) ?? null;

      if (_magiPlan) {
        const msg =
          `Company name did not match — patient has MAGI: Mental Health Under Benefit/Assignment Plan` +
          ` ("${_magiPlan.benefitAssignmentPlan}"; effective: ${_magiPlan.effectiveDate ?? "?"}, end: ${_magiPlan.endDate ?? "?"}).`;
        console.log(`[OHID][parseEligibility] ${msg}`);
        magiMentalHealthCheck = { checked: true, found: true, plan: _magiPlan, message: msg };
      } else {
        const msg =
          `Company name did not match — patient does NOT have MAGI: Mental Health Under Benefit/Assignment Plan.` +
          ` (benefit plans checked: ${_benefitPlans.length})`;
        console.log(`[OHID][parseEligibility] ${msg}`);
        magiMentalHealthCheck = { checked: true, found: false, plan: null, message: msg };
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const screenshotPath = await resolveSearchEligibilityScreenshotPath(stdoutTail, runId);

    const magiFirstSearch =
      searchEligibility != null &&
      typeof searchEligibility === "object" &&
      "magiFirstSearch" in searchEligibility &&
      searchEligibility.magiFirstSearch != null
        ? searchEligibility.magiFirstSearch
        : null;
    const magiFirstSearchMessage =
      magiFirstSearch != null &&
      typeof magiFirstSearch === "object" &&
      "message" in magiFirstSearch &&
      typeof magiFirstSearch.message === "string"
        ? magiFirstSearch.message
        : null;

    globalThis.__OHID_LAST_ACTIVITY__ = {
      kind: "ohid",
      runId,
      startedAt: globalThis.__OHID_LAST_ACTIVITY__?.startedAt,
      finishedAt: new Date().toISOString(),
      status: "succeeded",
      step: "parseEligibility",
      ...(searchEligibility != null ? { searchEligibility } : {}),
      ...(eligibilityCompanyMatch != null ? { eligibilityCompanyMatch } : {}),
      ...(recipientInformation != null ? { recipientInformation } : {}),
      ...(magiMentalHealthCheck != null ? { magiMentalHealthCheck } : {}),
      ...(magiFirstSearch != null ? { magiFirstSearch } : {}),
      ...(magiFirstSearchMessage != null ? { magiFirstSearchMessage } : {}),
      ...(screenshotPath ? { screenshotPath } : {}),
    };

    return {
      ok: true,
      ...(searchEligibility != null ? { searchEligibility } : {}),
      ...(eligibilityCompanyMatch != null ? { eligibilityCompanyMatch } : {}),
      ...(recipientInformation != null ? { recipientInformation } : {}),
      ...(magiMentalHealthCheck != null ? { magiMentalHealthCheck } : {}),
      ...(magiFirstSearch != null ? { magiFirstSearch } : {}),
      ...(magiFirstSearchMessage != null ? { magiFirstSearchMessage } : {}),
      screenshotPath: screenshotPath ?? null,
    };
  } finally {
    await releaseOhidRunLock(runLock);
  }
}

/**
 * Step 3: BillingAuth token (env-configured).
 */
export async function ohidFetchBillingAuth() {
  const auth = await fetchBillingAuthFromEnv();
  if ("skipped" in auth && auth.skipped) return { skipped: true, reason: auth.reason };
  if ("ok" in auth && auth.ok && "token" in auth) return { ok: true, token: auth.token };
  if ("ok" in auth && !auth.ok) return { ok: false, error: auth.error, ...(auth.status != null ? { status: auth.status } : {}) };
  return { ok: false, error: "Unexpected BillingAuth response" };
}

/**
 * Step 4: lookup data with BillingAuth token.
 */
export async function ohidFetchLookupData(input) {
  const jwt = typeof input?.jwt === "string" ? input.jwt : "";
  if (!jwt) {
    return { taskCategories: { ok: false, error: "Missing JWT" }, priorities: { ok: false, error: "Missing JWT" } };
  }
  return await fetchBillingLookupDataWithToken(jwt);
}

/**
 * Step 5: add non-encounter task with screenshot (optional).
 */
export async function ohidAddNonEncounterTask(input) {
  const jwt = typeof input?.jwt === "string" ? input.jwt : "";
  const firstNameMi = typeof input?.firstNameMi === "string" ? input.firstNameMi.trim() : "";
  const screenshotPath = typeof input?.screenshotPath === "string" ? input.screenshotPath : "";
  if (!jwt) return { ok: false, error: "Missing billing JWT" };
  if (!firstNameMi) return { ok: false, error: "Missing recipientInformation.firstNameMi" };

  const patientIdRaw =
    (process.env.NON_ENCOUNTER_TASK_PATIENT_ID || process.env.BILLING_TASK_PATIENT_ID || "").trim();
  const patientId = /^\d+$/.test(patientIdRaw) ? Number(patientIdRaw) : null;

  const assignedToRoleIdRaw = (process.env.BILLING_TASK_ASSIGNED_TO_ROLE_ID || "7").trim();
  const assignedToRoleId = /^\d+$/.test(assignedToRoleIdRaw) ? Number(assignedToRoleIdRaw) : 7;

  const priorityIdRaw = (process.env.BILLING_TASK_PRIORITY_ID || "1").trim();
  const priorityId = /^\d+$/.test(priorityIdRaw) ? Number(priorityIdRaw) : 1;

  const taskTypeCode = (process.env.BILLING_TASK_TYPE_CODE || "BILLING_NOTE").trim() || "BILLING_NOTE";

  const now = new Date();
  const dueAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // +1 day default

  // New v3 DTO shape (used when BILLING_TENANT_ID is configured).
  const dto = {
    title: `Eligibility check – ${firstNameMi}`,
    description: "Automated eligibility check created from OHID workflow.",
    taskTypeCode,
    priorityId,
    assignedToRoleId,
    ...(patientId != null ? { patientId } : {}),
    dueAt,
    notes: [
      {
        id: 0,
        taskId: 0,
        noteText: "Created by automation (OHID workflow).",
        createdBy: process.env.BILLING_TASK_CREATED_BY || "automation@local",
        createdDate: new Date().toISOString(),
      },
    ],
  };

  // Legacy endpoint supports screenshot upload; v3 currently does not in this repo.
  const filePaths = screenshotPath && existsSync(screenshotPath) ? [screenshotPath] : [];
  return await addNonEncounterTaskWithToken(jwt, dto, { filePaths });
}

/**
 * Step 6 (conditional): POST to InsurancePolicy API when the patient has no MAGI Mental Health
 * benefit/assignment plan.  Patient details are hardcoded for now.
 *
 * @param {{ jwt?: string } | null | undefined} input - Bearer from `ohidFetchBillingAuth` (preferred).
 *
 * Env (fallback if input.jwt missing):
 *   ATC_INSURANCE_POLICY_TOKEN  — Bearer token for atc-api.atcemr.com
 *   ATC_INSURANCE_POLICY_COOKIE — Full Cookie header value (AWSALB=…)
 *   ATC_INSURANCE_POLICY_URL    — Override API base URL (default: https://atc-api.atcemr.com/api/InsurancePolicy)
 */
export async function ohidAddInsurancePolicy(input) {
  const url = (process.env.ATC_INSURANCE_POLICY_URL || "https://atc-api.atcemr.com/api/InsurancePolicy").trim();
  const fromInput = typeof input?.jwt === "string" ? input.jwt.trim() : "";
  const fromEnv = (process.env.ATC_INSURANCE_POLICY_TOKEN || "").trim();
  const token = fromInput || fromEnv;
  const cookie = (process.env.ATC_INSURANCE_POLICY_COOKIE || "").trim();

  if (!token) {
    return {
      skipped: true,
      reason:
        "No Bearer token: pass jwt from BillingAuth or set ATC_INSURANCE_POLICY_TOKEN in .env.",
    };
  }

  // Patient details are hardcoded for now.
  const body = {
    phSignatureOnFile: true,
    acceptAssignment: true,
    insuranceCompanyID: 465,
    medicaidId: "",
    policyHolderId: 16759,
    policyNumber: "444444444444",
    planEffectiveDate: "10/01/2025",
    planExpirationDate: "",
    insurancePolicyHolder: {
      firstName: "test",
      lastName: "test",
      dob: "12/31/1999",
      genderId: 1,
      homePhone: "6142199394",
    },
    patientPolicy: [
      {
        isActive: true,
        levelId: 1,
        patientId: "8028",
      },
    ],
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...(cookie ? { Cookie: cookie } : {}),
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => "");
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text || null;
    }

    if (!res.ok) {
      console.error(`[OHID][InsurancePolicy] HTTP ${res.status}:`, text);
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, data };
    }

    console.log(`[OHID][InsurancePolicy] Created successfully (HTTP ${res.status}).`);
    return { ok: true, status: res.status, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[OHID][InsurancePolicy] Request failed:", error);
    return { ok: false, error };
  }
}

/**
 * Step 7 (conditional): Generate a billing note via OpenAI from the eligibility data,
 * then POST it to PatientStickyNote/Add.  Called when the patient has no MAGI Mental
 * Health plan (company name did not match).
 *
 * @param {{
 *   jwt?: string,
 *   recipientInformation?: object | null,
 *   benefitAssignmentPlans?: object[],
 *   eligibilityCompanyMatch?: object | null,
 *   magiMentalHealthCheck?: object | null,
 * } | null | undefined} input
 */
export async function ohidAddPatientStickyNote(input) {
  const eligibilityData = input ?? {};
  const billingJwt = typeof eligibilityData.jwt === "string" ? eligibilityData.jwt.trim() : "";

  const notePayload = {
    recipientInformation: eligibilityData.recipientInformation ?? null,
    benefitAssignmentPlans: eligibilityData.benefitAssignmentPlans ?? [],
    eligibilityCompanyMatch: eligibilityData.eligibilityCompanyMatch ?? null,
    magiMentalHealthCheck: eligibilityData.magiMentalHealthCheck ?? null,
  };

  log.info("[OHID][StickyNote] Generating billing note via OpenAI (set OPENAI_STICKY_NOTE_TEMPLATE_FALLBACK=1 for template-only fallback)…");

  const generated = await generateStickyNoteWithOpenAI(notePayload);

  if (!generated.ok) {
    console.error("[OHID][StickyNote] Note generation failed:", generated.error);
    return { ok: false, step: "generate", error: generated.error };
  }

  log.info("[OHID][StickyNote] Posting to PatientStickyNote/Add…");

  const posted = await postPatientStickyNote(generated.note, { jwt: billingJwt });

  return {
    ...posted,
    note: generated.note,
    ...(generated.source ? { noteSource: generated.source } : {}),
  };
}

/**
 * Back-compat wrapper: keep existing activity name but implement it via the new steps.
 * (Some clients/workflows may still reference `runOhidLogin`.)
 */
export async function runOhidLogin(input) {
  const runId = input?.runId ? String(input.runId) : "";
  const play = await ohidRunPlaywright(input);
  const parsed = await ohidParseEligibility({ runId, stdoutTail: play.stdoutTail });

  const eligibilityCompanyMatch = parsed?.eligibilityCompanyMatch ?? null;
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
  } else {
    billingAuth = await ohidFetchBillingAuth();
    const jwt =
      billingAuth && typeof billingAuth === "object" && "ok" in billingAuth && billingAuth.ok && typeof billingAuth.token === "string"
        ? billingAuth.token
        : null;
    if (jwt) {
      lookupData = await ohidFetchLookupData({ jwt });
      const firstNameMi =
        parsed?.recipientInformation != null &&
        typeof parsed.recipientInformation === "object" &&
        "firstNameMi" in parsed.recipientInformation &&
        typeof parsed.recipientInformation.firstNameMi === "string"
          ? parsed.recipientInformation.firstNameMi
          : "";
      nonEncounterTaskAdd = await ohidAddNonEncounterTask({
        jwt,
        firstNameMi,
        screenshotPath: parsed?.screenshotPath ?? "",
      });
    } else {
      nonEncounterTaskAdd = { ok: false, error: "Missing billing JWT" };
    }
  }

  return {
    ok: true,
    elapsedMs: play.elapsedMs,
    pid: play.pid,
    stdoutTail: play.stdoutTail,
    billingAuth,
    ...(parsed?.searchEligibility != null ? { searchEligibility: parsed.searchEligibility } : {}),
    ...(parsed?.eligibilityCompanyMatch != null ? { eligibilityCompanyMatch: parsed.eligibilityCompanyMatch } : {}),
    ...(parsed?.recipientInformation != null ? { recipientInformation: parsed.recipientInformation } : {}),
    ...(lookupData != null ? { lookupData } : {}),
    ...(nonEncounterTaskAdd != null ? { nonEncounterTaskAdd } : {}),
  };
}
