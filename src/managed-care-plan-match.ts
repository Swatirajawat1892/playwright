/**
 * Search Eligibility results (SearchEligibility.aspx): scrape BENEFIT/ASSIGNMENT PLAN(S) and
 * MANAGED CARE PLANS tables, optional companyName match, and emit a parseable stdout line for Temporal.
 */
import type { Page, Locator } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { benefitPlansHaveMagiMentalHealthAssignmentPlan } from "./magi-mental-health-assignment.js";

export const OHID_ELIGIBILITY_RESULT_PREFIX = "__OHID_ELIGIBILITY_RESULT__";
export const OHID_ELIGIBILITY_RESULT_SUFFIX = "__END__";

export type EligibilityCompanyMatchResult = {
  success: boolean;
  match: boolean;
  inputCompanyName: string;
  uiCompanyName: string;
  message: string;
};

export type MedicateCfgForCompanyMatch = {
  companyName?: string;
};

export type BenefitAssignmentPlanRow = {
  benefitAssignmentPlan: string;
  effectiveDate: string;
  endDate: string;
};

export type ManagedCarePlanRow = {
  planName: string;
  payerId: string;
  planDescription: string;
  effectiveDate: string;
  endDate: string;
  managedCareBenefits: string;
};

export type RecipientInformation = {
  medicaidBillingNumber: string | null;
  lastName: string | null;
  firstNameMi: string | null;
  dateOfBirth: string | null;
  dateOfDeath: string | null;
  ssn: string | null;
  gender: string | null;
  countyOfResidence: string | null;
  countyOfEligibility: string | null;
  countyOfficeInformationUrl: string | null;
};

/**
 * Snapshot from the **first** eligibility scrape when DOS −1 month research runs
 * (second scrape overwrites tables; this preserves the finding for Temporal / API consumers).
 */
export type OhidMagiFirstSearchSummary = {
  researchRan: true;
  /** True only if the strict MAGI Mental Health Under Benefit/Assignment row was present on first scrape. */
  hadMagiMentalHealthUnderBenefitAssignment: boolean;
  benefitAssignmentPlansChecked: number;
  /** User-facing line aligned with `ohidParseEligibility` / workflow messaging. */
  message?: string;
};

/** Emitted on stdout between prefix/suffix; parsed by `src/temporal/activities.js`. */
export type OhidEligibilityStdoutPayload = {
  recipientInformation?: RecipientInformation;
  benefitAssignmentPlans: BenefitAssignmentPlanRow[];
  managedCarePlans: ManagedCarePlanRow[];
  /** Present when `companyName` was provided in medicate search. */
  companyMatch: EligibilityCompanyMatchResult | null;
  /** Non-fatal scrape issues (empty sections still return `[]`). */
  extractionWarnings?: string[];
  /** Set on the **final** payload when prior-month DOS research ran (see `buildMagiFirstSearchSummaryForResearch`). */
  magiFirstSearch?: OhidMagiFirstSearchSummary;
};

/**
 * Build a summary of Benefit/Assignment + managed-care company state from the **first** scrape,
 * before Playwright shifts DOS −1 month and searches again.
 */
export function buildMagiFirstSearchSummaryForResearch(
  first: OhidEligibilityStdoutPayload,
): OhidMagiFirstSearchSummary {
  const plans = first.benefitAssignmentPlans;
  const n = plans.length;
  const had = benefitPlansHaveMagiMentalHealthAssignmentPlan(plans);
  const cm = first.companyMatch;
  const companyNoMatch =
    cm != null &&
    cm.match === false &&
    String(cm.inputCompanyName ?? "").trim() !== "";

  let message: string | undefined;
  if (!had) {
    if (companyNoMatch) {
      message =
        `Company name did not match — patient does NOT have MAGI: Mental Health Under Benefit/Assignment Plan.` +
        ` (first search; benefit plans checked: ${n})`;
    } else {
      message =
        `Patient does NOT have MAGI: Mental Health Under Benefit/Assignment Plan on the first eligibility search (Benefit/Assignment).` +
        ` (benefit plans checked: ${n})`;
    }
  }

  return {
    researchRan: true,
    hadMagiMentalHealthUnderBenefitAssignment: had,
    benefitAssignmentPlansChecked: n,
    ...(message ? { message } : {}),
  };
}

function normalizeMaybeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

