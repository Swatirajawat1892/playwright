/**
 * Merge BillingAuth JWT into OHID workflow results when the workflow worker is outdated
 * and omits `billingAuth` (or when you want a second fetch on the API process).
 */
import { fetchBillingAuthFromEnv } from "./billing-auth-client.js";
import { fetchBillingLookupDataWithToken } from "./billing-lookup-data.js";

/**
 * @param {unknown} auth
 * @returns {{ ok: true; token: string } | { ok: false; error: string; status?: number } | { skipped: true; reason: string }}
 */
export function normalizeBillingAuthResult(auth) {
  if (auth == null || typeof auth !== "object") {
    return { ok: false, error: "Invalid BillingAuth response" };
  }
  if ("skipped" in auth && auth.skipped) {
    return { skipped: true, reason: String(auth.reason ?? "skipped") };
  }
  if ("ok" in auth && auth.ok && "token" in auth && typeof auth.token === "string" && auth.token.trim()) {
    return { ok: true, token: auth.token.trim() };
  }
  if ("ok" in auth && !auth.ok) {
    return {
      ok: false,
      error: String(auth.error ?? "BillingAuth failed"),
      ...(typeof auth.status === "number" ? { status: auth.status } : {}),
    };
  }
  return { ok: false, error: "Unrecognized BillingAuth response shape" };
}

/**
 * @param {unknown} billingAuth
 * @returns {{ billingJwtToken: string | null; billingJwtStatus: string; billingJwtDetail: string }}
 */
export function flatBillingFieldsFromAuth(billingAuth) {
  if (billingAuth != null && typeof billingAuth === "object" && "ok" in billingAuth && billingAuth.ok && "token" in billingAuth) {
    const t = /** @type {{ token?: string }} */ (billingAuth).token;
    return {
      billingJwtToken: typeof t === "string" && t ? t : null,
      billingJwtStatus: "ok",
      billingJwtDetail: "",
    };
  }
  if (billingAuth != null && typeof billingAuth === "object" && "skipped" in billingAuth && billingAuth.skipped) {
    return {
      billingJwtToken: null,
      billingJwtStatus: "skipped",
      billingJwtDetail: String(/** @type {{ reason?: string }} */ (billingAuth).reason ?? ""),
    };
  }
  if (billingAuth != null && typeof billingAuth === "object" && "ok" in billingAuth && !billingAuth.ok) {
    return {
      billingJwtToken: null,
      billingJwtStatus: "error",
      billingJwtDetail: String(/** @type {{ error?: string }} */ (billingAuth).error ?? ""),
    };
  }
  return { billingJwtToken: null, billingJwtStatus: "unknown", billingJwtDetail: "" };
}

/**
 * BillingAuth + LookupData should only run when managed-care company match succeeded.
 *
 * @param {Record<string, unknown>} base
 * @returns {boolean}
 */
function companyNameMatchedForBilling(base) {
  const em = base.eligibilityCompanyMatch;
  if (em != null && typeof em === "object" && "match" in em) {
    return /** @type {{ match?: boolean }} */ (em).match === true;
  }
  const se = base.searchEligibility;
  if (
    se != null &&
    typeof se === "object" &&
    "companyMatch" in se &&
    se.companyMatch != null &&
    typeof se.companyMatch === "object" &&
    "match" in se.companyMatch
  ) {
    return /** @type {{ match?: boolean }} */ (se.companyMatch).match === true;
  }
  return false;
}

/**
 * Ensures `billingAuth` exists; if missing on the workflow payload, calls BillingAuth from this process (API / worker).
 *
 * @param {Record<string, unknown>} workflowResult
 * @returns {Promise<Record<string, unknown>>}
 */
export async function enrichOhidWorkflowResultWithBilling(workflowResult) {
  const base =
    workflowResult && typeof workflowResult === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...workflowResult })
      : /** @type {Record<string, unknown>} */ ({});

  if (!companyNameMatchedForBilling(base)) {
    let billingAuth = base.billingAuth;
    if (billingAuth == null) {
      billingAuth = {
        skipped: true,
        reason: "Company name did not match or no company match; BillingAuth / LookupData not called.",
      };
    }
    const flat = flatBillingFieldsFromAuth(billingAuth);
    return {
      ...base,
      billingAuth,
      billingJwtToken: flat.billingJwtToken,
      lookupData: base.lookupData != null ? base.lookupData : null,
    };
  }

  let billingAuth = base.billingAuth;
  if (billingAuth == null) {
    const raw = await fetchBillingAuthFromEnv();
    billingAuth = normalizeBillingAuthResult(raw);
  }

  const flat = flatBillingFieldsFromAuth(billingAuth);

  let lookupData = base.lookupData;
  if (lookupData == null && flat.billingJwtToken) {
    try {
      lookupData = await fetchBillingLookupDataWithToken(flat.billingJwtToken);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lookupData = {
        taskCategories: { ok: false, error: msg },
        priorities: { ok: false, error: msg },
      };
    }
  }

  return {
    ...base,
    billingAuth,
    billingJwtToken: flat.billingJwtToken,
    lookupData: lookupData != null ? lookupData : null,
  };
}
