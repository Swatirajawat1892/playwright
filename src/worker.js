/**
 * Temporal worker: Availity login workflows + Playwright / OTP poll activities.
 */
import { Worker, NativeConnection } from "@temporalio/worker";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import * as availityActivities from "./temporal/activities-availity.js";
import * as ohidActivities from "./temporal/activities-ohid-run.js";
import { AVAILITY_ACTIVITY_TYPE, OHID_ACTIVITY_TYPE } from "./temporal/activity-type-names.js";

const activities = {
  // Friendly activity type names (UI)
  [AVAILITY_ACTIVITY_TYPE.PERFORM_LOGIN]: availityActivities.performLoginAttempt,
  [AVAILITY_ACTIVITY_TYPE.POLL_OTP]: availityActivities.pollOtpFromStore,
  [AVAILITY_ACTIVITY_TYPE.SUBMIT_OTP]: availityActivities.submitOtpAndConfirm,

  [OHID_ACTIVITY_TYPE.SIGN_IN]: ohidActivities.ohidPlaywrightLogin,
  [OHID_ACTIVITY_TYPE.ELIGIBILITY]: ohidActivities.ohidPlaywrightEligibility,
  [OHID_ACTIVITY_TYPE.PARSE_ELIGIBILITY]: ohidActivities.ohidParseEligibility,
  [OHID_ACTIVITY_TYPE.FETCH_BILLING_AUTH]: ohidActivities.ohidFetchBillingAuth,
  [OHID_ACTIVITY_TYPE.FETCH_LOOKUP_DATA]: ohidActivities.ohidFetchLookupData,
  [OHID_ACTIVITY_TYPE.ADD_NON_ENCOUNTER_TASK]: ohidActivities.ohidAddNonEncounterTask,
  [OHID_ACTIVITY_TYPE.OPEN_PNM]: ohidActivities.ohidPlaywrightOpenPnm,
  [OHID_ACTIVITY_TYPE.RUN_PLAYWRIGHT]: ohidActivities.ohidRunPlaywright,
  [OHID_ACTIVITY_TYPE.RUN_OHID_LOGIN]: ohidActivities.runOhidLogin,

  // Legacy activity type names (backward compatibility)
  performLoginAttempt: availityActivities.performLoginAttempt,
  pollOtpFromStore: availityActivities.pollOtpFromStore,
  submitOtpAndConfirm: availityActivities.submitOtpAndConfirm,

  ohidPlaywrightLogin: ohidActivities.ohidPlaywrightLogin,
  ohidPlaywrightEligibility: ohidActivities.ohidPlaywrightEligibility,
  ohidParseEligibility: ohidActivities.ohidParseEligibility,
  ohidFetchBillingAuth: ohidActivities.ohidFetchBillingAuth,
  ohidFetchLookupData: ohidActivities.ohidFetchLookupData,
  ohidAddNonEncounterTask: ohidActivities.ohidAddNonEncounterTask,
  ohidPlaywrightOpenPnm: ohidActivities.ohidPlaywrightOpenPnm,
  ohidRunPlaywright: ohidActivities.ohidRunPlaywright,
  runOhidLogin: ohidActivities.runOhidLogin,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? "availity-login";
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";

/**
 * @param {{ nativeConnection?: import('@temporalio/worker').NativeConnection }} [options]
 */
export async function runWorker(options = {}) {
  console.log("[Temporal] Registered activities:", Object.keys(activities));
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
