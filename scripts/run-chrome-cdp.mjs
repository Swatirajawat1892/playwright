/**
 * Loads .env then runs start-chrome-cdp.ps1 so CHROME_PROFILE_DIRECTORY / OHID_CDP_PORT apply.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ps1 = join(__dirname, "start-chrome-cdp.ps1");

const r = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
  { stdio: "inherit", env: process.env },
);

process.exit(r.status ?? (r.error ? 1 : 0));
