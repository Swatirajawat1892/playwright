/**
 * Single process: HTTP API + Temporal worker (one terminal).
 * Starts both in parallel so the worker polls the task queue while the API accepts requests.
 *
 * OHID Playwright does not start here — only when you POST /medicate-availability-check (Temporal)
 * or, if enabled, POST /ohid-login (see OHID_ENABLE_DIRECT_PLAYWRIGHT_ENDPOINT in .env).
 */
import { pathToFileURL } from "node:url";
import { PORT, startApiServer, printTemporalBanner } from "./api-server.js";
import { runWorker } from "./worker.js";

/**
 * @param {{ nativeConnection?: import('@temporalio/worker').NativeConnection }} [opts]
 */
export async function runApp(opts = {}) {
  printTemporalBanner("starting");
  const apiPromise = startApiServer(PORT);
  const workerPromise = runWorker(
    opts.nativeConnection ? { nativeConnection: opts.nativeConnection } : {},
  );

  await Promise.all([apiPromise, workerPromise]);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runApp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