async function readValueByLabel(scope: Page | Locator, labelRe: RegExp): Promise<string | null> {
  try {
    const byLabel = scope.getByLabel(labelRe).first();

    if ((await byLabel.count().catch(() => 0)) > 0) {
      const value = await byLabel
        .evaluate((el: Element) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            return el.value ?? "";
          }
          if (el instanceof HTMLSelectElement) {
            const selected = el.selectedOptions?.[0];
            return selected?.text ?? el.value ?? "";
          }
          return "";
        })
        .catch(() => "");

      return normalizeMaybeText(value || "") || null;
    }
  } catch {
    // fall through
  }

  const container = scope
    .locator("div.form-horizontal")
    .filter({
      has: scope.locator("label, span").filter({ hasText: labelRe }).first(),
    })
    .first();

  if (!(await container.count().catch(() => 0))) return null;

  const control = container.locator("input, select, textarea").first();
  if ((await control.count().catch(() => 0)) === 0) return null;

  const value = await control
    .evaluate((el: Element) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el.value ?? "";
      }
      if (el instanceof HTMLSelectElement) {
        const selected = el.selectedOptions?.[0];
        return selected?.text ?? el.value ?? "";
      }
      return "";
    })
    .catch(() => "");

  return normalizeMaybeText(value || "") || null;
}

async function extractRecipientInformation(formPage: Page): Promise<{
  info: RecipientInformation;
  warning?: string;
}> {
  const section = formPage.locator(".resultContainer2.active");
  await section.waitFor({ state: "visible" });

  await formPage
    .waitForFunction(() => {
      const mbn = document.querySelector("#txtMBNDisp") as HTMLInputElement | null;
      const dob = document.querySelector("#txtDOBDisp") as HTMLInputElement | null;
      return !!mbn?.value?.trim() || !!dob?.value?.trim();
    }, { timeout: 5000 })
    .catch(() => {});

  const info: RecipientInformation = {
    medicaidBillingNumber: await readValueByLabel(section, /^Medicaid\s*Billing\s*Number:?$/i),
    lastName: await readValueByLabel(section, /^Last\s*Name:?$/i),
    firstNameMi: await readValueByLabel(section, /^First\s*Name,\s*MI:?$/i),
    dateOfBirth: await readValueByLabel(section, /^Date\s*of\s*Birth:?$/i),
    dateOfDeath: await readValueByLabel(section, /^Date\s*Of\s*Death:?$/i),
    ssn: await readValueByLabel(section, /^SSN:?$/i),
    gender: await readValueByLabel(section, /^Gender:?$/i),
    countyOfResidence: await readValueByLabel(section, /^County\s*of\s*Residence:?$/i),
    countyOfEligibility: await readValueByLabel(section, /^County\s*of\s*Eligibility:?$/i),
    countyOfficeInformationUrl: null,
  };

  const link = section
    .locator('a[href*="local-agencies-directory"], a#txtCOIDisp')
    .first();

  if (await link.isVisible().catch(() => false)) {
    const href = (await link.getAttribute("href").catch(() => null)) ?? null;
    info.countyOfficeInformationUrl = href ? normalizeMaybeText(href) : null;
  }

  const hasAny =
    Object.values(info).filter((v) => typeof v === "string" && v.trim() !== "").length > 0;

  if (!hasAny) {
    return { info, warning: "RECIPIENT INFORMATION section not detected (no fields scraped)" };
  }

  return { info };
}

async function ensureBenefitAssignmentSectionExpanded(formPage: Page): Promise<void> {
  const marker = formPage
    .locator("table")
    .filter({
      has: formPage.locator("th, td").filter({ hasText: /Benefit\s*\/\s*Assignment\s*Plan/i }),
    })
    .first();
  if (await marker.isVisible().catch(() => false)) {
    return;
  }

  const toggles = [
    formPage.getByRole("link", { name: /BENEFIT\s*\/\s*ASSIGNMENT\s*PLAN/i }).first(),
    formPage.getByRole("button", { name: /BENEFIT\s*\/\s*ASSIGNMENT\s*PLAN/i }).first(),
    formPage
      .locator("a, span, div, h2, h3, h4, td")
      .filter({ hasText: /^[\s+]*BENEFIT\s*\/\s*ASSIGNMENT\s*PLAN/i })
      .first(),
  ];
  for (const t of toggles) {
    try {
      if ((await t.count()) === 0) continue;
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.scrollIntoViewIfNeeded().catch(() => undefined);
      await t.click({ timeout: 10_000, force: true });
      await new Promise<void>((r) => setTimeout(r, 600));
      if (await marker.isVisible().catch(() => false)) {
        console.log("[OHID] Expanded BENEFIT/ASSIGNMENT PLAN(S) panel.");
        return;
      }
    } catch {
      /* try next */
    }
  }
}

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
        console.log("[OHID] Expanded MANAGED CARE PLANS panel.");
        return;
      }
    } catch {
      /* try next */
    }
  }
}

