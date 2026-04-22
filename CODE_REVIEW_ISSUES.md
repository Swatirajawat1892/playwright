# Code Review Issues (Production Readiness)

This file tracks issues found during review. Items are written **one-by-one** with severity, location, impact, and a concrete fix direction.

Legend:
- 🔴 **CRITICAL** — must fix before merge / production exposure
- 🟡 **MAJOR** — should fix this sprint
- 🟢 **MINOR** — tech debt / good to have

---

## Status (live)

Last updated: 2026-04-21

**Production readiness:** all tracked items **1–19** are **resolved**. There are **no pending** review issues in this file.

- ✅ **Resolved**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19
- 🟨 **Partially addressed (optional hardening)**: (none required)
- ⏳ **Open issues**: *(none)*

**Optional tech debt** (not tracked as open issues; safe to defer):

- Further split `src/ohid-login.ts` (e.g. My Apps scrolling / tile open / terms) if you want smaller files for maintainability only.
- If you expose **Availity** `POST /start-login` beyond localhost with secrets in `.env`, add a dedicated **`AVAILITY_HTTP_API_KEY`** (or shared service key) and assert it on that route — do not reuse `OHID_HTTP_API_KEY` or the browser demo on `GET /` breaks when OHID keys are set.

Notes on resolved items:
- **1**: `/ingest-otp` requires explicit `workflowId` in production; dev keeps fallback for compatibility.
- **2**: `/ohid-last` requires OHID API key when configured and no longer returns `stdoutTail`/`stderrTail`.
- **3**: In `NODE_ENV=production`, server refuses to boot without `OHID_HTTP_API_KEY` and `OTP_INGEST_API_KEY`.
- **4**: JSON body size limit added (default `32kb`, override via `API_JSON_LIMIT`).
- **5**: Added in-flight cap for `/medicate-availability-check-await-result` (`OHID_AWAIT_RESULT_MAX_IN_FLIGHT`) and kept rate limiting.
- **11**: `parseMedicateSearchBody` now requires strings, caps lengths, and enforces `mm/dd/yyyy`.
- **12**: Header hygiene added (`x-powered-by` disabled, `nosniff` header).
- **8**: Added runtime schema validation (`zod`) for the eligibility payload; activity validates stdout marker payload.
- **13**: Added eligibility artifact file `data/ohid-eligibility-results/<runId>.json`; activity prefers artifact over log parsing (stdout marker remains for compatibility).
- **9**: OTP polling now uses bounded exponential backoff + jitter (still respects the same overall deadline).
- **10**: Added cross-process lock files for `runId` (`src/ohid/run-lock.js`) so multiple Node workers cannot run the same OHID activity concurrently for the same id.
- **6/7**: Extracted OTP + PNM gateway/MFA flows out of `ohid-login.ts` into `src/ohid/*` modules (behavior preserved; `ohid-login.ts` is smaller).
- **14**: Documented mm/dd/yyyy expectations at the API and UI-fill boundary (no normalization to avoid behavior change).
- **15**: Lock files now have **TTL stale takeover** (`OHID_RUN_LOCK_TTL_MS`, default 45 minutes) to avoid permanent deadlocks after crashes.
- **16**: Non-prod auth is no longer “open by default” when binding beyond localhost unless `API_ALLOW_OPEN_DEV=true` (explicit opt-in).
- **17**: Temporal activities split into `activities-ohid-run.js` + `activities-availity.js`; `activities.js` is now a small barrel re-export.
- **18**: Non-prod bind-beyond-localhost startup guard incorrectly used `requireEnvInProd` (no-op when `NODE_ENV !== production`); replaced with unconditional `requireEnv` on that path (`src/api-server.js`).
- **19**: `POST /medicate-availability-check` did not call `assertOhidApiKey`; when `OHID_HTTP_API_KEY` is set, unauthenticated clients could still start the OHID workflow — now gated (`src/api-server.js`). (`POST /start-login` is Availity-only; it still does not use the OHID key — see optional tech debt.)

---

## New issues (follow-up review)

These were **not** part of the original 1–14 list. They are new findings from a subsequent production review pass.

