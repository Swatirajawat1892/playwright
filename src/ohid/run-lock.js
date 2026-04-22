import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

function sanitizeRunId(runId) {
  const s = String(runId ?? "").trim();
  if (!s) return "";
  // Keep filesystem-safe + stable across OSes.
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) {
    throw new Error(`Invalid runId for lock path: ${s}`);
  }
  return s;
}

function locksDir() {
  const base = (process.env.OHID_RUN_LOCK_DIR || "").trim() || join(PROJECT_ROOT, "data", "locks", "ohid-runs");
  return isAbsolute(base) ? base : join(PROJECT_ROOT, base);
}

function lockFilePath(runId) {
  return join(locksDir(), `${sanitizeRunId(runId)}.lock.json`);
}

function lockTtlMs() {
  const raw = (process.env.OHID_RUN_LOCK_TTL_MS || "").trim();
  const n = raw ? Number(raw) : NaN;
  // Default: 45 minutes — should exceed normal OHID activity duration but recover from crashes quickly.
  const fallback = 45 * 60 * 1000;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // Clamp to avoid absurd values.
  return Math.min(24 * 60 * 60 * 1000, Math.max(60_000, Math.floor(n)));
}

async function tryUnlinkIfStale(path) {
  let st;
  try {
    st = await stat(path);
  } catch {
    return false;
  }

  const now = Date.now();
  const ageMs = now - st.mtimeMs;

  // Prefer JSON startedAt if present (more accurate than mtime on some FS).
  let startedAtMs = null;
  try {
    const txt = await readFile(path, "utf8");
    const j = JSON.parse(txt);
    if (j && typeof j.startedAt === "string") {
      const t = Date.parse(j.startedAt);
      if (Number.isFinite(t)) startedAtMs = t;
    }
  } catch {
    // ignore parse errors — fall back to mtime age
  }

  const ttl = lockTtlMs();
  const tooOld = startedAtMs != null ? now - startedAtMs > ttl : ageMs > ttl;
  if (!tooOld) return false;

  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive cross-process lock for an OHID run.
 * Uses O_EXCL file creation (atomic on local filesystems).
 *
 * @param {string} runId
 * @returns {Promise<{ path: string, fd: import("node:fs/promises").FileHandle } | null>}
 */
export async function acquireOhidRunLock(runId) {
  const rid = String(runId ?? "").trim();
  if (!rid) return null;

  const path = lockFilePath(rid);
  await mkdir(dirname(path), { recursive: true });

  const payload = JSON.stringify(
    {
      runId: rid,
      pid: process.pid,
      host: (process.env.COMPUTERNAME || process.env.HOSTNAME || "").trim() || "unknown",
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = await open(path, "wx");
      await fd.writeFile(payload, "utf8");
      return { path, fd };
    } catch (e) {
      const code = e && typeof e === "object" && "code" in e ? /** @type {any} */ (e).code : "";
      if (code === "EEXIST") {
        const removed = await tryUnlinkIfStale(path);
        if (removed) {
          continue;
        }
        throw new Error(`OHID login already running for runId=${rid} (lock exists: ${path})`);
      }
      throw e;
    }
  }

  throw new Error(`Could not acquire OHID run lock after stale cleanup retries: ${path}`);
}

/**
 * @param {{ path: string, fd: import("node:fs/promises").FileHandle } | null} lock
 */
export async function releaseOhidRunLock(lock) {
  if (!lock) return;
  try {
    await lock.fd.close().catch(() => undefined);
  } catch {
    /* ignore */
  }
  try {
    await unlink(lock.path);
  } catch {
    /* ignore */
  }
}
