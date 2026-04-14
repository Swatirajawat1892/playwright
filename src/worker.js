/**
 * Temporal worker: Availity login workflows + Playwright / OTP poll activities.
 */
import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as activities from "./temporal/activities.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "availity-login";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";

/**
 * @param {{ nativeConnection?: import('@temporalio/worker').NativeConnection }} [options]
 */
export async function runWorker(options = {}) {
  let connection;
  if (options.nativeConnection) {
    connection = options.nativeConnection;
  } else {
    try {
      connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n[Temporal] Cannot connect to ${TEMPORAL_ADDRESS}: ${msg}`);
      console.error("  → CLI dev:    temporal server start-dev   (gRPC :7233, UI :8233 — match TEMPORAL_ADDRESS in .env)");
      console.error("  → App+worker: npm run start:app  or  npm run dev");
      console.error("  → Embedded:   npm start   (separate ports; see .env comments)");
      console.error("  → Docker:     npm run temporal:up  then  npm run start:app\n");
      throw err;
    }
  }

  const worker = await Worker.create({
    connection,
    namespace: TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowsPath: join(__dirname, "temporal", "workflows.js"),
    activities,
  });

  const target =
    options.nativeConnection || process.env.TEMPORAL_EMBEDDED === "true"
      ? "embedded dev server"
      : TEMPORAL_ADDRESS;
  console.log(`[Temporal] Worker RUNNING — task queue "${TASK_QUEUE}" @ ${target} namespace="${TEMPORAL_NAMESPACE}"`);
  console.log(
    "[Temporal] Workflows and activities appear in Web UI under that namespace after you Submit login.",
  );
  await worker.run();
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runWorker({}).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