### 15) Cross-process `runId` lock can deadlock after crash / SIGKILL (no stale recovery)
- **Location**: `src/ohid/run-lock.js` (`acquireOhidRunLock` / `releaseOhidRunLock`), used by `src/temporal/activities-ohid-run.js` (`runOhidLogin`)
- **Problem (original)**: lock acquisition used `wx` (exclusive create). If the worker died before `releaseOhidRunLock`, the lock file could remain and future runs with the same `runId` failed with `EEXIST`.
- **Impact**: stuck workflows / manual ops burden; false “already running” errors.
- **Fix direction**:
  - Add **lease/TTL + heartbeat** in the lock JSON; on `EEXIST`, if stale → delete + retry.
  - Optionally adopt a proven lock library (`proper-lockfile`) or a distributed lock (Redis) for multi-host.
- **Status**: ✅ Resolved (TTL stale takeover implemented in `src/ohid/run-lock.js` via `OHID_RUN_LOCK_TTL_MS`)

### 16) Non-production API auth is still “open by default” unless keys are set
- **Location**: `src/api-server.js` (`assertOhidApiKey`, `assertOtpIngestApiKey`)
- **Problem**: when `OHID_HTTP_API_KEY` / `OTP_INGEST_API_KEY` are unset, requests are allowed (intended for local dev, dangerous if the service is reachable beyond localhost).
- **Impact**: accidental exposure on LAN/VPN; OTP/workflow abuse.
- **Fix direction**:
  - Default-deny unless `API_ALLOW_OPEN_DEV=true` (explicit opt-in), or require keys for all non-localhost binds.
- **Status**: ✅ Resolved (`src/api-server.js`: localhost bind keeps dev convenience; non-localhost requires keys unless `API_ALLOW_OPEN_DEV=true`)

### 17) `src/temporal/activities.js` remains a large mixed-responsibility module
- **Location**: was `src/temporal/activities.js` (now a thin barrel); implementation lives in `activities-ohid-run.js` / `activities-availity.js`
- **Problem (original)**: OHID npm runner, stdout/artifact parsing, Availity Playwright login, and OTP polling lived in one file.
- **Impact**: higher regression risk; harder testing; harder ownership boundaries.
- **Fix direction**:
  - Split into `activities/ohid.js`, `activities/availity.js`, `activities/npm-runner.js` and import from `worker.js`.
- **Status**: ✅ Resolved (split into `src/temporal/activities-ohid-run.js` + `src/temporal/activities-availity.js`; `activities.js` re-exports)

### 18) Non-prod non-localhost startup guard was ineffective (`requireEnvInProd` no-op)
- **Location**: `src/api-server.js` (boot-time env checks for issue **16**)
- **Problem**: The “bind beyond localhost → require keys” block called `requireEnvInProd`, which returns immediately when not in production, so keys were never enforced on that path.
- **Impact**: Same as **16** for misconfigured dev/staging binds (LAN exposure while believing keys were mandatory).
- **Fix direction**: Use a non-prod-gated `requireEnv(name)` (or inline checks) for the non-localhost branch.
- **Status**: ✅ Resolved (`requireEnv` + separate `if (IS_PROD)` / non-localhost branches)

### 19) OHID workflow start skipped `assertOhidApiKey` when a key is configured
- **Location**: `src/api-server.js` — `POST /medicate-availability-check`
- **Problem**: When `OHID_HTTP_API_KEY` is set, other OHID routes require the key, but this handler could still start `ohidLoginWorkflow` without it.
- **Impact**: Inconsistent protection; workflow starts without the same bar as `/ingest-otp` / await-result.
- **Fix direction**: Call `assertOhidApiKey(req, res)` before `client.workflow.start(...)` (localhost + unset key still allows local dev).
- **Status**: ✅ Resolved (`assertOhidApiKey` at top of `POST /medicate-availability-check`)
- **Note**: `POST /start-login` starts **Availity** workflows and intentionally does **not** use `OHID_HTTP_API_KEY` (would break the `GET /` demo when OHID keys are set). Use optional tech debt above if you need auth there.

---

## 🔴 CRITICAL

