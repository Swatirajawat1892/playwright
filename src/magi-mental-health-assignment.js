/**
 * Ohio Medicaid **Benefit/Assignment** helpers.
 *
 * 1) **`MAGI: Mental Health Under Benefit/Assignment Plan`** (strict row)
 *    — used by Temporal parse / workflow (company no-match, InsurancePolicy, sticky note).
 *    UI variants: spaces around `/`, optional trailing "Plan".
 *
 * 2) **`MAGI:Ohio Mental Health`** (and `MAGI: Ohio Mental Health`)
 *    — **Playwright research only:** if this row is **absent**, the script shifts From/To DOS
 *    back one month and clicks Search again. Rows like `MAGI:Inpatient Hospital Services Plan`
 *    do **not** count as Ohio Mental Health.
 */

/** @type {RegExp} */
export const MAGI_MENTAL_HEALTH_ASSIGNMENT_PLAN_RE =
  /MAGI.*Mental\s*Health.*Under\s*Benefit\s*\/?\s*Assignment/i;

/**
 * @param {string | undefined | null} planText
 * @returns {boolean}
 */
export function isMagiMentalHealthUnderBenefitAssignmentPlan(planText) {
  return typeof planText === "string" && MAGI_MENTAL_HEALTH_ASSIGNMENT_PLAN_RE.test(planText);
}

/**
 * @param {Array<{ benefitAssignmentPlan?: string }> | undefined} plans
 * @returns {boolean}
 */
export function benefitPlansHaveMagiMentalHealthAssignmentPlan(plans) {
  if (!Array.isArray(plans)) return false;
  return plans.some((p) => isMagiMentalHealthUnderBenefitAssignmentPlan(p?.benefitAssignmentPlan));
}

/**
 * True when Benefit/Assignment data warrants **research** (prior-month DOS re-search): no
 * `MAGI: Mental Health Under Benefit/Assignment …` row present.
 *
 * @param {Array<{ benefitAssignmentPlan?: string }> | undefined} plans
 * @returns {boolean}
 */
export function benefitAssignmentPlansNeedMagiMentalHealthResearch(plans) {
  return !benefitPlansHaveMagiMentalHealthAssignmentPlan(plans);
}

/** @type {RegExp} */
export const MAGI_OHIO_MENTAL_HEALTH_RE = /MAGI\s*:\s*Ohio\s+Mental\s+Health/i;

/**
 * @param {string | undefined | null} planText
 * @returns {boolean}
 */
export function isMagiOhioMentalHealthPlan(planText) {
  return typeof planText === "string" && MAGI_OHIO_MENTAL_HEALTH_RE.test(planText);
}

/**
 * @param {Array<{ benefitAssignmentPlan?: string }> | undefined} plans
 * @returns {boolean}
 */
export function benefitPlansHaveMagiOhioMentalHealth(plans) {
  if (!Array.isArray(plans)) return false;
  return plans.some((p) => isMagiOhioMentalHealthPlan(p?.benefitAssignmentPlan));
}

/**
 * True when Playwright should run **research** (prior-month DOS re-search): no
 * `MAGI:Ohio Mental Health` / `MAGI: Ohio Mental Health` row in Benefit/Assignment.
 *
 * @param {Array<{ benefitAssignmentPlan?: string }> | undefined} plans
 * @returns {boolean}
 */
export function benefitAssignmentPlansNeedMagiOhioMentalHealthResearch(plans) {
  return !benefitPlansHaveMagiOhioMentalHealth(plans);
}
