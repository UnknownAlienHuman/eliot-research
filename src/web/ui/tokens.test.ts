import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// K0: guards the migrated Material theme at src/web/ui/tokens/theme.css.
// Accepted values informed by the donor catalog; this test reads only the
// migrated file and fails when it is missing or drifts.
const css = readFileSync(new URL('./tokens/theme.css', import.meta.url), 'utf8')
  .split('\r\n')
  .join('\n');

type Values = Record<string, string>;
type Pair = { name: string; min: number; light: Values; dark: Values };

const PAIRS: Pair[] = [
  { name: 'primary/on-primary', min: 4.5, light: { primary: '#0b57d0', 'on-primary': '#ffffff' }, dark: { primary: '#a8c7fa', 'on-primary': '#062e6f' } },
  { name: 'surface/on-surface', min: 4.5, light: { surface: '#f8fafd', 'on-surface': '#1f1f1f' }, dark: { surface: '#131314', 'on-surface': '#e3e3e3' } },
  { name: 'surface-container/on-surface-variant', min: 4.5, light: { 'surface-container': '#edf1f7', 'on-surface-variant': '#444746' }, dark: { 'surface-container': '#1e1f20', 'on-surface-variant': '#c4c7c5' } },
  { name: 'surface-container-high/on-surface', min: 4.5, light: { 'surface-container-high': '#e6ebf3', 'on-surface': '#1f1f1f' }, dark: { 'surface-container-high': '#282a2c', 'on-surface': '#e3e3e3' } },
  { name: 'outline/surface', min: 3, light: { outline: '#747775', surface: '#f8fafd' }, dark: { outline: '#8e918f', surface: '#131314' } },
  { name: 'error/on-error', min: 4.5, light: { error: '#b3261e', 'on-error': '#ffffff' }, dark: { error: '#f2b8b5', 'on-error': '#601410' } },
];

const FORCED: Values = {
  primary: 'LinkText',
  'on-primary': 'Canvas',
  surface: 'Canvas',
  'on-surface': 'CanvasText',
  outline: 'CanvasText',
  'outline-variant': 'GrayText',
  error: 'CanvasText',
  'on-error': 'Canvas',
};

function block(selector: string): Values {
  const flat = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const start = flat.indexOf(selector + ' {');
  if (start < 0) throw new Error('Missing token selector: ' + selector);
  const body = flat.slice(start, flat.indexOf('}', start));
  const entries: Array<[string, string]> = [];
  for (const match of body.matchAll(/(--[a-z\d-]+)\s*:\s*([^;]+);/gu)) {
    if (match[1] && match[2]) entries.push([match[1], match[2].trim()]);
  }
  return Object.fromEntries(entries);
}

function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/iu.test(hex)) throw new Error('Invalid committed color: ' + hex);
  const [r, g, b] = [1, 3, 5].map((o) => {
    const v = Number.parseInt(hex.slice(o, o + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(values: Values): number {
  const vals = Object.values(values);
  const [a, b] = vals;
  if (vals.length !== 2 || !a || !b) throw new Error('Pair must hold exactly two roles');
  return (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
}

describe('K0 migrated token contrast', () => {
  it('matches the six accepted pairs and meets text/control thresholds', () => {
    const light = block(':root');
    const dark = block('[data-theme="dark"]');
    expect(PAIRS.map((p) => p.name)).toHaveLength(6);
    for (const p of PAIRS) {
      for (const [k, v] of Object.entries(p.light)) expect(light['--md-sys-color-' + k], p.name + ' light').toBe(v);
      for (const [k, v] of Object.entries(p.dark)) expect(dark['--md-sys-color-' + k], p.name + ' dark').toBe(v);
      expect(contrast(p.light), p.name + ' light').toBeGreaterThanOrEqual(p.min);
      expect(contrast(p.dark), p.name + ' dark').toBeGreaterThanOrEqual(p.min);
    }
  });

  it('keeps explicit-light/light and media-dark/dark parity', () => {
    const keep = (v: Values): Values =>
      Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith('--md-sys-color-') && !k.endsWith('-shadow') && !k.endsWith('-scrim')));
    expect(keep(block('[data-theme="light"]'))).toEqual(keep(block(':root')));
    expect(keep(block(':root:not([data-theme="light"])'))).toEqual(keep(block('[data-theme="dark"]')));
  });

  it('forced-colors stay on the OS palette with no remote load', () => {
    const forced = block(':root, [data-theme="light"], [data-theme="dark"]');
    for (const [k, v] of Object.entries(FORCED)) expect(forced['--md-sys-color-' + k], k).toBe(v);
    expect(css.includes('@import') || css.includes('http://') || css.includes('https://')).toBe(false);
  });
});
