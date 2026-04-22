import { z } from "zod";

const BenefitAssignmentPlanRowSchema = z.object({
  benefitAssignmentPlan: z.string(),
  effectiveDate: z.string(),
  endDate: z.string(),
});

const ManagedCarePlanRowSchema = z.object({
  planName: z.string(),
  payerId: z.string(),
  planDescription: z.string(),
  effectiveDate: z.string(),
  endDate: z.string(),
  managedCareBenefits: z.string(),
});

const EligibilityCompanyMatchResultSchema = z.object({
  success: z.boolean(),
  match: z.boolean(),
  inputCompanyName: z.string(),
  uiCompanyName: z.string(),
  message: z.string(),
});

export const OhidEligibilityStdoutPayloadSchema = z.object({
  benefitAssignmentPlans: z.array(BenefitAssignmentPlanRowSchema),
  managedCarePlans: z.array(ManagedCarePlanRowSchema),
  companyMatch: EligibilityCompanyMatchResultSchema.nullable(),
  extractionWarnings: z.array(z.string()).optional(),
});

/**
 * @param {unknown} value
 * @returns {import("zod").SafeParseReturnType<unknown, z.infer<typeof OhidEligibilityStdoutPayloadSchema>>}
 */
export function safeParseOhidEligibilityStdoutPayload(value) {
  return OhidEligibilityStdoutPayloadSchema.safeParse(value);
}

