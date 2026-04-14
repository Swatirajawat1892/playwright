/**
 * Availity Playwright only — no Temporal workflow start.
 * Sets TEMPORAL_AUTO_START before linkedin-login.ts loads.
 */
process.env.TEMPORAL_AUTO_START = "false";
await import("../src/linkedin-login.ts");