function isHeaderLikeBenefitRow(a: string, b: string, c: string): boolean {
  return (
    /Benefit\s*\/\s*Assignment\s*Plan/i.test(a) ||
    /^Effective\s*Date$/i.test(b) ||
    /^End\s*Date$/i.test(c)
  );
}

async function extractBenefitAssignmentPlans(formPage: Page): Promise<{
  rows: BenefitAssignmentPlanRow[];
  warning?: string;
}> {
  await ensureBenefitAssignmentSectionExpanded(formPage);
  const table = formPage
    .locator("table")
    .filter({
      has: formPage.locator("th, td").filter({ hasText: /Benefit\s*\/\s*Assignment\s*Plan/i }),
    })
    .first();

  await table.waitFor({ state: "visible", timeout: 25_000 }).catch(() => undefined);

  if (!(await table.isVisible().catch(() => false))) {
    return { rows: [], warning: "BENEFIT/ASSIGNMENT PLAN(S) table not visible" };
  }

  await table.scrollIntoViewIfNeeded().catch(() => undefined);
  const rows: BenefitAssignmentPlanRow[] = [];
  const tr = table.locator("tr");
  const n = await tr.count();
  for (let i = 0; i < n; i++) {
    const row = tr.nth(i);
    if ((await row.locator("th").count()) > 0) continue;
    const tds = row.locator("td");
    const tdCount = await tds.count();
    if (tdCount < 3) continue;
    const benefitAssignmentPlan = (await tds.nth(0).innerText().catch(() => "")).trim();
    const effectiveDate = (await tds.nth(1).innerText().catch(() => "")).trim();
    const endDate = (await tds.nth(2).innerText().catch(() => "")).trim();
    if (isHeaderLikeBenefitRow(benefitAssignmentPlan, effectiveDate, endDate)) continue;
    if (!benefitAssignmentPlan && !effectiveDate && !endDate) continue;
    rows.push({ benefitAssignmentPlan, effectiveDate, endDate });
  }
  return { rows };
}

function isHeaderLikeManagedRow(cells: string[]): boolean {
  if (cells.length < 6) return true;
  return /^Plan\s*Name$/i.test(cells[0] ?? "") || /^Payer\s*ID$/i.test(cells[1] ?? "");
}

async function extractManagedCarePlansAll(formPage: Page): Promise<{
  rows: ManagedCarePlanRow[];
  warning?: string;
}> {
  await ensureManagedCarePlansSectionExpanded(formPage);
  const table = formPage
    .locator("table")
    .filter({
      has: formPage.locator("th, td").filter({ hasText: /Plan\s*Name/i }),
    })
    .first();

  await table.waitFor({ state: "visible", timeout: 25_000 }).catch(() => undefined);

  if (!(await table.isVisible().catch(() => false))) {
    return { rows: [], warning: "MANAGED CARE PLANS table not visible" };
  }

  await table.scrollIntoViewIfNeeded().catch(() => undefined);
  const rows: ManagedCarePlanRow[] = [];
  const tr = table.locator("tr");
  const n = await tr.count();
  for (let i = 0; i < n; i++) {
    const row = tr.nth(i);
    if ((await row.locator("th").count()) > 0) continue;
    const tds = row.locator("td");
    const tdCount = await tds.count();
    if (tdCount < 6) continue;
    const cells: string[] = [];
    for (let j = 0; j < tdCount; j++) {
      cells.push((await tds.nth(j).innerText().catch(() => "")).trim());
    }
    if (isHeaderLikeManagedRow(cells)) continue;
    const [planName, payerId, planDescription, effectiveDate, endDate, managedCareBenefits] = cells;
    if (!planName && !payerId && !cells.slice(2).some(Boolean)) continue;
    rows.push({
      planName: planName ?? "",
      payerId: payerId ?? "",
      planDescription: planDescription ?? "",
      effectiveDate: effectiveDate ?? "",
      endDate: endDate ?? "",
      managedCareBenefits: managedCareBenefits ?? "",
    });
  }
  return { rows };
}