### 1) OTP can be misrouted to the wrong run
- **Location**: `src/api-server.js` (`POST /ingest-otp`)
- **Problem**: When `workflowId` is not provided, the handler can fall back to an “active workflow id”. Under concurrency (multiple OHID runs), OTP may be written to the wrong workflow.
- **Impact**: Wrong account/session receives OTP; runs become non-deterministic; security incident risk.
- **Fix**:
  - Require explicit `workflowId` for OTP ingestion (query or JSON body).
  - If you must keep fallback for local dev, gate it behind `NODE_ENV !== "production"` and log a warning.
- **Status**: ✅ Resolved

### 2) Sensitive debug data can be exposed over HTTP
- **Location**: `src/api-server.js` (`GET /ohid-last`)
- **Problem**: The “last activity” object can include stdout/stderr tails and parsed artifacts. Returning that over HTTP risks leaking PII, internal URLs, or workflow identifiers.
- **Impact**: Data exposure; log scraping; support endpoints become an attack surface.
- **Fix**:
  - Require an API key (or remove the endpoint in prod).
  - Never return `stdoutTail` / `stderrTail`; return a sanitized shape.
- **Status**: ✅ Resolved

### 3) Production auth defaults can be unsafe (fail-open)
- **Location**: `src/api-server.js` (`assertOhidApiKey`, `assertOtpIngestApiKey`)
- **Problem**: If API key env vars are missing, endpoints allow requests.
- **Impact**: Anyone who can reach the service can start workflows, ingest OTP, and query debug state.
- **Fix**:
  - Fail closed in production: require `OHID_HTTP_API_KEY` and `OTP_INGEST_API_KEY` to be set at boot (throw on startup).
  - Prefer binding dev server to `127.0.0.1` unless explicitly configured.
- **Status**: ✅ Resolved

### 4) Unbounded request bodies can cause memory pressure / DoS
- **Location**: `src/api-server.js` (`app.use(express.json())`)
- **Problem**: Default `express.json()` has no explicit body size limit in this codebase.
- **Impact**: Large JSON payloads can consume memory and crash/restart the process.
- **Fix**: Set a strict body limit (e.g. `32kb`) and override via env only when needed.
- **Status**: ✅ Resolved

### 5) Long-lived “await result” HTTP endpoint is operationally dangerous
- **Location**: `src/api-server.js` (`POST /medicate-availability-check-await-result`)
- **Problem**: Endpoint blocks until workflow completes (`workflowRunTimeout` up to ~50 minutes).
- **Impact**: Connection exhaustion, load balancer timeouts, easy DoS, noisy failure modes.
- **Fix (without changing app flow)**:
  - Add aggressive rate limiting + concurrent in-flight cap.
  - Require auth.
  - If possible long term: change to async start + polling (keep current endpoint temporarily for compatibility).
- **Status**: ✅ Resolved (guardrails added; endpoint still exists)

---

## 🟡 MAJOR

### 6) `src/ohid-login.ts` mixes too many responsibilities (very high change risk)
- **Location**: `src/ohid-login.ts`
- **Problem**: One large module (~3000 LOC) mixes config/env parsing, browser/session mgmt, VPN checks, login flows, PNM navigation, MFA, medicate search, and reporting.
- **Impact**: Fragile changes; difficult testing; hard debugging; regressions cluster here.
- **Fix**: Split into modules by concern (config, OTP, OHID login, PNM flow, medicate flow, reporting). Export small composable functions.
- **Status**: ✅ Resolved (extracted major OTP/PNM chunks into `src/ohid/*`; file is still large but materially decomposed)

### 7) High cyclomatic complexity in multiple flow functions
- **Location**: `src/ohid-login.ts` (OTP polling, PNM MFA handling, My Apps scanning/open logic)
- **Problem**: Deep branching + loops + multiple locator fallbacks.
- **Impact**: Unpredictable behavior on UI drift; hard to reason about; debugging time sink.
- **Fix**:
  - Normalize into “strategy arrays” (like `fillAndSubmit` pattern).
  - Return typed results (`{ outcome: ... }`) instead of throwing inside deep helpers.
