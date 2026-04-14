/**
 * Docker Temporal stack → wait for gRPC → API + worker.
 * Usage: npm run start:docker
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Connection } from "@temporalio/client";
import { runApp } from "../src/run-app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const COMPOSE_FILE = join(PROJECT_ROOT, "docker-compose.temporal.yml");

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const WAIT_MS = Number(process.env.TEMPORAL_START_WAIT_MS ?? "120000");
const POLL_MS = 2000;

async function main() {
  if (process.env.SKIP_TEMPORAL_DOCKER === "true") {
    console.log("[Temporal] SKIP_TEMPORAL_DOCKER=true — not running docker compose.\n");
    await runApp();
    return;
  }

  dockerComposeUp();
  await waitForTemporalGrpc();
  await runApp();
}

function dockerComposeUp() {
  console.log("\n[Temporal] Starting Docker stack (postgres + server + UI)…\n");
  const result = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "up", "-d", "--pull", "missing"],
    {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    console.error("[Temporal] Docker error:", result.error.message);
    console.error("  Install/start Docker Desktop, then run npm start again.\n");
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[Temporal] docker compose exited with code ${result.status ?? "unknown"}\n`);
    process.exit(1);
  }
}

async function waitForTemporalGrpc() {
  const deadline = Date.now() + WAIT_MS;
  process.stdout.write(`[Temporal] Waiting for gRPC at ${TEMPORAL_ADDRESS}`);
  while (Date.now() < deadline) {
    try {
      const conn = await Connection.connect({ address: TEMPORAL_ADDRESS });
      await conn.close();
      console.log(" — ready.\n");
      console.log("[Temporal] Web UI: http://localhost:8080  (namespace: default)\n");
      return;
    } catch {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  console.log("\n");
  console.error(`[Temporal] Timed out after ${WAIT_MS}ms — not reachable at ${TEMPORAL_ADDRESS}`);
  console.error("  Try: npm run temporal:logs");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
