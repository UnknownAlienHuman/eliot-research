import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSemanticVisualValues } from "../catalog/design-literals";

type Values = Record<string, string>;
const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8").replace(/\r\n/gu, "\n");
const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")) as {
  protocol: string;
  source_normalization: string;
  source_sha256: string;
  source_bytes: number;
  consumed_roles: Array<{ pair: string; light: Values; dark: Values }>;
  foundation_tokens: string[];
  forced_colors: { roles: Values };
};

function block(selector: string): Values {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const start = declarations.indexOf(selector + " {");
  if (start < 0) throw new Error(`Missing token selector: ${selector}`);
  const body = declarations.slice(start, declarations.indexOf("}", start));
  const entries: Array<[string, string]> = [];
  for (const match of body.matchAll(/(--[a-z\d-]+)\s*:\s*([^;]+);/gu)) {
    const name = match[1];
    const value = match[2];
    if (name && value) entries.push([name, value.trim()]);
  }
  return Object.fromEntries(entries);
}
function colors(values: Values): Values {
  return Object.fromEntries(Object.entries(values).filter(([name]) => name.startsWith("--md-sys-color-") && !name.endsWith("shadow") && !name.endsWith("scrim")));
}
function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/iu.test(hex)) throw new Error(`Invalid committed color: ${hex}`);
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(values: Values): number {
  const pair = Object.values(values);
  if (pair.length !== 2 || !pair[0] || !pair[1]) throw new Error("A contrast pair must have exactly two roles");
  const a = luminance(pair[0]);
  const b = luminance(pair[1]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("U1.2 committed Material foundation", () => {
  it("binds the catalog to exact canonical CSS bytes and all consumed foundation names", () => {
    expect(catalog.protocol).toBe("eliotr.ui-token-catalog.v1");
    expect(catalog.source_normalization).toBe("utf8-lf");
    expect(catalog.source_sha256).toBe(createHash("sha256").update(css, "utf8").digest("hex"));
    expect(catalog.source_bytes).toBe(new TextEncoder().encode(css).byteLength);
    expect(catalog.foundation_tokens.filter((name) => !css.includes(name + ":"))).toEqual([]);
  });

  it("keeps root, explicit light, explicit dark and actual media dark in parity", () => {
    const light = block(":root");
    const explicitLight = block('[data-theme="light"]');
    const dark = block('[data-theme="dark"]');
    const mediaDark = block(':root:not([data-theme="light"])');
    expect(colors(explicitLight)).toEqual(colors(light));
    expect(colors(mediaDark)).toEqual(colors(dark));
    for (const role of catalog.consumed_roles) {
      for (const [name, value] of Object.entries(role.light)) expect(light[`--md-sys-color-${name}`], role.pair).toBe(value);
      for (const [name, value] of Object.entries(role.dark)) expect(dark[`--md-sys-color-${name}`], role.pair).toBe(value);
    }
  });

  it("meets WCAG text 4.5:1 and essential control boundary 3:1 in both schemes", () => {
    for (const role of catalog.consumed_roles) {
      const minimum = role.pair === "outline/surface" ? 3 : 4.5;
      expect(contrast(role.light), `${role.pair} light`).toBeGreaterThanOrEqual(minimum);
      expect(contrast(role.dark), `${role.pair} dark`).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("uses OS forced colors, zero reduced motion and a local Cyrillic-capable fallback stack", () => {
    const forced = block(':root, [data-theme="light"], [data-theme="dark"]');
    for (const [name, value] of Object.entries(catalog.forced_colors.roles)) {
      expect(value).toMatch(/^(Canvas|CanvasText|LinkText|Highlight|HighlightText|GrayText)$/u);
      expect(forced[`--md-sys-color-${name}`]).toBe(value);
    }
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"), css.indexOf("@media (forced-colors: active)"));
    expect(reduced).toContain("--eliot-motion-effects: 0ms;");
    expect(reduced).toContain("--eliot-motion-spatial: 0ms;");
    expect(block(":root")["--eliot-type-font-family"]).toContain("Segoe UI");
    expect(block(":root")["--eliot-type-font-family"]).toContain("system-ui");
    expect(css).not.toMatch(/@import|https?:\/\//u);
  });

  it("rejects seeded raw feature literals through the same gate used by the harness", () => {
    const path = "apps/eliotr-web/src/features/sources/source.css";
    expect(() => assertSemanticVisualValues(".source { color: #ff00ff; }", path)).toThrow("Raw visual color");
    expect(() => assertSemanticVisualValues(".source { font-size: 17px; }", path)).toThrow("Raw visual dimension");
    expect(() => assertSemanticVisualValues(".source { color: var(--md-sys-color-on-surface); }", path)).not.toThrow();
  });
});
