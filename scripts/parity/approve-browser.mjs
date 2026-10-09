// Drives one approval URL through a real headless Chromium, as the
// customer-local administrator. Reads the URL from stdin. Configuration comes
// from the environment, never argv:
//   METERGRAPH_PARITY_APPROVER   approve (default), deny, ignore, or view
//                                (sign in, then capture the page, for a
//                                dashboard link rather than a consent)
//   METERGRAPH_PARITY_EXPECT     view only: text the page must show
//   METERGRAPH_PARITY_ADMIN_ENV  the bundle's private .env; only the
//                                METERGRAPH_LOCAL_ADMIN_EMAIL and _PASSWORD
//                                lines are read, and never logged
//   METERGRAPH_PARITY_PLAYWRIGHT path to an installed playwright-core module
//   METERGRAPH_PARITY_CHROME     Chromium executable for playwright-core
//   METERGRAPH_PARITY_PROFILE    persistent browser profile directory, so the
//                                second approval reuses the sign-in session
//   METERGRAPH_PARITY_LOG        JSON lines: page paths, actions, screenshots
// The log records URL paths only: query strings carry state and PKCE values.
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const env = process.env;
const mode = env.METERGRAPH_PARITY_APPROVER || "approve";
const log = (entry) => {
  if (env.METERGRAPH_PARITY_LOG) appendFileSync(env.METERGRAPH_PARITY_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};
const pathOf = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return "invalid"; } };

function adminCredentials() {
  const text = readFileSync(env.METERGRAPH_PARITY_ADMIN_ENV, "utf8");
  const value = (key) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return { email: value("METERGRAPH_LOCAL_ADMIN_EMAIL"), password: value("METERGRAPH_LOCAL_ADMIN_PASSWORD") };
}

const url = readFileSync(0, "utf8").trim();
log({ step: "opened", page: pathOf(url), mode });
if (mode === "ignore") process.exit(0);

const { chromium } = createRequire(path.join(env.METERGRAPH_PARITY_PLAYWRIGHT, "noop.js"))("playwright-core");
const context = await chromium.launchPersistentContext(env.METERGRAPH_PARITY_PROFILE, {
  executablePath: env.METERGRAPH_PARITY_CHROME, headless: true,
});
const page = context.pages()[0] ?? await context.newPage();
const shots = env.METERGRAPH_PARITY_LOG ? path.dirname(env.METERGRAPH_PARITY_LOG) : null;
let shot = 0;
const capture = async (label) => {
  if (shots === null) return null;
  const file = path.join(shots, `approval-${Date.now()}-${++shot}-${label}.png`);
  await page.screenshot({ path: file });
  return file;
};
const isCallback = (current) => { try { return new URL(current).hostname === "127.0.0.1"; } catch { return false; } };

try {
  await page.goto(url);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !isCallback(page.url())) {
    await page.waitForLoadState("networkidle").catch(() => {});
    const password = page.getByLabel(/password/i);
    if (await password.isVisible().catch(() => false)) {
      log({ step: "sign_in", page: pathOf(page.url()), screenshot: await capture("sign-in") });
      const { email, password: secret } = adminCredentials();
      await page.getByLabel(/email/i).fill(email);
      await password.fill(secret);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForTimeout(500);
      continue;
    }
    if (mode === "view") {
      const expected = env.METERGRAPH_PARITY_EXPECT ?? "";
      await page.getByText(expected).first().waitFor({ timeout: 20000 }).catch(() => {});
      const visible = expected !== "" && (await page.content()).includes(expected);
      log({ step: "view", page: pathOf(page.url()), expected_visible: visible, screenshot: await capture("view") });
      break;
    }
    const pattern = mode === "deny" ? /^(deny|cancel|reject|decline)/i : /^(approve|allow|authorize|create|continue|confirm)/i;
    const button = page.getByRole("button", { name: pattern }).first();
    if (await button.isVisible().catch(() => false)) {
      const screenshot = await capture(mode === "deny" ? "consent-deny" : "consent");
      log({ step: mode === "deny" ? "deny" : "approve", page: pathOf(page.url()), button: (await button.innerText()).trim(), screenshot });
      await button.click();
      await page.waitForURL((current) => isCallback(current.href), { timeout: 15000 }).catch(() => {});
      continue;
    }
    await page.waitForTimeout(500);
  }
  if (isCallback(page.url())) log({ step: "callback_delivered" });
  else {
    const buttons = await page.getByRole("button").allInnerTexts().catch(() => []);
    log({ step: "stuck", page: pathOf(page.url()), buttons, screenshot: await capture("stuck") });
  }
} catch (error) {
  log({ step: "error", message: String(error?.message ?? error).split("\n")[0].slice(0, 200) });
} finally {
  await context.close();
}
