/**
 * Generates a billing note via OpenAI and posts it to PatientStickyNote/Add.
 *
 * Env:
 *   OPENAI_API_KEY                — **required** for AI-generated sticky text (set on the Temporal worker process)
 *   OPENAI_MODEL                  — optional (default: gpt-4o-mini)
 *   OPENAI_STICKY_NOTE_TEMPLATE_FALLBACK — set to `1` to post a deterministic template when `OPENAI_API_KEY` is missing (default: off)
 *   ATC_INSURANCE_POLICY_TOKEN    — Bearer token (fallback if options.jwt omitted)
 *   ATC_INSURANCE_POLICY_COOKIE   — optional Cookie header
 *   ATC_STICKY_NOTE_URL           — override endpoint (default: https://atc-api.atcemr.com/api/PatientStickyNote/Add)
 *   ATC_STICKY_NOTE_PATIENT_ID    — patient ID to use (default: 8028)
 *   ATC_STICKY_NOTE_PRIORITY_ID   — priority ID to use (default: 102)
 */

import OpenAI from "openai";

/**
 * Shared strings for prompts and template fallback.
 *
 * @param {{
 *   recipientInformation?: object | null,
 *   benefitAssignmentPlans?: Array<{ benefitAssignmentPlan: string, effectiveDate: string, endDate: string }>,
 *   eligibilityCompanyMatch?: object | null,
 *   magiMentalHealthCheck?: object | null,
 * }} eligibilityData
 */
function eligibilityNoteContext(eligibilityData) {
  const ri = eligibilityData?.recipientInformation ?? {};
  const plans = Array.isArray(eligibilityData?.benefitAssignmentPlans)
    ? eligibilityData.benefitAssignmentPlans
    : [];
  const match = eligibilityData?.eligibilityCompanyMatch ?? null;
  const magi = eligibilityData?.magiMentalHealthCheck ?? null;

  const patientName = [ri.firstNameMi, ri.lastName].filter(Boolean).join(" ") || "Unknown Patient";
  const dob = ri.dateOfBirth || "Unknown DOB";
  const medicaidId = ri.medicaidBillingNumber || "Unknown";

  const planSummary =
    plans.length > 0
      ? plans
          .map(
            (p) =>
              `• ${p.benefitAssignmentPlan} (effective: ${p.effectiveDate}, end: ${p.endDate})`,
          )
          .join("\n")
      : "• No benefit/assignment plans found";

  const matchSummary = match
    ? `Requested plan/company: "${match.inputCompanyName ?? ""}". Match result: ${match.match ? "✅ Matched" : "❌ Did not match"}. ${match.message ?? ""}`
    : "No company match information available.";

  const magiSummary = magi
    ? magi.found === true
      ? `Patient HAS a MAGI Mental Health Under Benefit/Assignment Plan: ${magi.plan?.benefitAssignmentPlan ?? ""}` +
        ` (effective: ${magi.plan?.effectiveDate ?? "?"}, end: ${magi.plan?.endDate ?? "?"})`
      : "Patient does NOT have a MAGI: Mental Health Under Benefit/Assignment Plan."
    : "MAGI Mental Health check not performed.";

  return { patientName, dob, medicaidId, planSummary, matchSummary, magiSummary };
}

/**
 * @param {{
 *   recipientInformation?: object | null,
 *   benefitAssignmentPlans?: Array<{ benefitAssignmentPlan: string, effectiveDate: string, endDate: string }>,
 *   eligibilityCompanyMatch?: object | null,
 *   magiMentalHealthCheck?: object | null,
 * }} eligibilityData
 * @returns {string}
 */
function buildNotePrompt(eligibilityData) {
  const c = eligibilityNoteContext(eligibilityData);
  return `You are a professional medical billing specialist. Write a concise billing note (2–4 sentences) for a patient's Medicaid eligibility issue based on the details below.

The note should:
- State the current Medicaid plan status and relevant effective/end dates
- If a managed-care / company comparison was performed, state whether the requested name matched the UI plan and what that implies for billing
- Note whether a MAGI Mental Health Under Benefit/Assignment plan was found or not
- Suggest a follow-up action (e.g. contact patient, verify with JFS, check for retro coverage)
- Be written in plain, professional clinical billing language (no markdown, no bullet points, no headers)

Patient: ${c.patientName}
DOB: ${c.dob}
Medicaid ID: ${c.medicaidId}

Benefit / Assignment Plans:
${c.planSummary}

Company Match:
${c.matchSummary}

MAGI Mental Health Status:
${c.magiSummary}

Write only the note text. Do not include any introduction or explanation.`;
}

/**
 * Deterministic note when OpenAI is not configured (same facts as the AI prompt).
 *
 * @param {{
 *   recipientInformation?: object | null,
 *   benefitAssignmentPlans?: Array<{ benefitAssignmentPlan: string, effectiveDate: string, endDate: string }>,
 *   eligibilityCompanyMatch?: object | null,
 *   magiMentalHealthCheck?: object | null,
 * }} eligibilityData
 * @returns {string}
 */
