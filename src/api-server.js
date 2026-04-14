/**
 * HTTP API: start login workflow, Twilio webhook, OTP status.
 * POST /ohid-login — optional direct Playwright (disabled by default; use POST /medicate-availability-check).
 * POST /ingest-otp — external OTP (e.g. n8n + Gmail) for OHID Playwright (shared file store).
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import express from "express";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowIdReusePolicy } from "@temporalio/common";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractOtpFromText,
  getActiveOhidWorkflowId,
  getOtpStatus,
  registerActiveAvailityWorkflow,
  registerActiveOhidWorkflow,
  storeOtpForWorkflow,
} from "./otpStore.js";
import { twilioWebhookRouter } from "./twilioController.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Must match exported workflow name in temporal/workflows.js */
const AVAILITY_LOGIN_WORKFLOW = "availityLoginWorkflow";
const OHID_LOGIN_WORKFLOW = "ohidLoginWorkflow";

export const PORT = Number(process.env.API_PORT ?? "3000");
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "availity-login";
/** Embedded `npm start` sets this to :8233. Docker UI is often :8080 — override in .env. */
const TEMPORAL_UI_URL = (process.env.TEMPORAL_UI_URL ?? "http://localhost:8233").replace(/\/$/, "");

/**
 * @param {"starting" | "ready"} phase
 */
export function printTemporalBanner(phase) {
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Availity login  •  Temporal + Playwright");
  console.log("═══════════════════════════════════════════════════════════");
  const embedded = process.env.TEMPORAL_EMBEDDED === "true";
  console.log(`  gRPC:      ${embedded ? "(embedded dev server — npm start)" : TEMPORAL_ADDRESS}`);
  console.log(`  Namespace: ${TEMPORAL_NAMESPACE}`);
  console.log(`  Task queue: ${TASK_QUEUE}`);
  console.log(`  Web UI:    ${TEMPORAL_UI_URL}  (pick namespace: ${TEMPORAL_NAMESPACE})`);
  if (phase === "starting") {
    console.log("");
    console.log("  Temporal:");
    if (embedded) {
      console.log("    • Embedded server — workflows show ONLY in Web UI: " + TEMPORAL_UI_URL);
      console.log("    • NOT http://localhost:8233 unless TEMPORAL_UI_PORT=8233 (that URL is another server).");
    } else {
      console.log("    • External server — use  npm start  for embedded, or  npm run start:docker  for Docker.");
    }
    console.log("    • App only (server already running):  npm run start:app");
    console.log("    • After Submit login, refresh Workflows in the UI above.");
    console.log("    • Health:  GET /temporal-health on the API port below");
  }
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
}

let clientPromise;

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const injected = globalThis.__TEMPORAL_INJECTED__;
      if (injected?.connection) {
        const ns = injected.namespace ?? TEMPORAL_NAMESPACE;
        return new Client({ connection: injected.connection, namespace: ns });
      }
      const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
      return new Client({ connection, namespace: TEMPORAL_NAMESPACE });
    })();
  }
  return clientPromise;
}

export const app = express();

app.use("/webhook", twilioWebhookRouter);

app.use(express.json());

/**
 * Optional `medicateSearch` on POST /medicate-availability-check — forwarded to OHID Playwright (Search Eligibility form).
 * @param {unknown} body
 * @returns {{ ok: true, value?: { medicaidBillingNumber: string, dateOfBirth: string, fromDos: string, toDos: string, companyName?: string } } | { ok: false, error: string }}
 */