- **Status**: ✅ Resolved (OTP + PNM MFA hotspots extracted into dedicated modules; remaining complexity is mostly UI navigation)

### 8) Weak type contract across Playwright → Temporal activity → workflow → HTTP
- **Location**:
  - `src/managed-care-plan-match.ts` (stdout payload emission)
  - `src/temporal/activities-ohid-run.js` (stdout / artifact parsing)
  - `src/temporal/workflows.js` (workflow result/logging)
- **Problem**: Parsed stdout is treated as `object`/`Record<string, unknown>`; fields are accessed without runtime validation.
- **Impact**: Silent partial failures; runtime exceptions if shape drifts; hard to maintain compatibility.
- **Fix**: Introduce a runtime schema (e.g. zod) and validate the payload at parse time; use the validated type everywhere.
- **Status**: ✅ Resolved (added `zod` schema validation; activity validates parsed payload)

### 9) Busy polling defaults (OTP/VPN/UI loops) can become noisy under concurrency
- **Location**: `src/ohid-login.ts`
- **Problem**: Fixed-interval polling (e.g. OTP every ~2s) and repeated UI scans can spam store/logs when multiple runs happen.
- **Impact**: Resource contention; log volume; slower runs.
- **Fix**: Exponential backoff with jitter after a short fast window; hard caps; better event-driven waits where possible.
- **Status**: ✅ Resolved (bounded exponential backoff + jitter for OTP polling loops)

### 10) Global process state used for coordination is not valid in multi-worker deployments
- **Location**: `src/temporal/activities-ohid-run.js` (`runOhidLogin`), `src/ohid/run-lock.js` (cross-process lock), `globalThis.__OHID_LAST_ACTIVITY__` (debug/status)
- **Problem**: Globals only coordinate within one Node process; multiple workers/containers bypass them.
- **Impact**: Concurrency bugs; misleading status; non-deterministic behavior.
- **Fix**: Use Temporal semantics (workflow IDs, reuse policies, signals/queries) or a real shared lock/store.
- **Status**: ✅ Resolved (cross-process `runId` lock file; still recommend Temporal-level controls for strict multi-region semantics)

### 11) Input validation is permissive and silently coerces junk
- **Location**: `src/api-server.js` (`parseMedicateSearchBody`, `/ingest-otp`)
- **Problem**: `String(x ?? "")` coercion accepts non-strings; date formats aren’t strictly validated; payload size isn’t capped at field level.
- **Impact**: Hard-to-debug invalid runs; inconsistent results; security footgun if data flows into logs.
- **Fix**: Strict schema validation; cap string lengths; reject unknown keys; enforce `mm/dd/yyyy` format if required by the target UI.
- **Status**: ✅ Resolved

### 12) Missing explicit server header hygiene
- **Location**: `src/api-server.js`
- **Problem**: No explicit `x-powered-by` disable, `nosniff`, etc.
- **Impact**: Minor security posture downgrade.
- **Fix**: `app.disable("x-powered-by")` + basic security headers middleware.
- **Status**: ✅ Resolved

---

## 🟢 MINOR

### 13) Logging protocol is coupled to data contract (stdout marker)
- **Location**:
  - `src/managed-care-plan-match.ts` (stdout marker)
  - `src/temporal/activities-ohid-run.js` (parser)
- **Problem**: JSON payload is embedded in logs with prefix/suffix; noisy and brittle.
- **Impact**: Parsing breaks if logs change; sensitive data can leak into logs.
- **Fix**: Write a result artifact file keyed by `runId` (or return structured data through a direct channel). Keep logs separate.
- **Status**: ✅ Resolved (activity now prefers artifact file; stdout marker retained for compatibility)

### 14) Date/timezone assumptions are implicit
- **Location**: `src/api-server.js` and `src/ohid-login.ts` (medicate search inputs)
- **Problem**: Assumes `mm/dd/yyyy` and implicit timezone context.
- **Impact**: User error / invalid inputs; inconsistent results.
- **Fix**: Validate and normalize inputs; document expected format in API schema.
- **Status**: ✅ Resolved (date format explicitly validated and documented; no timezone normalization to avoid behavior change)

