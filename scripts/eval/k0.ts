import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const origin = new URL(process.env.ELIOT_URL ?? "http://127.0.0.1:5173").origin;
const headers: Record<string, string> = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}
const output = new URL("../../eval/out/k0/", import.meta.url);
await mkdir(output, { recursive: true });
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`${origin}/api/me`, { headers, signal: AbortSignal.timeout(2_000) });
    if (response.ok) { ready = true; break; }
    if (response.status === 403) throw new Error("Access denied: configure .dev.vars locally or supply an approved owner service token.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Access denied")) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert(ready, "Eliot did not become available. Start pnpm dev before the eval.");

const latency: number[] = [];
function protectedHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store", "Protected HTTP response must not be cached.");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert(response.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), "Protected document must reject framing.");
}
for (let sample = 0; sample < 12; sample++) {
  const started = performance.now();
  const response = await fetch(`${origin}/api/me`, { headers });
  assert.equal(response.status, 200);
  protectedHeaders(response);
  const payload = await response.json() as { actor: { type: string; authentication: string } };
  assert.equal(payload.actor.type, "owner");
  assert(["local", "access", "service-token"].includes(payload.actor.authentication));
  latency.push(performance.now() - started);
}
const missing = await fetch(`${origin}/api/does-not-exist`, { headers });
assert.equal(missing.status, 404);
protectedHeaders(missing);
assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "not_found");
const foreignOrigin = await fetch(`${origin}/api/me`, {
  method: "POST", headers: { ...headers, Origin: "https://untrusted.invalid" },
});
assert.equal(foreignOrigin.status, 403, "Foreign-origin mutations must fail closed.");
protectedHeaders(foreignOrigin);
const document = await fetch(origin, { headers });
assert.equal(document.status, 200);
protectedHeaders(document);
const html = await document.text();
const script = /<script\b[^>]*\bsrc="([^"]+\.(?:js|tsx|jsx))"/.exec(html)?.[1];
assert(script, "Owner HTML must contain its application entry module.");
const entry = new URL(script, origin);
assert.equal(entry.origin, origin, "Owner credentials stay on the Eliot origin.");
const asset = await fetch(entry, { headers });
assert.equal(asset.status, 200);
protectedHeaders(asset);
assert(/javascript|ecmascript/.test(asset.headers.get("content-type") ?? ""), "Entry module must not fall back to SPA HTML.");
await asset.body?.cancel();

const browser = await chromium.launch();
const screenshots: string[] = [];
try {
  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: { width, height: 900 }, colorScheme: theme, extraHTTPHeaders: headers,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(origin);
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--eliot-color-canvas").trim());
      assert(canvas.length > 0, "Material canvas token is missing.");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
        `Horizontal overflow at ${width}px/${theme}`);
      const filename = `projects-${width}-${theme}.png`;
      await page.screenshot({ path: fileURLToPath(new URL(filename, output)), fullPage: true });
      screenshots.push(filename);
      await page.locator('nav a[href="/settings"]').filter({ visible: true }).click();
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
      const nav = await page.locator("nav").boundingBox();
      assert(nav && (width === 390 ? nav.y > 700 : nav.x < 100), "Rail/bottom navigation geometry changed.");
      const settings = await page.locator('nav a[href="/settings"]').boundingBox();
      assert(settings && settings.width >= 48 && settings.height >= 48, "Navigation touch targets must be at least 48px.");
      await page.locator('summary[aria-label="Appearance"]').click();
      await page.locator(".er-shell-preferences").getByRole("combobox", { name: "Appearance", exact: true }).selectOption(theme === "light" ? "dark" : "light");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "light" ? "dark" : "light");
      await expect(page.getByRole("region", { name: "Workspace preferences", exact: true }).getByRole("combobox", { name: "Appearance", exact: true })).toHaveValue(theme === "light" ? "dark" : "light");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "light" ? "dark" : "light");
      await page.locator('summary[aria-label="Appearance"]').click();
      await page.locator(".er-shell-preferences").getByRole("combobox", { name: "Appearance", exact: true }).selectOption("system");
      await expect(page.locator("html")).not.toHaveAttribute("data-theme");
      await page.evaluate(() => document.fonts.load('16px "Google Sans"', "Исследования"));
      assert(await page.evaluate(() => document.fonts.check('16px "Google Sans"', "Исследования")), "Cyrillic font did not load.");
      assert.deepEqual(errors, [], "Browser runtime errors");
      await context.close();
    }
  }
} finally {
  await browser.close();
}
latency.sort((a, b) => a - b);
const p50 = latency[Math.floor(latency.length * 0.5)]?.toFixed(1);
const p95 = latency[Math.ceil(latency.length * 0.95) - 1]?.toFixed(1);
const report = `K0 actual Worker eval: PASS\nOrigin: ${origin}\nAPI p50/p95: ${p50}/${p95} ms (12 local samples)\nMaterial viewports/themes: 1440/390, light/dark\nScreenshots: ${screenshots.join(", ")}\nModel/search calls: 0; model/search cost: $0\nCloudflare browser login and deployed owner token: ${headers["CF-Access-Client-Id"] ? "owner-token route exercised; browser login NOT_RUN" : "NOT_RUN (local bypass only)"}\n`;
await writeFile(new URL("result.txt", output), report);
process.stdout.write(report);