function parseMedicateSearchBody(body) {
  const ms = body?.medicateSearch;
  if (ms === undefined || ms === null) {
    return { ok: true, value: undefined };
  }
  if (typeof ms !== "object" || Array.isArray(ms)) {
    return { ok: false, error: "medicateSearch must be an object" };
  }
  const o = /** @type {Record<string, unknown>} */ (ms);
  const medicaidBillingNumber = String(o.medicaidBillingNumber ?? "").trim();
  const dateOfBirth = String(o.dateOfBirth ?? "").trim();
  const fromDos = String(o.fromDos ?? "").trim();
  const toDos = String(o.toDos ?? "").trim();
  const companyName = String(o.companyName ?? "").trim();
  if (!medicaidBillingNumber || !dateOfBirth || !fromDos || !toDos) {
    return {
      ok: false,
      error:
        "medicateSearch requires all of: medicaidBillingNumber, dateOfBirth, fromDos, toDos (non-empty strings; dates as mm/dd/yyyy). Optional: companyName.",
    };
  }
  /** @type {{ medicaidBillingNumber: string, dateOfBirth: string, fromDos: string, toDos: string, companyName?: string }} */
  const value = { medicaidBillingNumber, dateOfBirth, fromDos, toDos };
  if (companyName) {
    value.companyName = companyName;
  }
  return { ok: true, value };
}

/**
 * Optional: set OHID_HTTP_API_KEY in .env; then send X-API-Key or Authorization: Bearer.
 * @returns {boolean} true if request may proceed
 */
function assertOhidApiKey(req, res) {
  const key = process.env.OHID_HTTP_API_KEY?.trim();
  if (!key) {
    return true;
  }
  const x = req.get("x-api-key");
  const auth = req.get("authorization");
  const bearer =
    typeof auth === "string" && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (x === key || bearer === key) {
    return true;
  }
  res.status(401).json({
    ok: false,
    error:
      "Invalid or missing API key. Send header X-API-Key or Authorization: Bearer (see OHID_HTTP_API_KEY in .env).",
  });
  return false;
}

/**
 * Optional: set OTP_INGEST_API_KEY in .env for POST /ingest-otp (n8n, Gmail OTP, etc.).
 * @returns {boolean} true if request may proceed
 */
function assertOtpIngestApiKey(req, res) {
  const key = process.env.OTP_INGEST_API_KEY?.trim();
  if (!key) {
    return true;
  }
  const x = req.get("x-api-key");
  const auth = req.get("authorization");
  const bearer =
    typeof auth === "string" && auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (x === key || bearer === key) {
    return true;
  }
  res.status(401).json({
    ok: false,
    error:
      "Invalid or missing API key. Send header X-API-Key or Authorization: Bearer (see OTP_INGEST_API_KEY in .env).",
  });
  return false;
}

