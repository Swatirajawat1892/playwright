/**
 * npm start — no Docker.
 * Starts an embedded Temporal dev server via @temporalio/testing (downloads Temporal CLI to %TEMP% on first run),
 * enables Web UI, then runs API + worker on the same connections.
 */
import "dotenv/config";
import { TestWorkflowEnvironment } from "@temporalio/testing";

const namespace = process.env.TEMPORAL_NAMESPACE?.trim() || "default";
// Default ports avoid clashing with Docker / CLI dev server on 7233 & 8233.
const grpcPort = Number(process.env.TEMPORAL_DEV_SERVER_PORT ?? "17233");
const uiPort = Number(process.env.TEMPORAL_UI_PORT ?? "18233");

process.env.TEMPORAL_NAMESPACE = namespace;
process.env.TEMPORAL_EMBEDDED = "true";
process.env.TEMPORAL_ADDRESS = `127.0.0.1:${grpcPort}`;
process.env.TEMPORAL_UI_URL = `http://127.0.0.1:${uiPort}`;

console.log("\n[Temporal] Starting embedded dev server (first run may download the CLI binary)…\n");

let testEnv;
try {
  testEnv = await TestWorkflowEnvironment.createLocal({
    server: {
      namespace,
      ip: "127.0.0.1",
      port: grpcPort,
      ui: true,
      uiPort,
    },
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[Temporal] Failed to start embedded server:", msg);
  console.error("  Try: npm run start:docker  (with Docker)  or install Temporal CLI manually.\n");
  process.exit(1);
}

globalThis.__TEMPORAL_INJECTED__ = {
  connection: testEnv.connection,
  namespace: testEnv.namespace ?? namespace,
};

const shutdown = async () => {
  try {
    console.log("\n[Temporal] Shutting down embedded server…");
    await testEnv.teardown();
  } catch {
    /* ignore */
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `[Temporal] Embedded server ready. gRPC 127.0.0.1:${grpcPort}  Web UI: ${process.env.TEMPORAL_UI_URL}  namespace: ${namespace}`,
);
console.log("[Temporal] First startup can take ~30s while the dev server boots.\n");
console.log("\n>>> TEMPORAL WEB UI FOR THIS APP (your workflows only show here):");
console.log(`>>>   ${process.env.TEMPORAL_UI_URL}`);
console.log(">>> NOT http://localhost:8233 unless you set TEMPORAL_UI_PORT=8233 — :8233 is often another empty server.\n");

const { runApp } = await import("../src/run-app.js");
await runApp({ nativeConnection: testEnv.nativeConnection });