function buildFallbackStickyNote(eligibilityData) {
  const c = eligibilityNoteContext(eligibilityData);
  const plansOneLine = c.planSummary.replace(/\s*\n\s*/g, " ").trim();
  return (
    `Automated OHID eligibility note (template; set OPENAI_API_KEY for AI-generated wording). ` +
    `Patient ${c.patientName}, DOB ${c.dob}, Medicaid ID ${c.medicaidId}. ` +
    `Benefit/Assignment: ${plansOneLine} ` +
    `${c.matchSummary} ` +
    `${c.magiSummary} ` +
    `Follow up per standard billing workflow (verify coverage, JFS, or retro as appropriate).`
  );
}

/**
 * Calls OpenAI to generate a billing note from eligibility data.
 * Without `OPENAI_API_KEY`, generation fails unless `OPENAI_STICKY_NOTE_TEMPLATE_FALLBACK=1`.
 *
 * @param {object} eligibilityData
 * @returns {Promise<
 *   | { ok: true; note: string; source?: "openai" | "template" }
 *   | { ok: false; error: string }
 * >}
 */
export async function generateStickyNoteWithOpenAI(eligibilityData) {
  const apiKey = (process.env.OPENAI_API_KEY || "").trim();
  const allowTemplate = (process.env.OPENAI_STICKY_NOTE_TEMPLATE_FALLBACK || "").trim() === "1";

  if (!apiKey) {
    if (allowTemplate) {
      console.warn(
        "[OHID][StickyNote] OPENAI_API_KEY not set — OPENAI_STICKY_NOTE_TEMPLATE_FALLBACK=1; using deterministic template.",
      );
      return { ok: true, note: buildFallbackStickyNote(eligibilityData), source: "template" };
    }
    return {
      ok: false,
      error:
        "OPENAI_API_KEY is not set. Add it to the environment of the process that runs Temporal activities (e.g. worker .env), or set OPENAI_STICKY_NOTE_TEMPLATE_FALLBACK=1 to post a non-AI template note.",
    };
  }

  const model = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
  const client = new OpenAI({ apiKey });

  const prompt = buildNotePrompt(eligibilityData);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.4,
    });

    const note = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (!note) return { ok: false, error: "OpenAI returned an empty response." };

    console.log("[OHID][StickyNote] OpenAI generated note:", note);
    return { ok: true, note, source: "openai" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[OHID][StickyNote] OpenAI error:", error);
    return { ok: false, error };
  }
}

/**
 * Posts a sticky note to atc-api.atcemr.com/api/PatientStickyNote/Add.
 *
 * @param {string} noteText
 * @param {{ jwt?: string } | undefined} [options] — Bearer from BillingAuth; falls back to ATC_INSURANCE_POLICY_TOKEN
 * @returns {Promise<{ ok: boolean, status?: number, data?: unknown, error?: string, skipped?: boolean, reason?: string }>}
 */
export async function postPatientStickyNote(noteText, options = {}) {
  const tokenFromOpts = typeof options?.jwt === "string" ? options.jwt.trim() : "";
  const token = tokenFromOpts || (process.env.ATC_INSURANCE_POLICY_TOKEN || "").trim();
  if (!token) {
    return {
      skipped: true,
      reason: "ATC_INSURANCE_POLICY_TOKEN is not set. Cannot post PatientStickyNote.",
    };
  }

  const url = (
    process.env.ATC_STICKY_NOTE_URL ||
    "https://atc-api.atcemr.com/api/PatientStickyNote/Add"
  ).trim();
  const cookie = (process.env.ATC_INSURANCE_POLICY_COOKIE || "").trim();

  const patientIdRaw = (process.env.ATC_STICKY_NOTE_PATIENT_ID || "8028").trim();
  const patientId = /^\d+$/.test(patientIdRaw) ? Number(patientIdRaw) : 8028;

  const priorityIdRaw = (process.env.ATC_STICKY_NOTE_PRIORITY_ID || "102").trim();
  const priorityId = /^\d+$/.test(priorityIdRaw) ? Number(priorityIdRaw) : 102;

  const body = {
    billingNote: true,
    collectionNote: false,
    notes: noteText,
    notifyCaseManager: false,
    notifyCounselor: false,
    notifyFrontDesk: false,
    notifyPrescriber: false,
    patientId,
    priorityId,
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => "");
    let data;
    try { data = JSON.parse(text); } catch { data = text || null; }

    if (!res.ok) {
      console.error(`[OHID][StickyNote] HTTP ${res.status}:`, text);
      return { ok: false, status: res.status, error: `HTTP ${res.status}`, data };
    }

    console.log(`[OHID][StickyNote] Posted successfully (HTTP ${res.status}).`);
    return { ok: true, status: res.status, data };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[OHID][StickyNote] Request failed:", error);
    return { ok: false, error };
  }
}