function computeCompanyMatch(
  cfg: MedicateCfgForCompanyMatch,
  managedCarePlans: ManagedCarePlanRow[],
): EligibilityCompanyMatchResult | null {
  const rawInput = cfg.companyName?.trim();
  if (!rawInput) return null;

  const uiCompanyName = (managedCarePlans[0]?.planName ?? "").trim();
  const inputCompany = rawInput.toLowerCase();
  const uiCompany = uiCompanyName.toLowerCase();
  const hasUi = uiCompany.length > 0;
  const match = hasUi && uiCompany.includes(inputCompany);

  return {
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
}

function emitStdoutMarkerAndLogs(payload: OhidEligibilityStdoutPayload): void {
  const line = `${OHID_ELIGIBILITY_RESULT_PREFIX}${JSON.stringify(payload)}${OHID_ELIGIBILITY_RESULT_SUFFIX}`;
  console.log(line);
  console.log("----- PLAYWRIGHT RESULT (Search Eligibility JSON) -----");
  console.log(JSON.stringify(payload, null, 2));
  console.log("--------------------------------------------------------");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

function eligibilityArtifactPathForRunId(runId: string): string | null {
  const rid = runId.trim();
  if (!rid) return null;
  const base =
    process.env.OHID_ELIGIBILITY_ARTIFACT_DIR?.trim() ||
    join(PROJECT_ROOT, "data", "ohid-eligibility-results");
  const dir = isAbsolute(base) ? base : join(PROJECT_ROOT, base);
  return join(dir, `${rid}.json`);
}

async function writeEligibilityArtifactIfEnabled(runId: string, payload: OhidEligibilityStdoutPayload): Promise<void> {
  const p = eligibilityArtifactPathForRunId(runId);
  if (!p) return;
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(payload, null, 2), "utf8");
    console.log(`[OHID] Wrote eligibility artifact: ${p}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("[OHID] Could not write eligibility artifact (continuing):", msg);
  }
}

/**
 * After Search on SearchEligibility.aspx: scrape both tables, optional `companyName` match, stdout marker for Temporal.
 */
export async function reportSearchEligibilityPageData(
  formPage: Page,
  cfg: MedicateCfgForCompanyMatch,
  options?: { magiFirstSearch?: OhidMagiFirstSearchSummary | null },
): Promise<OhidEligibilityStdoutPayload> {
  const warnings: string[] = [];
  const runId = (process.env.OHID_WORKFLOW_RUN_ID ?? "").trim();

  try {
    await formPage.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 200));
    await formPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 400));

    const recipient = await extractRecipientInformation(formPage);
    if (recipient.warning) warnings.push(recipient.warning);

    const benefit = await extractBenefitAssignmentPlans(formPage);
    if (benefit.warning) warnings.push(benefit.warning);

    const managed = await extractManagedCarePlansAll(formPage);
    if (managed.warning) warnings.push(managed.warning);

    const companyMatch = computeCompanyMatch(cfg, managed.rows);

    const payload: OhidEligibilityStdoutPayload = {
      recipientInformation: recipient.info,
      benefitAssignmentPlans: benefit.rows,
      managedCarePlans: managed.rows,
      companyMatch,
      ...(warnings.length ? { extractionWarnings: warnings } : {}),
      ...(options?.magiFirstSearch != null ? { magiFirstSearch: options.magiFirstSearch } : {}),
    };

    emitStdoutMarkerAndLogs(payload);
    await writeEligibilityArtifactIfEnabled(runId, payload);
    return payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(msg);
    const fallback: OhidEligibilityStdoutPayload = {
      benefitAssignmentPlans: [],
      managedCarePlans: [],
      companyMatch: cfg.companyName?.trim()
        ? {
            success: false,
            match: false,
            inputCompanyName: cfg.companyName.trim(),
            uiCompanyName: "",
            message: `❌ Search Eligibility scrape failed: ${msg}`,
          }
        : null,
      extractionWarnings: warnings,
    };
    emitStdoutMarkerAndLogs(fallback);
    await writeEligibilityArtifactIfEnabled(runId, fallback);
    return fallback;
  }
}

/** @deprecated Use `reportSearchEligibilityPageData` (scrapes tables + match). */
export async function reportManagedCarePlanCompanyMatch(
  formPage: Page,
  cfg: MedicateCfgForCompanyMatch,
): Promise<void> {
  await reportSearchEligibilityPageData(formPage, cfg);
}