function directOhidPlaywrightEndpointEnabled() {
  const v = process.env.OHID_ENABLE_DIRECT_PLAYWRIGHT_ENDPOINT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Direct `npm run login:ohid` in this Node process (no Temporal).
 * Off by default — use POST /medicate-availability-check. Set OHID_ENABLE_DIRECT_PLAYWRIGHT_ENDPOINT=true to allow.
 */
app.post("/ohid-login", (req, res) => {
  if (!directOhidPlaywrightEndpointEnabled()) {
    res.status(403).json({
      ok: false,
      error:
        "Direct OHID Playwright is disabled. Start a run with POST /medicate-availability-check (Temporal workflow). To re-enable this endpoint, set OHID_ENABLE_DIRECT_PLAYWRIGHT_ENDPOINT=true in .env.",
    });
    return;
  }
  if (!assertOhidApiKey(req, res)) {
    return;
  }
  if (globalThis.__ohidLoginPid) {
    res.status(409).json({
      ok: false,
      error: "An OHID Playwright run is already in progress.",
      pid: globalThis.__ohidLoginPid,
    });
    return;
  }

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  let child;
  try {
    child = spawn(npmCmd, ["run", "login:ohid"], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
    return;
  }
  globalThis.__ohidLoginPid = child.pid;
  child.on("exit", (code, signal) => {
    delete globalThis.__ohidLoginPid;
    const line = `[ohid-login] process exited code=${code} signal=${signal ?? ""}`;
    if (code !== 0 && code !== null) {
      console.error(line);
    } else {
      console.log(line);
    }
  });
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[ohid-login] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[ohid-login] ${chunk.toString()}`);
  });
  child.on("error", (err) => {
    console.error("[ohid-login] spawn error:", err);
    delete globalThis.__ohidLoginPid;
  });
  res.status(202).json({
    ok: true,
    message: "OHID Playwright run started (background). Watch server logs for [ohid-login] lines.",
    pid: child.pid,
    hint: "Session file on success: .ohid-session.json in project root (see ohid-login.ts).",
  });
});

app.get("/ohid-last", (_req, res) => {
  const last = globalThis.__OHID_LAST_ACTIVITY__;
  res.json({ ok: true, last: last ?? null });
});



const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Availity login automation</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
    button { padding: 0.5rem 1rem; cursor: pointer; }
    input[type="text"] { width: 100%; box-sizing: border-box; margin-top: 0.25rem; }
    .msg { margin-top: 1rem; white-space: pre-wrap; }
    .err { color: #b00020; }
    .ok { color: #0a6620; }
    .temporal-panel { background: #fff8e6; border: 1px solid #e6c200; padding: 12px 14px; margin-bottom: 1.25rem; border-radius: 8px; font-size: 0.95rem; }
    .temporal-panel code { background: #f5f0dd; padding: 0 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Availity login</h1>
  <div class="temporal-panel" id="temporal-panel">
    <strong>Temporal Web UI for this run</strong>
    <p id="temporal-ui-line">Loading…</p>
    <p style="margin:0.5rem 0 0;color:#444;"><strong>0 workflows in Temporal UI is normal</strong> until you start a run: this page uses <strong>gRPC :7233</strong> to the server; <strong>:8233</strong> is only the browser UI. Click <strong>Submit login</strong> below, then refresh Workflows in Temporal.</p>
  </div>
  <p>User ID and password are read from the server <code>.env</code>. Submit starts the Temporal workflow.</p>
  <form id="login-form">
    <label>Optional workflow ID<br>
      <input name="workflowId" type="text" autocomplete="off" placeholder="Leave empty to auto-generate">
    </label>
    <p><button type="submit">Submit login</button></p>
  </form>
  <div id="out" class="msg" aria-live="polite"></div>
  <script>
    fetch("/temporal-health")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var line = document.getElementById("temporal-ui-line");
        if (j.ok && j.webUiHint) {
          var ns = j.namespace || "default";
          line.innerHTML = "Open <a href=\"" + j.webUiHint + "/namespaces/" + encodeURIComponent(ns) + "/workflows\" target=\"_blank\" rel=\"noopener\"><strong>" + j.webUiHint + "</strong></a> → namespace <code>" + ns + "</code> → Workflows. Then click <strong>Submit login</strong> below and refresh.";
        } else {
          line.textContent = (j && j.error) ? String(j.error) : "Temporal not reachable. Run npm start.";
        }
      })
      .catch(function () {
        document.getElementById("temporal-ui-line").textContent = "Could not GET /temporal-health";
      });
    document.getElementById("login-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var out = document.getElementById("out");
      out.textContent = "Starting workflow…";
      out.className = "msg";
      var workflowId = document.querySelector('[name="workflowId"]').value.trim();
      var body = workflowId ? JSON.stringify({ workflowId: workflowId }) : "{}";
      try {
        var r = await fetch("/start-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body
        });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        out.className = "msg ok";
        var uiLine = "";
        if (j.temporal && j.temporal.workflowUrl) {
          uiLine = "\\n\\nTemporal UI (open in browser):\\n" + j.temporal.workflowUrl;
        }
        out.textContent = "Workflow started.\\nworkflowId: " + j.workflowId + uiLine + "\\n\\n" + (j.twilioWebhookHint || "");
      } catch (err) {
        out.className = "msg err";
        out.textContent = "Error: " + (err && err.message ? err.message : String(err));
      }
    });
  </script>
</body>
</html>`;

app.get("/", (_req, res) => {
  res.type("html").send(LOGIN_PAGE_HTML);
});

app.post("/start-login", async (req, res) => {
  try {
    const client = await getClient();
    const workflowId =
      typeof req.body?.workflowId === "string" && req.body.workflowId.trim() !== ""
        ? req.body.workflowId.trim()
        : `availity-login-${randomUUID()}`;

    await registerActiveAvailityWorkflow(workflowId);

    await client.workflow.start(AVAILITY_LOGIN_WORKFLOW, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{}],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      workflowRunTimeout: "30m",
    });

    const uiPath = `${TEMPORAL_UI_URL}/namespaces/${encodeURIComponent(TEMPORAL_NAMESPACE)}/workflows/${encodeURIComponent(workflowId)}`;
    console.log(`[Temporal] workflow started  id=${workflowId}  type=${AVAILITY_LOGIN_WORKFLOW}`);
    console.log(`[Temporal] open in UI (path may vary by version): ${uiPath}`);

    res.status(202).json({
      ok: true,
      workflowId,
      temporal: {
        address: TEMPORAL_ADDRESS,
        namespace: TEMPORAL_NAMESPACE,
        taskQueue: TASK_QUEUE,
        workflowType: AVAILITY_LOGIN_WORKFLOW,
        webUiBaseUrl: TEMPORAL_UI_URL,
        workflowUrl: uiPath,
      },
      twilioWebhookHint:
        "Point Twilio SMS webhook to POST /webhook/twilio (optional ?workflowId=... matches this id).",
    });
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      res.status(409).json({
        ok: false,
        error: "Workflow already running for this workflowId",
        workflowId: err.workflowId,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("start-login error:", message);
    res.status(500).json({ ok: false, error: message });
  }
});

/** Same workflow as POST /start-ohid-login — starts OHID_LOGIN_WORKFLOW. GET is only a helper (browser bar); you must POST to run. */
app.get("/medicate-availability-check", (_req, res) => {
  const port = process.env.API_PORT ?? "3000";
  res.status(200).json({
    ok: false,
    message:
      "This endpoint runs the OHID workflow. Use POST (opening this URL in a browser only sends GET and does not start a run).",
    temporal: {
      address: TEMPORAL_ADDRESS,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: TASK_QUEUE,
      webUiBaseUrl: TEMPORAL_UI_URL,
      hint:
        "Must match `temporal server start-dev` (gRPC :7233, UI :8233). If these differ from your server, set TEMPORAL_ADDRESS and TEMPORAL_UI_URL in .env and restart npm run start:app.",
    },
    tryPost: {
      method: "POST",
      url: `http://localhost:${port}/medicate-availability-check`,
      headers: { "Content-Type": "application/json" },
      body: {
        medicateSearch: {
          medicaidBillingNumber: "1234567890",
          dateOfBirth: "01/15/1990",
          fromDos: "01/01/2025",
          toDos: "12/31/2025",
          companyName: "Optional — filled if the page has a matching field",
        },
      },
    },
    curl: `curl -s -X POST http://localhost:${port}/medicate-availability-check -H "Content-Type: application/json" -d "{\\"medicateSearch\\":{\\"medicaidBillingNumber\\":\\"...\\",\\"dateOfBirth\\":\\"mm/dd/yyyy\\",\\"fromDos\\":\\"...\\",\\"toDos\\":\\"...\\",\\"companyName\\":\\"...\\"}}"`,
    health: `http://localhost:${port}/temporal-health`,
  });
});

app.post("/medicate-availability-check", async (req, res) => {
  try {
    const parsed = parseMedicateSearchBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }

    const client = await getClient();
    const workflowId =
      typeof req.body?.workflowId === "string" && req.body.workflowId.trim() !== ""
        ? req.body.workflowId.trim()
        : `ohid-login-${randomUUID()}`;

    await registerActiveOhidWorkflow(workflowId);

    const maxAttemptsRaw = req.body?.maxAttempts;
    const maxAttemptsNum = Math.floor(Number(maxAttemptsRaw));
    const maxAttempts =
      maxAttemptsRaw !== undefined && maxAttemptsRaw !== null && String(maxAttemptsRaw).trim() !== "" && Number.isFinite(maxAttemptsNum)
        ? Math.min(50, Math.max(1, maxAttemptsNum))
        : 10;
    const retryDelayRaw = req.body?.retryDelaySeconds;
    const retryDelayNum = Math.floor(Number(retryDelayRaw));
    const retryDelaySeconds =
      retryDelayRaw !== undefined && retryDelayRaw !== null && String(retryDelayRaw).trim() !== "" && Number.isFinite(retryDelayNum)
        ? Math.min(600, Math.max(5, retryDelayNum))
        : 45;

    /** @type {Record<string, unknown>} */
    const workflowArgs = {
      runId: workflowId,
      maxAttempts,
      retryDelaySeconds,
    };
    if (parsed.value !== undefined) {
      workflowArgs.medicateSearch = parsed.value;
    }

    const approxMinutes = maxAttempts * 22 + Math.max(0, maxAttempts - 1) * (retryDelaySeconds / 60);
    const workflowRunTimeout = `${Math.min(720, Math.max(30, Math.ceil(approxMinutes)))}m`;

    await client.workflow.start(OHID_LOGIN_WORKFLOW, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [workflowArgs],
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      workflowRunTimeout,
    });

    const uiPath = `${TEMPORAL_UI_URL}/namespaces/${encodeURIComponent(TEMPORAL_NAMESPACE)}/workflows/${encodeURIComponent(workflowId)}`;
    console.log(`[Temporal] workflow started  id=${workflowId}  type=${OHID_LOGIN_WORKFLOW}`);
    if (parsed.value) {
      console.log("[Temporal] medicateSearch fields forwarded to worker (Search Eligibility form).");
    }
    console.log(`[Temporal] open in UI (path may vary by version): ${uiPath}`);

    res.status(202).json({
      ok: true,
      workflowId,
      medicateSearch: parsed.value ?? null,
      maxAttempts,
      retryDelaySeconds,
      workflowRunTimeout,
      temporal: {
        address: TEMPORAL_ADDRESS,
        namespace: TEMPORAL_NAMESPACE,
        taskQueue: TASK_QUEUE,
        workflowType: OHID_LOGIN_WORKFLOW,
        webUiBaseUrl: TEMPORAL_UI_URL,
        workflowUrl: uiPath,
      },
      hint:
        "Workflow retries runOhidLogin up to maxAttempts (default 10) with retryDelaySeconds (default 45s) between failures. With medicateSearch, fills Search Eligibility. n8n OTP: POST /ingest-otp. GET /ohid-last for worker debug.",
    });
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      res.status(409).json({
        ok: false,
        error: "Workflow already running for this workflowId",
        workflowId: err.workflowId,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("start-ohid-login error:", message);
    res.status(500).json({ ok: false, error: message });
  }
});

// ✅ NEW CHANGE: Blocks until workflow completes; HTTP body includes workflow result (eligibilityCompanyMatch).
app.post("/medicate-availability-check-await-result", async (req, res) => {
  try {
    const parsed = parseMedicateSearchBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }

    const client = await getClient();
    const workflowId =
      typeof req.body?.workflowId === "string" && req.body.workflowId.trim() !== ""
        ? req.body.workflowId.trim()
        : `ohid-login-${randomUUID()}`;

    await registerActiveOhidWorkflow(workflowId);

    /** @type {Record<string, unknown>} */
    const workflowArgs = { runId: workflowId };
    if (parsed.value !== undefined) {
      workflowArgs.medicateSearch = parsed.value;
    }

    const workflowRunTimeout = "50m";

    const workflowResult = await client.workflow.execute(OHID_LOGIN_WORKFLOW, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [workflowArgs],
      workflowRunTimeout,
    });

    // ✅ NEW CHANGE: Same object as Temporal “Result” + alias `response` for clients
    res.status(200).json({
      ok: true,
      workflowId,
      workflowResult,
      response: workflowResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("medicate-availability-check-await-result error:", message);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/otp-status", async (req, res) => {
  try {
    const workflowId =
      typeof req.query?.workflowId === "string" ? req.query.workflowId.trim() : undefined;
    const scope = req.query?.scope === "ohid" ? "ohid" : "availity";
    const status = await getOtpStatus(workflowId || undefined, scope);
    res.json({ ok: true, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Ingest OTP for OHID Playwright (`npm run login:ohid` / `ohidLoginWorkflow`).
 * Same on-disk store as Twilio (different active-workflow file). Playwright polls until code appears.
 *
 * JSON body examples:
 * - { "otp": "123456", "workflowId": "ohid-login-..." }
 * - { "text": "Your code is 123456" }  (6-digit code extracted)
 * workflowId: body, query ?workflowId=, or last active id from POST /start-ohid-login.
 */
app.post("/ingest-otp", async (req, res) => {
  if (!assertOtpIngestApiKey(req, res)) {
    return;
  }
  try {
    const q =
      typeof req.query?.workflowId === "string" && req.query.workflowId.trim() !== ""
        ? req.query.workflowId.trim()
        : null;
    const fromBody =
      typeof req.body?.workflowId === "string" && req.body.workflowId.trim() !== ""
        ? req.body.workflowId.trim()
        : null;
    let workflowId = fromBody ?? q ?? (await getActiveOhidWorkflowId());

    const rawOtp =
      typeof req.body?.otp === "number" && Number.isFinite(req.body.otp)
        ? String(Math.trunc(req.body.otp))
        : typeof req.body?.otp === "string"
          ? req.body.otp.trim()
          : typeof req.body?.code === "number" && Number.isFinite(req.body.code)
            ? String(Math.trunc(req.body.code))
            : typeof req.body?.code === "string"
              ? req.body.code.trim()
              : null;
    const blob =
      typeof req.body?.text === "string"
        ? req.body.text
        : typeof req.body?.message === "string"
          ? req.body.message
          : typeof req.body?.body === "string"
            ? req.body.body
            : "";

    let otp = rawOtp && /^\d{4,8}$/.test(rawOtp) ? rawOtp : null;
    if (!otp && blob) {
      otp = extractOtpFromText(blob);
    }

    if (!otp) {
      res.status(400).json({
        ok: false,
        error:
          "Missing or invalid OTP. Send JSON { \"otp\": \"123456\" } or { \"text\": \"… email body …\" } with a 6-digit code.",
      });
      return;
    }

    if (!workflowId) {
      res.status(409).json({
        ok: false,
        error:
          "No workflowId. Pass ?workflowId= or JSON workflowId, or start OHID with POST /start-ohid-login so an active OHID workflow id is registered.",
      });
      return;
    }

    await storeOtpForWorkflow(workflowId, otp);
    console.log(`[ingest-otp] stored OTP for OHID workflowId=${workflowId}`);

    res.status(200).json({
      ok: true,
      workflowId,
      message: "OTP stored. OHID Playwright reads this file until the MFA step submits the code.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ingest-otp error:", message);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/temporal-health", async (_req, res) => {
  const injected = globalThis.__TEMPORAL_INJECTED__;
  if (injected?.connection) {
    const ns = injected.namespace ?? TEMPORAL_NAMESPACE;
    res.json({
      ok: true,
      message: "Embedded Temporal dev server (in-process connection)",
      mode: "embedded",
      namespace: ns,
      taskQueue: TASK_QUEUE,
      workflowType: AVAILITY_LOGIN_WORKFLOW,
      webUiHint: TEMPORAL_UI_URL,
      nextSteps: [
        `Open ${TEMPORAL_UI_URL} and select namespace "${ns}".`,
        "Worker must log RUNNING; then Submit login on /.",
      ],
    });
    return;
  }

  let connection;
  try {
    connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    await connection.close();
    res.json({
      ok: true,
      message: "Temporal server reachable (gRPC)",
      mode: "remote",
      address: TEMPORAL_ADDRESS,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: TASK_QUEUE,
      workflowType: AVAILITY_LOGIN_WORKFLOW,
      webUiHint: TEMPORAL_UI_URL,
      note: "The Web UI (:8233) shows workflow *runs*. It stays at 0 until you start one: open this API’s home page (GET /) and click Submit login, or POST /start-login. gRPC (:7233) is separate from the UI port.",
      nextSteps: [
        "Keep `temporal server start-dev` running and `npm run start:app` (worker must log RUNNING).",
        `Start a workflow: POST /start-login or open GET / in a browser and Submit — then ${TEMPORAL_UI_URL} shows the run.`,
        `In Web UI, namespace "${TEMPORAL_NAMESPACE}" — refresh Workflows after submit.`,
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({
      ok: false,
      error: message,
      address: TEMPORAL_ADDRESS,
      fix: [
        "No Docker:  npm start  (embedded Temporal + app)",
        "Docker:      npm run start:docker",
        "CLI install: https://docs.temporal.io/cli  then temporal server start-dev",
        "Set TEMPORAL_UI_URL if your Web UI is not on :8233 (Docker UI is often :8080).",
      ],
    });
  }
});

const PORT_FALLBACK_ATTEMPTS = 15;

/**
 * @param {number} [preferredPort]
 * @returns {Promise<{ server: import('node:http').Server; port: number }>}
 */
export function startApiServer(preferredPort = PORT) {
  return new Promise((resolve, reject) => {
    let port = preferredPort;
    const maxPort = preferredPort + PORT_FALLBACK_ATTEMPTS;

    function attempt() {
      const server = app
        .listen(port, () => {
          if (port !== preferredPort) {
            console.warn(
              `[API] Port ${preferredPort} is in use (EADDRINUSE). Using ${port} instead. Set API_PORT=${port} in .env or stop the other app.`,
            );
          }
          console.log(`API listening on http://localhost:${port}`);
          const grpcLabel =
            globalThis.__TEMPORAL_INJECTED__?.connection != null
              ? "embedded"
              : TEMPORAL_ADDRESS;
          console.log(`Temporal client: ${grpcLabel}  namespace="${TEMPORAL_NAMESPACE}"  taskQueue="${TASK_QUEUE}"`);
          console.log(`Temporal Web UI:   ${TEMPORAL_UI_URL}  (namespace: ${TEMPORAL_NAMESPACE})`);
          console.log("  GET  /               (submit login → starts workflow)");
          console.log("  POST /start-login");
          console.log("  POST /start-ohid-login  (Temporal workflow: runs OHID Playwright on the worker)");
          console.log("  POST /ohid-login     (starts OHID Playwright — npm run login:ohid; optional OHID_HTTP_API_KEY)");
          console.log("  POST /ingest-otp     (n8n/Gmail OTP → OHID login; optional OTP_INGEST_API_KEY)");
          console.log(`  GET  http://localhost:${port}/temporal-health  (Temporal must be running first)`);
          console.log("  POST /webhook/twilio   GET /otp-status");
          // ✅ NEW CHANGE
          console.log(
            `  POST /medicate-availability-check-await-result  (blocks until done; JSON includes eligibilityCompanyMatch)`,
          );
          resolve({ server, port });
        })
        .on("error", (err) => {
          const e = /** @type {NodeJS.ErrnoException} */ (err);
          if (e.code === "EADDRINUSE" && port < maxPort) {
            port += 1;
            attempt();
            return;
          }
          if (e.code === "EADDRINUSE") {
            reject(
              new Error(
                `No free port between ${preferredPort} and ${maxPort}. Set API_PORT in .env or run: netstat -ano | findstr :${preferredPort}`,
              ),
            );
            return;
          }
          reject(err);
        });
    }

    attempt();
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startApiServer(PORT).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
