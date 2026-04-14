/**
 * ✅ NEW CHANGE — Managed Care Plans: read first "Plan Name" cell and compare to medicateSearch.companyName.
 * Emits a parseable line for the Temporal activity (stdout).
 */
import type { Page } from "playwright";

/** ✅ NEW CHANGE */
export const OHID_ELIGIBILITY_RESULT_PREFIX = "__OHID_ELIGIBILITY_RESULT__";
/** ✅ NEW CHANGE */
export const OHID_ELIGIBILITY_RESULT_SUFFIX = "__END__";

/** ✅ NEW CHANGE */
export type EligibilityCompanyMatchResult = {
  success: boolean;
  match: boolean;
  inputCompanyName: string;
  uiCompanyName: string;
  message: string;
};

/** ✅ NEW CHANGE */
export type MedicateCfgForCompanyMatch = {
  companyName?: string;
};

/** ✅ NEW CHANGE — Expand MANAGED CARE PLANS section if the Plan Name table is not visible yet. */
async function ensureManagedCarePlansSectionExpanded(formPage: Page): Promise<void> {
  const planTable = formPage
    .locator("table")
    .filter({
      has: formPage.locator("th, td").filter({ hasText: /Plan\s*Name/i }),
    })
    .first();
  if (await planTable.isVisible().catch(() => false)) {
    return;
  }

  const toggles = [
    formPage.getByRole("link", { name: /MANAGED\s+CARE\s+PLANS/i }).first(),
    formPage.getByRole("button", { name: /MANAGED\s+CARE\s+PLANS/i }).first(),
    formPage.locator("a, span, div, h2, h3, h4, td").filter({ hasText: /^[\s+]*MANAGED\s+CARE\s+PLANS/i }).first(),
  ];
  for (const t of toggles) {
    try {
      if ((await t.count()) === 0) continue;
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.scrollIntoViewIfNeeded().catch(() => undefined);
      await t.click({ timeout: 10_000, force: true });
      await new Promise<void>((r) => setTimeout(r, 600));
      if (await planTable.isVisible().catch(() => false)) {
        console.log("[OHID] ✅ NEW CHANGE: Expanded MANAGED CARE PLANS panel.");
        return;
      }
    } catch {
      /* try next */
    }
  }
}

/** ✅ NEW CHANGE — First data row, first cell (Plan Name column). */
async function readFirstPlanNameCell(formPage: Page): Promise<string> {
  const table = formPage
    .locator("table")
    .filter({
      has: formPage.locator("th, td").filter({ hasText: /Plan\s*Name/i }),
    })
    .first();
  await table.waitFor({ state: "visible", timeout: 25_000 }).catch(() => undefined);
  const cell = table.locator("tbody tr").first().locator("td").first();
  const text = (await cell.innerText().catch(() => "")).trim();
  return text;
}

/** ✅ NEW CHANGE */
function emitStdoutMarkerAndLogs(result: EligibilityCompanyMatchResult): void {
  const payload = `${OHID_ELIGIBILITY_RESULT_PREFIX}${JSON.stringify(result)}${OHID_ELIGIBILITY_RESULT_SUFFIX}`;
  console.log(payload);
  console.log("----- PLAYWRIGHT RESULT -----");
  console.log("UI Company:", result.uiCompanyName);
  console.log("Input Company:", result.inputCompanyName);
  console.log("Match:", result.match);
  console.log("-----------------------------");
}

/**
 * ✅ NEW CHANGE — If `cfg.companyName` is set, read Managed Care Plans table and compare (case-insensitive includes).
 */
export async function reportManagedCarePlanCompanyMatch(
  formPage: Page,
  cfg: MedicateCfgForCompanyMatch,
): Promise<void> {
  const rawInput = cfg.companyName?.trim();
  if (!rawInput) {
    return;
  }

  try {
    await ensureManagedCarePlansSectionExpanded(formPage);
    const uiCompanyName = await readFirstPlanNameCell(formPage);

    // ✅ NEW CHANGE: Normalize values
    const inputCompany = rawInput.toLowerCase().trim();
    const uiCompany = uiCompanyName.toLowerCase().trim();
    const hasUi = uiCompany.length > 0;

    // ✅ NEW CHANGE: Compare (partial match, case-insensitive)
    const match = hasUi && uiCompany.includes(inputCompany);

    // ✅ NEW CHANGE: Prepare result
    const result: EligibilityCompanyMatchResult = {
      success: hasUi,
      match,
      inputCompanyName: rawInput,
      uiCompanyName: uiCompanyName || "",
      message: !hasUi
        ? "❌ Plan Name cell not found or empty"
        : match
          ? "✅ Company name matched"
          : "❌ Company name not matched",
    };

    emitStdoutMarkerAndLogs(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: EligibilityCompanyMatchResult = {
      success: false,
      match: false,
      inputCompanyName: rawInput,
      uiCompanyName: "",
      message: `❌ Managed care plan read failed: ${msg}`,
    };
    emitStdoutMarkerAndLogs(result);
  }
}
