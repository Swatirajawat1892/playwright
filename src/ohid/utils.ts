export function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export function jittered(ms: number): number {
  const base = Number.isFinite(ms) ? ms : 0;
  if (base <= 0) return 0;
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}

export async function pollWithBackoffUntil(
  deadlineMs: number,
  basePollMs: number,
  fn: () => Promise<boolean>,
): Promise<void> {
  let wait = Math.max(250, Math.floor(basePollMs));
  const maxWait = Math.max(wait, 10_000);
  while (Date.now() < deadlineMs) {
    if (await fn()) return;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) break;
    await sleepMs(Math.min(remaining, jittered(wait)));
    wait = Math.min(maxWait, Math.floor(wait * 1.5));
  }
}

