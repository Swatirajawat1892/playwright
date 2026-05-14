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

const RecipientInformationSchema = z.object({
  medicaidBillingNumber: z.string().nullable(),
  lastName: z.string().nullable(),
  firstNameMi: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  dateOfDeath: z.string().nullable(),
  ssn: z.string().nullable(),
  gender: z.string().nullable(),
  countyOfResidence: z.string().nullable(),
  countyOfEligibility: z.string().nullable(),
  countyOfficeInformationUrl: z.string().nullable(),
});

const MagiFirstSearchSummarySchema = z.object({
  researchRan: z.literal(true),
  hadMagiMentalHealthUnderBenefitAssignment: z.boolean(),
  benefitAssignmentPlansChecked: z.number(),
  message: z.string().optional(),
});

export const OhidEligibilityStdoutPayloadSchema = z.object({
  recipientInformation: RecipientInformationSchema.optional(),
  benefitAssignmentPlans: z.array(BenefitAssignmentPlanRowSchema),
  managedCarePlans: z.array(ManagedCarePlanRowSchema),
  companyMatch: EligibilityCompanyMatchResultSchema.nullable(),
  extractionWarnings: z.array(z.string()).optional(),
  magiFirstSearch: MagiFirstSearchSummarySchema.optional(),
});

/**
 * @param {unknown} value
 * @returns {import("zod").SafeParseReturnType<unknown, z.infer<typeof OhidEligibilityStdoutPayloadSchema>>}
 */
export function safeParseOhidEligibilityStdoutPayload(value) {
  return OhidEligibilityStdoutPayloadSchema.safeParse(value);
}

