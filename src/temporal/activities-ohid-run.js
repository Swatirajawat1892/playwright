/**
 * Temporal activities: OHID Playwright runner (`npm run login:ohid`) + eligibility artifact/stdout parsing.
 */
import { log } from "@temporalio/activity";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { safeParseOhidEligibilityStdoutPayload } from "../ohid-eligibility-schema.js";
import { acquireOhidRunLock, releaseOhidRunLock } from "../ohid/run-lock.js";

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

    if (parsed != null && typeof parsed === "object") {
      if (Array.isArray(parsed.benefitAssignmentPlans) && Array.isArray(parsed.managedCarePlans)) {
        searchEligibility = parsed;
        eligibilityCompanyMatch = parsed.companyMatch ?? null;
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
    };
    return {
      ok: true,
      elapsedMs: res.elapsedMs,
      pid: res.pid,
      stdoutTail: res.stdoutTail,
      ...(searchEligibility != null ? { searchEligibility } : {}),
      ...(eligibilityCompanyMatch != null ? { eligibilityCompanyMatch } : {}),
    };
  } finally {
    await releaseOhidRunLock(runLock);
  }
}
