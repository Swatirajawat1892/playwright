/**
 * File-backed OTP store so API (Twilio webhook) and Temporal worker can share state.
 * Falls back to in-memory map if OTP_STORE_DIR is empty (single-process only).
 */
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

/** 6-digit verification codes (LinkedIn-style SMS). */
export const OTP_REGEX = /\b(\d{6})\b/;

function storeDir() {
  const raw = process.env.OTP_STORE_DIR?.trim();
  if (!raw) return join(PROJECT_ROOT, "data", "otps");
  return isAbsolute(raw) ? raw : join(PROJECT_ROOT, raw);
}

function useDisk() {
  return process.env.OTP_STORE_MEMORY_ONLY !== "true";
}

const memory = {
  /** @type {string | null} */
  activeAvailityWorkflowId: null,
  /** @type {string | null} */
  activeOhidWorkflowId: null,
  /** @type {Map<string, { otp: string, receivedAt: string }>} */
  byWorkflow: new Map(),
};

async function ensureDir() {
  if (!useDisk()) return;
  await mkdir(storeDir(), { recursive: true });
}

function activeAvailityPath() {
  return join(storeDir(), "_active_availity.json");
}

function activeOhidPath() {
  return join(storeDir(), "_active_ohid.json");
}

/** @deprecated Legacy single file — migrated to _active_availity.json */
function activePathLegacy() {
  return join(storeDir(), "_active.json");
}

function entryPath(workflowId) {
  return join(storeDir(), `${sanitize(workflowId)}.json`);
}

function sanitize(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Availity: POST /start-login + Twilio webhook default workflow.
 * @param {string} workflowId
 */
export async function registerActiveAvailityWorkflow(workflowId) {
  if (!useDisk()) {
    memory.activeAvailityWorkflowId = workflowId;
    return;
  }
  await ensureDir();
  await writeFile(
    activeAvailityPath(),
    JSON.stringify({ workflowId, kind: "availity", updatedAt: new Date().toISOString() }, null, 0),
    "utf8",
  );
}

/**
 * OHID: POST /start-ohid-login + POST /ingest-otp default workflow.
 * @param {string} workflowId
 */
export async function registerActiveOhidWorkflow(workflowId) {
  if (!useDisk()) {
    memory.activeOhidWorkflowId = workflowId;
    return;
  }
  await ensureDir();
  await writeFile(
    activeOhidPath(),
    JSON.stringify({ workflowId, kind: "ohid", updatedAt: new Date().toISOString() }, null, 0),
    "utf8",
  );
}

/**
 * @param {string} workflowId
 * @deprecated Use registerActiveAvailityWorkflow (Availity only).
 */
export async function registerActiveWorkflow(workflowId) {
  return registerActiveAvailityWorkflow(workflowId);
}

/**
 * @returns {Promise<string | null>}
 */
export async function getActiveAvailityWorkflowId() {
  if (!useDisk()) {
    return memory.activeAvailityWorkflowId;
  }
  try {
    const raw = await readFile(activeAvailityPath(), "utf8");
    const j = JSON.parse(raw);
    if (typeof j.workflowId === "string") {
      return j.workflowId;
    }
  } catch {
    /* fall through to legacy */
  }
  try {
    const raw = await readFile(activePathLegacy(), "utf8");
    const j = JSON.parse(raw);
    return typeof j.workflowId === "string" ? j.workflowId : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<string | null>}
 */
export async function getActiveOhidWorkflowId() {
  if (!useDisk()) {
    return memory.activeOhidWorkflowId;
  }
  try {
    const raw = await readFile(activeOhidPath(), "utf8");
    const j = JSON.parse(raw);
    return typeof j.workflowId === "string" ? j.workflowId : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<string | null>}
 * @deprecated Use getActiveAvailityWorkflowId or getActiveOhidWorkflowId.
 */
export async function getActiveWorkflowId() {
  return getActiveAvailityWorkflowId();
}

/**
 * @param {string} workflowId
 * @param {string} otp
 */
export async function storeOtpForWorkflow(workflowId, otp) {
  const entry = { otp, receivedAt: new Date().toISOString() };
  if (!useDisk()) {
    memory.byWorkflow.set(workflowId, entry);
    return;
  }
  await ensureDir();
  await writeFile(entryPath(workflowId), JSON.stringify(entry, null, 0), "utf8");
}

/**
 * @param {string} workflowId
 * @returns {Promise<{ otp: string, receivedAt: string } | null>}
 */
export async function peekOtp(workflowId) {
  if (!useDisk()) {
    return memory.byWorkflow.get(workflowId) ?? null;
  }
  try {
    const raw = await readFile(entryPath(workflowId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string} workflowId
 */
export async function clearOtp(workflowId) {
  if (!useDisk()) {
    memory.byWorkflow.delete(workflowId);
    return;
  }
  try {
    await unlink(entryPath(workflowId));
  } catch {
    /* ignore */
  }
}

/**
 * Status for GET /otp-status (optionally scoped).
 * @param {string | undefined} workflowId
 * @param {"availity" | "ohid" | undefined} scope When workflowId omitted, which active id to use (default availity).
 */
export async function getOtpStatus(workflowId, scope = "availity") {
  let id = workflowId;
  if (!id) {
    id =
      scope === "ohid"
        ? await getActiveOhidWorkflowId()
        : await getActiveAvailityWorkflowId();
  }
  if (!id) {
    return { workflowId: null, hasOtp: false, otp: null, receivedAt: null, scope };
  }
  const row = await peekOtp(id);
  if (!row) {
    return { workflowId: id, hasOtp: false, otp: null, receivedAt: null, scope };
  }
  return {
    workflowId: id,
    hasOtp: true,
    otp: row.otp,
    receivedAt: row.receivedAt,
    scope,
  };
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function extractOtpFromText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(OTP_REGEX);
  return m ? m[1] : null;
}
