import type { Locator, Page } from "playwright";

type OhidPnmGatewayTimeouts = {
  pnmLoadShort: number;
  pnmSsoButton: number;
  pnmNavRace: number;
  pnmClick: number;
  pnmLoad: number;
};

function isPnmAccountLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/\/Account\/Login\.aspx/i.test(u.pathname)) return false;
    return /ohpnm|omes\.maximus|maximus\.com/i.test(u.hostname);
  } catch {
    return false;
  }
}

function isPnmMaximusHost(url: string): boolean {
  try {
    return /ohpnm|omes\.maximus|maximus\.com/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** True once PNM has moved past the optional SSO landing (terms, app, process pages). */
function isLikelyPastPnmOptionalGateway(url: string): boolean {
  try {
    const u = new URL(url);
    if (!isPnmMaximusHost(url)) return true;
    if (isPnmAccountLoginUrl(url)) return false;
    return /\/Process\/|ProviderHome|Terms|ProviderDetails|SearchEligibility|Account\/Logout/i.test(u.pathname);
  } catch {
    return true;
  }
}

/**
 * Optional PNM step: some sessions land on `/Account/Login.aspx` with "Log in with OH|ID"; others skip
 * straight to terms/app. If the button is visible we click it; otherwise we return immediately.
 * Never throws — the rest of the flow (MFA, terms, medicate) always continues.
 */
export async function clickPnmLoginWithOhidIfPresent(appPage: Page, OH: OhidPnmGatewayTimeouts): Promise<void> {
  try {
    await appPage.waitForLoadState("domcontentloaded", { timeout: OH.pnmLoadShort }).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 400));

    const nameStrict = /Log\s*in\s*with\s*OH[\s|│\u007c]*ID/i;
    const nameLoose = /Log\s*in\s*with\s*OH/i;

    async function pickSsoControl(): Promise<Locator | null> {
      const candidates: Locator[] = [
        appPage.getByRole("button", { name: nameStrict }).first(),
        appPage.getByRole("link", { name: nameStrict }).first(),
        appPage.getByRole("button", { name: nameLoose }).first(),
        appPage.getByRole("link", { name: nameLoose }).first(),
        appPage.locator("a, button, input[type='submit'], input[type='button']").filter({ hasText: nameLoose }).first(),
      ];
      for (const loc of candidates) {
        if ((await loc.count()) === 0) continue;
        if (await loc.isVisible().catch(() => false)) return loc;
      }
      return null;
    }

    let target: Locator | null = null;
    const deadline = Date.now() + OH.pnmSsoButton;

    while (Date.now() < deadline && !target) {
      const url = appPage.url();
      if (!isPnmMaximusHost(url)) {
        break;
      }
      if (isLikelyPastPnmOptionalGateway(url)) {
        break;
      }
      if (isPnmAccountLoginUrl(url)) {
        target = await pickSsoControl();
        if (target) {
          break;
        }
      }
      await new Promise<void>((r) => setTimeout(r, 250));
    }

    if (target && !isPnmAccountLoginUrl(appPage.url())) {
      target = null;
    }

    if (!target) {
      console.log("[OHID] Optional PNM OH|ID gateway not used — continuing.");
      return;
    }

    console.log("[OHID] Optional PNM gateway — clicking Log in with OH|ID…");
    await target.scrollIntoViewIfNeeded().catch(() => undefined);

    try {
      await Promise.all([
        appPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: OH.pnmNavRace }).catch(() => null),
        target.click({ timeout: OH.pnmClick }),
      ]);
    } catch {
      await target.click({ timeout: OH.pnmClick, force: true }).catch(() => undefined);
    }

    await appPage.waitForLoadState("domcontentloaded", { timeout: OH.pnmLoad }).catch(() => undefined);
    await new Promise<void>((r) => setTimeout(r, 400));

    console.log("[OHID] After optional PNM SSO gateway. URL:", appPage.url());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("[OHID] Optional PNM OH|ID step ignored (continuing):", msg);
  }
}
