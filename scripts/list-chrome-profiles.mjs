/**
 * Prints Chrome profile folder names under %LOCALAPPDATA%\Google\Chrome\User Data.
 * Set CHROME_PROFILE_DIRECTORY in .env to one of these (e.g. Profile 3).
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const userData = join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");

console.log(`User Data: ${userData}\n`);

try {
  const entries = await readdir(userData, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const profileLike = dirs.filter((e) => {
    const n = e.name;
    return n === "Default" || /^Profile \d+$/i.test(n) || n.startsWith("Profile ");
  });

  profileLike.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  if (profileLike.length === 0) {
    console.log("No Default / Profile * folders found. Is Chrome installed?");
    process.exit(1);
  }

  console.log("Use one of these values for CHROME_PROFILE_DIRECTORY in .env:\n");
  for (const d of profileLike) {
    const p = join(userData, d.name);
    const st = await stat(p).catch(() => null);
    const hint = st ? ` (modified ${st.mtime.toISOString().slice(0, 10)})` : "";
    console.log(`  ${d.name}${hint}`);
  }

  console.log("\nTo see which profile you’re using in Chrome: chrome://version → “Profile path”.");
  console.log("The last folder name in that path is what you set in CHROME_PROFILE_DIRECTORY.");
} catch (e) {
  console.error("Could not read User Data:", e instanceof Error ? e.message : e);
  process.exit(1);
}
