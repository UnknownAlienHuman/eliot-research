import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';
// K1 Read eval: exact API transport only, no fallbacks.
// H (Origin + owner credentials) goes only to ELIOT_URL. External PDF downloads send no headers.
interface Fixture {
  key: string;
  kind: string;
  title: string;
  url?: string;
  text?: string;
  paper: boolean;
  expected: string;
}
interface SourceRow {
  id: string;
  title: string;
  currentRevisionId: string;
  revisionId: string;
  readableState: string;
  converter: string | null;
  conversionTokens: number | null;
  conversionCalls: number;
  conversionMs: number | null;
  originalSize: number | null;
  readableSize: number | null;
  error: string | null;
}
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const nativeOnly = process.argv.includes('--native-only');
const duplicatesOnly = process.argv.includes('--duplicates-only');
const allowNetUrl = duplicatesOnly || !nativeOnly || process.env.ELIOT_EVAL_NET === '1';
// Native-only default is immutable public UTF-8 text so the duplicate-URL
// journey exercises Attach-existing without requiring document conversion.
// Full runs keep the HTML default to retain conversion coverage.
// ELIOT_EVAL_URL overrides both defaults; URL guard/allowlist unchanged.
const NATIVE_URL_DEFAULT = 'https://www.rfc-editor.org/rfc/rfc9110.txt';
const HTML_URL_DEFAULT = 'https://example.com/';
function resolveEvalUrl(): string {
  const override = (process.env.ELIOT_EVAL_URL || '').trim();
  if (override) return override;
  if (nativeOnly || duplicatesOnly) return NATIVE_URL_DEFAULT;
  return HTML_URL_DEFAULT;
}
const H: Record<string, string> = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) {
  H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
}
const evalDir = fileURLToPath(new URL('../../eval/', import.meta.url));
const cacheDir = fileURLToPath(new URL('../../eval/cache/', import.meta.url));
const outDir = fileURLToPath(new URL('../../eval/out/k1/', import.meta.url));
async function openSources(page: Page) {
  await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
  const sources = page.getByRole('complementary', { name: 'Project sources', exact: true });
  await expect(sources).toBeVisible();
  return sources;
}
async function openAddSources(page: Page) {
  const sources = await openSources(page);
  await sources.getByRole('button', { name: 'Add', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add sources', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
await mkdir(cacheDir, { recursive: true });
await mkdir(outDir, { recursive: true });
async function apiJson(path: string, init?: any): Promise<any> {
  const r = await fetchEval(origin + path, {
    ...init,
    headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) },
  }, origin, process.env.ELIOT_ORIGIN);
  const t = await r.text();
  let b: any = null;
  try {
    b = t ? JSON.parse(t) : null;
  } catch {
    b = { raw: t.slice(0, 500) };
  }
  return { status: r.status, body: b };
}
async function apiBytes(path: string): Promise<any> {
  const r = await fetchEval(origin + path, { headers: { ...H } }, origin, process.env.ELIOT_ORIGIN);
  assert.equal(r.headers.get('cache-control'), 'private, no-store', 'Source bytes must not be publicly cached.');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert(r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
}
function sha(b: any): string {
  return createHash('sha256').update(b).digest('hex');
}
function cont(v: number): boolean {
  return (v & 192) === 128;
}
function rng(seed: number): any {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 1831565813) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function mapLimit(items: any[], n: number, fn: (v: any, i: number) => Promise<any>): Promise<any[]> {
  const out = new Array(items.length);
  let next = 0;
  async function w(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const ws: Array<Promise<void>> = [];
  for (let k = 0; k < Math.min(n, items.length); k++) ws.push(w());
  await Promise.all(ws);
  return out;
}
// Reader-UI cleanup (eval-only): UI chrome shows status/filename/revision choice only.
// API still asserts converter/bytes/tokens below for CLI facts; these guards scope
// only to visible UI chrome, never to the canonical paper body (.er-lib__text/.er-lib__excerpt).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function uiTelemetryHits(label: string, s: string): string[] {
  const hits: string[] = [];
  if (UUID_RE.test(s)) hits.push('uuid in ' + label);
  const pats: Array<[RegExp, string]> = [
    [/source\s*id/i, 'SourceID in ' + label],
    [/[0-9][0-9,]*\s+bytes\b/i, 'bytes in ' + label],
    [/[0-9][0-9,]*\s+tokens?\b/i, 'tokens in ' + label],
    [/[0-9]+\s*ms\b/i, 'ms in ' + label],
    [/converter/i, 'converter in ' + label],
    [/conversion\s*calls/i, 'conversion calls in ' + label],
    [/\bdebug\b/i, 'debug in ' + label],
    [/bounded calls/i, 'bounded calls in ' + label],
    [/reserved/i, 'reserved in ' + label],
  ];
  for (const pair of pats) { if (pair[0].test(s)) hits.push(pair[1]); }
  return hits;
}
function assertNoUiTelemetry(label: string, s: string): void {
  const hits = uiTelemetryHits(label, s);
  assert.deepEqual(hits, [], 'UI chrome must not expose storage/telemetry (' + label + '): ' + hits.join('; ') + ' :: ' + s.slice(0, 400));
}
const me = await apiJson('/api/me');
assert.equal(me.status, 200, 'GET /api/me must be 200; start pnpm dev first.');
assert.equal(me.body.actor.type, 'owner', 'Eval must run as owner.');
if (duplicatesOnly) {
  const dqStamp = Date.now();
  const dqSettingsBefore = await apiJson('/api/settings');
  assert.equal(dqSettingsBefore.status, 200, 'GET /api/settings must be 200.');
  const dqUsageBefore = dqSettingsBefore.body.usage;
  assert(dqUsageBefore && typeof dqUsageBefore.dayStart === 'number' && typeof dqUsageBefore.dayEnd === 'number', 'GET /api/settings must return usage {dayStart,dayEnd,inputTokens,outputTokens,cachedTokens,unknownUsages}.');
  for (const k of ['inputTokens', 'outputTokens', 'cachedTokens', 'unknownUsages']) assert(Number.isSafeInteger(dqUsageBefore[k]) && dqUsageBefore[k] >= 0, 'Invalid daily usage before: ' + k);
  const dqPjA = await apiJson('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'k1-dupe-primary-' + dqStamp, description: 'K1 duplicates-only fixture.' }),
  });
  assert.equal(dqPjA.status, 201, 'First fixture project must be 201, got ' + dqPjA.status);
  const dqPrimary = dqPjA.body.project.id;
  const dqPjB = await apiJson('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'k1-dupe-attached-' + dqStamp, description: 'K1 duplicates-only attach target.' }),
  });
  assert.equal(dqPjB.status, 201, 'Second fixture project must be 201, got ' + dqPjB.status);
  const dqSecondary = dqPjB.body.project.id;
  let dqNewSources = 0;
  const dqTextTitle = 'k1 dupe text ' + dqStamp;
  const dqTextBody = '# K1 duplicate fixture' + String.fromCharCode(10) + String.fromCharCode(10) + 'Exact duplicate probe ' + dqStamp + '.' + String.fromCharCode(10) + String.fromCharCode(10) + 'Second paragraph точность.' + String.fromCharCode(10);
  const dqT1 = await apiJson('/api/projects/' + encodeURIComponent(dqPrimary) + '/sources/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: dqTextTitle, text: dqTextBody }),
  });
  assert.equal(dqT1.status, 202, 'First text import must be 202 (new source), got ' + dqT1.status);
  dqNewSources += 1;
  const dqTextId = dqT1.body.sourceId;
  let dqTextSrc = null;
  for (let dqI = 0; dqI < 40; dqI++) {
    const dqG = await apiJson('/api/sources/' + encodeURIComponent(dqTextId));
    assert.equal(dqG.status, 200, 'GET text source must be 200.');
    if (dqG.body.source && dqG.body.source.readableState === 'readable') { dqTextSrc = dqG.body.source; break; }
    if (dqG.body.source && (dqG.body.source.readableState === 'failed' || dqG.body.source.readableState === 'needs_conversion')) {
      assert.fail('Text fixture must stay native readable, got ' + dqG.body.source.readableState);
    }
    await new Promise(function (dqR) { setTimeout(dqR, 3000); });
  }
  assert(dqTextSrc && dqTextSrc.readableState === 'readable', 'Text fixture never settled readable.');
  assert.equal(dqTextSrc.conversionCalls, 0, 'Native text must cost 0 conversions, got ' + dqTextSrc.conversionCalls);
  const dqTextRev = dqTextSrc.currentRevisionId;
  const dqT2 = await apiJson('/api/projects/' + encodeURIComponent(dqPrimary) + '/sources/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: dqTextTitle, text: dqTextBody }),
  });
  assert.equal(dqT2.status, 409, 'Second identical text import must be 409 before conversion, got ' + dqT2.status);
  assert.equal(dqT2.body.duplicate.sourceId, dqTextId, 'Text duplicate must identify the original source.');
  assert.equal(dqT2.body.duplicate.revisionId, dqTextRev, 'Text duplicate must identify the original revision.');
  const dqUrl = resolveEvalUrl();
  let dqUrlId = '';
  let dqUrlRev = '';
  let dqUrlIsNew = false;
  let dqUrlConverter = null;
  let dqUrlCalls = 0;
  const dqU1 = await apiJson('/api/projects/' + encodeURIComponent(dqPrimary) + '/sources/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: dqUrl }),
  });
  if (dqU1.status === 202) {
    dqUrlIsNew = true;
    dqNewSources += 1;
    dqUrlId = dqU1.body.sourceId;
    let dqUrlSrc = null;
    for (let dqJ = 0; dqJ < 40; dqJ++) {
      const dqH = await apiJson('/api/sources/' + encodeURIComponent(dqUrlId));
      assert.equal(dqH.status, 200, 'GET URL source must be 200.');
      if (dqH.body.source && dqH.body.source.readableState === 'readable') { dqUrlSrc = dqH.body.source; break; }
      if (dqH.body.source && (dqH.body.source.readableState === 'failed' || dqH.body.source.readableState === 'needs_conversion')) {
        assert.fail('Stable URL must settle readable; got ' + dqH.body.source.readableState + ' (honest failure, no retry).');
      }
      await new Promise(function (dqR) { setTimeout(dqR, 3000); });
    }
    assert(dqUrlSrc && dqUrlSrc.readableState === 'readable', 'Stable URL never settled readable (honest failure, no retry).');
    dqUrlRev = dqUrlSrc.currentRevisionId;
    dqUrlConverter = dqUrlSrc.converter;
    dqUrlCalls = dqUrlSrc.conversionCalls;
    assert(dqUrlCalls <= 1, 'At most one URL conversion is allowed, got ' + dqUrlCalls);
  } else if (dqU1.status === 409) {
    assert(dqU1.body.duplicate && dqU1.body.duplicate.sourceId, 'Known URL must identify the existing source.');
    dqUrlId = dqU1.body.duplicate.sourceId;
    dqUrlRev = dqU1.body.duplicate.revisionId;
    const dqKnown = await apiJson('/api/sources/' + encodeURIComponent(dqUrlId));
    assert.equal(dqKnown.status, 200, 'GET reused URL source must be 200.');
    assert.equal(dqKnown.body.source.readableState, 'readable', 'Reused URL must already be readable; no repeat conversion was run.');
    assert.equal(dqKnown.body.source.currentRevisionId, dqUrlRev, 'Reused URL revision must match the duplicate identity.');
    dqUrlConverter = dqKnown.body.source.converter;
    dqUrlCalls = dqKnown.body.source.conversionCalls;
  } else {
    assert.fail('Stable URL import must be 202 or 409, got ' + dqU1.status + ' (honest failure, no retry).');
  }
  const dqU2 = await apiJson('/api/projects/' + encodeURIComponent(dqPrimary) + '/sources/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: dqUrl }),
  });
  assert.equal(dqU2.status, 409, 'Second identical URL import must be 409 before conversion, got ' + dqU2.status);
  assert.equal(dqU2.body.duplicate.sourceId, dqUrlId, 'URL duplicate must identify the same source.');
  assert.equal(dqU2.body.duplicate.revisionId, dqUrlRev, 'URL duplicate must identify the same revision.');
  assert(dqNewSources <= 2, 'At most 2 new sources are allowed, got ' + dqNewSources);
  const dqBrowser = await chromium.launch();
  try {
    const dqPhoneCtx = await dqBrowser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    const dqPage = await dqPhoneCtx.newPage();
    const dqPageErrors = [];
    const dqUndPosts = [];
    dqPage.on('pageerror', function (dqE) { dqPageErrors.push(String(dqE && dqE.message ? dqE.message : dqE)); });
    dqPage.on('request', function (dqReq) {
      if (dqReq.url().indexOf('/understanding') >= 0 && dqReq.method() !== 'GET') { dqUndPosts.push(dqReq.method() + ' ' + dqReq.url()); }
    });
    await dqPage.goto(origin + '/p/' + dqSecondary + '/sources');
    let dqDialog = await openAddSources(dqPage);
    const dqEmpty = await apiJson('/api/projects/' + encodeURIComponent(dqSecondary) + '/sources');
    assert.equal(dqEmpty.status, 200, 'GET attach-target sources must be 200.');
    assert.equal(dqEmpty.body.sources.length, 0, 'Attach target must start empty; duplicates must not attach silently.');
    await dqDialog.getByLabel('Pasted text title', { exact: true }).fill(dqTextTitle);
    await dqDialog.getByLabel('Text', { exact: true }).fill(dqTextBody);
    await dqDialog.getByRole('button', { name: 'Add text', exact: true }).click();
    const dqTextRow = dqDialog.locator('.er-lib__progress li', { hasText: dqTextTitle });
    await expect(dqTextRow.getByRole('button', { name: /^Attach from Library/ })).toBeVisible({ timeout: 30000 });
    const dqMid = await apiJson('/api/projects/' + encodeURIComponent(dqSecondary) + '/sources');
    assert.equal(dqMid.body.sources.length, 0, 'A text duplicate must not attach silently.');
    await dqTextRow.getByRole('button', { name: /^Attach from Library/ }).click();
    await dqDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dqPage.getByRole('link', { name: dqTextTitle, exact: true })).toBeVisible({ timeout: 15000 });
    const dqAfterText = await apiJson('/api/projects/' + encodeURIComponent(dqSecondary) + '/sources');
    const dqAttachedText = dqAfterText.body.sources.find(function (dqS) { return dqS.title === dqTextTitle; });
    assert(dqAttachedText, 'Attached text must be listed.');
    assert.equal(dqAttachedText.id, dqTextId, 'Attached text must reuse the original source.');
    assert.equal(dqAttachedText.revisionId, dqTextRev, 'Attached text must reuse the original revision.');
    assert.equal(dqAttachedText.conversionCalls, 0, 'Attached text must perform zero conversions.');
    dqDialog = await openAddSources(dqPage);
    await dqDialog.getByLabel('Page URL (https only)', { exact: true }).fill(dqUrl);
    await dqDialog.getByRole('button', { name: 'Add URL', exact: true }).click();
    const dqUrlRow = dqDialog.locator('.er-lib__progress li', { hasText: dqUrl });
    await expect(dqUrlRow.getByRole('button', { name: /^Attach from Library/ })).toBeVisible({ timeout: 30000 });
    const dqMidUrl = await apiJson('/api/projects/' + encodeURIComponent(dqSecondary) + '/sources');
    assert.equal(dqMidUrl.body.sources.length, 1, 'A URL duplicate must not attach silently.');
    await dqUrlRow.getByRole('button', { name: /^Attach from Library/ }).click();
    await dqDialog.getByRole('button', { name: 'Close', exact: true }).click();
    let dqAttachedUrl = null;
    for (let dqK = 0; dqK < 20; dqK++) {
      const dqL = await apiJson('/api/projects/' + encodeURIComponent(dqSecondary) + '/sources');
      if (dqL.body.sources.length === 2) {
        dqAttachedUrl = dqL.body.sources.find(function (dqS) { return dqS.id !== dqTextId; });
        break;
      }
      await new Promise(function (dqR) { setTimeout(dqR, 1000); });
    }
    assert(dqAttachedUrl, 'Attached URL must be listed.');
    assert.equal(dqAttachedUrl.id, dqUrlId, 'Attached URL must reuse the original source.');
    assert.equal(dqAttachedUrl.revisionId, dqUrlRev, 'Attached URL must reuse the original revision.');
    assert.deepEqual(dqUndPosts, [], 'No model inference or Understand POST may run.');
    assert.deepEqual(dqPageErrors, [], 'Browser runtime errors.');
    await dqPage.screenshot({ path: outDir + '/k1-duplicates-390.png', fullPage: true });
    await dqPhoneCtx.close();
    const dqDeskCtx = await dqBrowser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    const dqDesk = await dqDeskCtx.newPage();
    await dqDesk.goto(origin + '/p/' + dqSecondary + '/sources');
    await expect(dqDesk.getByRole('link', { name: dqTextTitle, exact: true })).toBeVisible({ timeout: 15000 });
    await dqDesk.screenshot({ path: outDir + '/k1-duplicates-1440.png', fullPage: true });
    await dqDeskCtx.close();
  } finally { await dqBrowser.close(); }
  const dqSettingsAfter = await apiJson('/api/settings');
  assert.equal(dqSettingsAfter.status, 200, 'GET /api/settings after must be 200.');
  const dqUsageAfter = dqSettingsAfter.body.usage;
  assert.deepEqual(dqUsageAfter, dqUsageBefore, 'No paid model usage may accrue during duplicates-only.');
  const dqReport = [
    '# K1 duplicates-only',
    'Origin: ' + origin + '; primary: ' + dqPrimary + '; attach-target: ' + dqSecondary,
    'Projects created: 2; new sources: ' + dqNewSources + ' (text 1, url ' + (dqUrlIsNew ? '1 new source' : '0 reused') + ').',
    'Text 409: second identical import returned 409 with sourceId ' + dqTextId + ' revision ' + dqTextRev + '; browser Attach existing reused the same source and revision with 0 conversions.',
    'URL 409: identical import returned 409 with sourceId ' + dqUrlId + ' revision ' + dqUrlRev + ' (converter ' + dqUrlConverter + ', calls ' + dqUrlCalls + '); browser Attach existing reused the same source and revision.',
    'Viewports captured: 390 k1-duplicates-390.png and 1440 k1-duplicates-1440.png; no route mocking; no Access headers in the browser.',
    'Daily token usage before/after unchanged: ' + JSON.stringify(dqUsageAfter) + '; settings unchanged.',
    'No PDF downloads, no retries, no model inference or Understand POSTs; stable-URL bytes-vary or unavailable would fail honestly without adjustment.',
  ].join(String.fromCharCode(10)) + String.fromCharCode(10);
  await writeFile(outDir + '/k1-duplicates-' + new Date().toISOString().slice(0, 10) + '.md', dqReport);
  process.stdout.write(dqReport);
  process.exit(0);
}
const ax = JSON.parse(await readFile(evalDir + '/arxiv-10/sources.json', 'utf8'));
const ru = JSON.parse(await readFile(evalDir + '/ru/sources.json', 'utf8'));
assert.equal(ax.sources.length, 10, 'arxiv-10 must list ten PDFs.');
let fx: Fixture[] = [];
for (const s of ax.sources) {
  fx.push({ key: 'arxiv-' + s.id, kind: 'file', title: s.title, url: s.url, paper: true, expected: 'readable' });
}
for (const s of ru.sources) {
  if (s.kind === 'text') {
    fx.push({ key: s.id, kind: 'text', title: s.title, text: s.text, paper: false, expected: String(s.expected_state || 'readable') });
  } else {
    fx.push({ key: s.id, kind: 'file', title: s.title, url: s.url, paper: false, expected: String(s.expected_state || 'readable') });
  }
}
if (nativeOnly) fx = fx.filter((fixture) => fixture.kind === 'text');
// External downloads carry no auth headers. PDFs cache by SHA-256 digest;
// eval/cache/index.json maps URL to digest and is written once after downloads.
let index: Record<string, string> = {};
try {
  index = JSON.parse(await readFile(cacheDir + '/index.json', 'utf8'));
} catch {
  index = {};
}
const dl = await mapLimit(fx, 2, async function (f: any): Promise<any> {
  if (f.kind !== 'file') return { key: f.key, bytes: null };
  const known: string = index[f.url];
  if (known) {
    try {
      const hit = await readFile(cacheDir + '/' + known + '.pdf');
      if (hit.length > 0) return { key: f.key, bytes: hit };
    } catch {
      /* stale index entry, download again */
    }
  }
  const r = await fetch(f.url);
  assert.equal(r.status, 200, 'PDF download 200 for ' + f.key);
  const b = Buffer.from(await r.arrayBuffer());
  assert(b[0] === 37 && b[1] === 80 && b[2] === 68 && b[3] === 70, 'Not a PDF: ' + f.key);
  const digest = sha(b);
  await writeFile(cacheDir + '/' + digest + '.pdf', b);
  index[f.url] = digest;
  return { key: f.key, bytes: b };
});
await writeFile(cacheDir + '/index.json', JSON.stringify(index, null, 2));
const byKey = new Map();
for (const d of dl) byKey.set(d.key, d);
const pj = await apiJson('/api/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: process.env.ELIOT_EVAL_PROJECT || 'k1-eval', description: 'K1 Read eval.' }),
});
assert.equal(pj.status, 201, 'POST /api/projects must be 201 { project }, got ' + pj.status);
const pid: string = pj.body.project.id;
assert(typeof pid === 'string' && pid.length > 0, 'Project id required.');
const upIds = new Map();
await mapLimit(fx, 2, async function (f: any): Promise<void> {
  let st = 0;
  let sid = '';
  if (f.kind === 'file') {
    const it = byKey.get(f.key);
    const fd = new FormData();
    fd.append('file', new Blob([it.bytes], { type: 'application/pdf' }), f.key + '.pdf');
    fd.append('title', f.title);
    const r = await fetchEval(origin + '/api/projects/' + encodeURIComponent(pid) + '/sources/file', {
      method: 'POST',
      headers: { ...H },
      body: fd,
    }, origin, process.env.ELIOT_ORIGIN);
    st = r.status;
    const b = await r.json().catch(function () { return null; });
    if (st === 409) {
      const dup: string = b.duplicate.sourceId;
      const at = await apiJson('/api/projects/' + encodeURIComponent(pid) + '/sources/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: dup }),
      });
      assert.equal(at.status, 200, 'Attach after 409 must be 200 for ' + f.key);
      sid = dup;
    } else {
      assert(st === 202, 'File upload must be 202, got ' + st + ' for ' + f.key);
      sid = b.sourceId;
    }
  } else {
    const r = await apiJson('/api/projects/' + encodeURIComponent(pid) + '/sources/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: f.title, text: f.text }),
    });
    st = r.status;
    if (st === 409) {
      const dup: string = r.body.duplicate.sourceId;
      const at = await apiJson('/api/projects/' + encodeURIComponent(pid) + '/sources/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: dup }),
      });
      assert.equal(at.status, 200, 'Attach after 409 must be 200 for ' + f.key);
      sid = dup;
    } else {
      assert(st === 202, 'Text upload must be 202, got ' + st + ' for ' + f.key);
      sid = r.body.sourceId;
    }
  }
  assert(typeof sid === 'string' && sid.length > 0, 'Source id required for ' + f.key);
  upIds.set(f.key, sid);
});
const OK = ['readable', 'readable_with_warnings'];
let list: SourceRow[] = [];
function rowFor(key: string): any {
  return list.find(function (s: SourceRow) { return s.id === upIds.get(key); });
}
function doneFor(f: Fixture): boolean {
  const s = rowFor(f.key);
  if (!s) return false;
  if (f.expected === 'needs_conversion') return s.readableState === 'needs_conversion';
  return !!(s.currentRevisionId && OK.indexOf(s.readableState) >= 0 && s.revisionId === s.currentRevisionId);
}
function badFor(f: Fixture): boolean {
  const s = rowFor(f.key);
  if (!s || !s.readableState || s.readableState === 'pending') return false;
  if (f.expected === 'needs_conversion') return s.readableState !== 'needs_conversion';
  return s.readableState === 'failed' || s.readableState === 'needs_conversion';
}
for (let i = 0; i < 120; i++) {
  const c = await apiJson('/api/projects/' + encodeURIComponent(pid) + '/sources');
  assert.equal(c.status, 200, 'GET sources must be 200.');
  list = c.body.sources;
  if (fx.some(badFor)) break;
  if (list.length >= fx.length && fx.every(doneFor)) break;
  await new Promise(function (r: any) { setTimeout(r, 5000); });
}
const badFx = fx.filter(badFor);
if (badFx.length > 0) {
  const fr: string[] = [];
  fr.push('# K1 Read eval FAILED');
  fr.push('Origin: ' + origin + ' Project: ' + pid);
  fr.push('');
  fr.push('| fixture | source | expected | state | converter | original | convCalls | error |');
  fr.push('|---|---|---|---|---|---|---|---|');
  for (const f of badFx) {
    const s = rowFor(f.key) || ({} as SourceRow);
    const msg = ((s as SourceRow).error || '').split(String.fromCharCode(10)).join(' ');
    fr.push('| ' + f.key + ' | ' + (s.id || 'missing') + ' | ' + f.expected + ' | ' + (s.readableState || 'missing') + ' | ' + (s.converter || '') + ' | ' + (s.originalSize == null ? '' : s.originalSize) + ' | ' + (s.conversionCalls == null ? '' : s.conversionCalls) + ' | ' + msg + ' |');
  }
  fr.push('');
  fr.push('Unexpected terminal state. No retry, no rerun. Root diagnoses the Cloudflare binding.');
  const fout = fr.join(String.fromCharCode(10)) + String.fromCharCode(10);
  await writeFile(outDir + '/k1-' + new Date().toISOString().slice(0, 10) + '-failed.md', fout);
  process.stdout.write(fout);
  assert.fail('Unexpected terminal state for: ' + badFx.map(function (f: Fixture) { return f.key; }).join(', '));
}
for (const f of fx) assert(rowFor(f.key), 'Uploaded source missing from list for ' + f.key);
assert(fx.every(doneFor), 'Not every source reached its expected state.');
const rows: string[] = [];
let negPass = 0;
let rangeTotal = 0;
for (const f of fx) {
  const s = rowFor(f.key);
  assert(s, 'Uploaded source missing from list for ' + f.key);
  if (f.expected === 'needs_conversion') {
    assert(s.readableState === 'needs_conversion', 'Scan fixture must stay needs_conversion for ' + f.key + ', got ' + s.readableState);
    assert(s.conversionCalls <= 1, 'Scan fixture conversion calls <= 1 for ' + f.key);
    const o = await apiBytes('/api/revisions/' + encodeURIComponent(s.revisionId) + '/original');
    assert.equal(o.status, 200, 'GET original 200 for ' + f.key);
    const it = byKey.get(f.key);
    assert(it && it.bytes && o.bytes.equals(it.bytes), 'Original download must equal uploaded bytes for ' + f.key);
    negPass++;
    rows.push('| ' + s.id + ' | ' + s.converter + ' | ' + s.originalSize + ' | needs_conversion | n/a | ' + s.conversionCalls + ' | ' + s.conversionTokens + ' | ' + s.conversionMs + ' |');
    continue;
  }
  const rev = s.currentRevisionId;
  const paper = f.paper;
  if (f.kind === 'file') {
    assert(s.conversionCalls === 1, 'PDF conversion must cost exactly 1 call for ' + s.id + ', got ' + s.conversionCalls);
    const it = byKey.get(f.key);
    assert(it && it.bytes && s.originalSize === it.bytes.length, 'originalSize must equal uploaded bytes for ' + s.id);
  } else {
    assert(s.conversionCalls === 0, 'Native text conversion must cost 0 calls for ' + s.id + ', got ' + s.conversionCalls);
  }
  const w = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text');
  assert.equal(w.status, 200, 'GET text 200 for ' + s.id);
  assert(w.bytes.length > 0, 'Text non empty for ' + s.id);
  assert(!(w.bytes[0] === 239 && w.bytes[1] === 187 && w.bytes[2] === 191), 'No BOM for ' + s.id);
  new TextDecoder('utf-8', { fatal: true }).decode(w.bytes);
  const ol = await apiJson('/api/revisions/' + encodeURIComponent(rev) + '/outline');
  assert.equal(ol.status, 200, 'GET outline 200 for ' + s.id);
  const blocks = ol.body.blocks;
  if (paper) {
    assert(w.bytes.length >= 20480, 'Paper text 20KiB for ' + s.id);
    assert(blocks.length >= 50, 'Paper blocks 50 for ' + s.id);
  }
  let pe = 0;
  for (const b of blocks) {
    assert(b.start >= 0 && b.end > b.start && b.end <= w.bytes.length, 'Block bounds for ' + s.id);
    assert(b.start >= pe, 'Blocks sorted for ' + s.id);
    pe = b.end;
  }
  const seed = (Array.from(rev as string).reduce(function (a: any, c: any) {
    return (a + c.charCodeAt(0)) >>> 0;
  }, 7) as number);
  const R = rng(seed);
  // MAP three-random: offset-0 prefix plus 3 random exact ranges.
  let prefixEnd = Math.min(2000, w.bytes.length);
  while (cont(w.bytes[prefixEnd])) prefixEnd--;
  const ranges = [{ start: 0, end: prefixEnd }];
  let g = 0;
  while (ranges.length < 4 && g++ < 80) {
    let a = Math.floor(R() * w.bytes.length);
    let b = a + 200 + Math.floor(R() * 1800);
    if (b > w.bytes.length) b = w.bytes.length;
    while (a < w.bytes.length && cont(w.bytes[a])) a++;
    while (b > a && b < w.bytes.length && cont(w.bytes[b])) b--;
    if (b - a < 16 || a === 0) continue;
    ranges.push({ start: a, end: b });
  }
  for (const q of ranges) {
    const p = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + q.start + '&end=' + q.end);
    assert.equal(p.status, 200, 'GET range 200 for ' + s.id);
    assert(p.bytes.equals(w.bytes.subarray(q.start, q.end)), 'Range exact for ' + s.id);
    rangeTotal++;
  }
  rows.push('| ' + s.id + ' | ' + s.converter + ' | ' + s.originalSize + ' | ' + w.bytes.length + ' | ' + blocks.length + ' | ' + s.conversionCalls + ' | ' + s.conversionTokens + ' | ' + s.conversionMs + ' |');
}
rows.sort();
let urlResult = 'Duplicate URL (browser form): NOT_RUN without network (needs ELIOT_EVAL_NET=1; the server URL guard rejects local fixtures, so no controllable local URL exists).';
const browser = await chromium.launch();
// Browser contexts are unauthenticated and local-only; Node API requests use
// fetchEval for the explicit origin and never follow redirects with credentials.
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
try {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const name = 'K1 browser ' + Date.now();
  await page.goto(origin);
  await page.getByLabel('New project', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('link', { name, exact: true }).click();
  let activeUploads = 0, peakUploads = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/sources/file')) peakUploads = Math.max(peakUploads, ++activeUploads); });
  page.on('response', (response) => { if (response.request().method() === 'POST' && response.url().endsWith('/sources/file')) activeUploads--; });
  const text = '# Источник\n\nТочный русский текст и emoji 🙂.\n\n## Второй раздел\n\nВторой абзац.\n\n## Третий раздел\n\nТретий абзац.\n';
  const batchFiles = [0, 1, 2].map((i) => ({ name: name + '-' + i + '.md', mimeType: 'text/markdown', buffer: Buffer.from(text + '\nФайл ' + i + '\n' + name) }));
  let addDialog = await openAddSources(page);
  await addDialog.getByLabel('Choose files', { exact: true }).setInputFiles(batchFiles);
  await addDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: name + '-0.md', exact: true }).click({ timeout: 10000 });
  await expect(page.locator('.er-lib__text')).toContainText('Точный русский текст', { timeout: 10000 });
  const reader = new URL(page.url()), revisionId = reader.searchParams.get('revisionId');
  assert(revisionId, 'The reader must pin the full revision UUID.');
  const outline = await apiJson('/api/revisions/' + revisionId + '/outline');
  const whole = await apiBytes('/api/revisions/' + revisionId + '/text');
  for (const block of outline.body.blocks.slice(0, 3)) {
    const link = new URL(reader);
    link.searchParams.set('start', block.start); link.searchParams.set('end', block.end);
    await page.goto(link.href);
    await expect(page.locator('.er-lib__excerpt pre')).toHaveText(new TextDecoder('utf-8', { ignoreBOM: true }).decode(whole.bytes.subarray(block.start, block.end)));
  }
  await page.goto(reader.href);
  // Reader chrome: status/filename visible, no storage/telemetry. Paper body excluded.
  {
    const head = await page.locator('.er-lib__head').innerText();
    assert(head.includes('Readable') || head.includes('Converting') || head.includes('Needs') || head.includes('failed'), 'Reader header must show status, got: ' + head.slice(0, 200));
    assertNoUiTelemetry('reader head', head);
    const title = await page.locator('#er-lib-reader').innerText();
    assert(title.trim().length > 0, 'Reader must show filename/title.');
    const facts = page.locator('.er-lib__facts');
    if (await facts.count() > 0) assertNoUiTelemetry('reader facts', await facts.innerText());
  }
  await expect(page.locator('.er-lib__text')).toContainText('Точный русский текст');
  await page.locator('.er-lib__text').evaluate((element) => {
    const node = element.firstChild;
    if (!node?.textContent) throw new Error('Readable text is missing.');
    const start = node.textContent.indexOf('Точный русский текст');
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'Точный русский текст'.length);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  await page.getByRole('button', { name: 'Copy link to selection', exact: true }).click();
  await expect(page).toHaveURL(/start=.*end=/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const reopened = await context.newPage(); await reopened.goto(copied);
  await expect(reopened.locator('.er-lib__excerpt pre')).toHaveText('Точный русский текст');
  const replacement = '# Новая версия\n\nНовая ревизия без старого текста.\n' + name;
  await page.locator('#er-lib-replace').setInputFiles({ name: 'replacement.md', mimeType: 'text/markdown', buffer: Buffer.from(replacement) });
  await page.getByRole('button', { name: 'Upload new revision', exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(revisionId));
  await expect(page.locator('.er-lib__text')).not.toContainText('Точный русский текст');
  await expect(page.locator('.er-lib__text')).toContainText('Новая ревизия', { timeout: 10000 });
  await page.locator('.er-lib__facts summary').click();
  // Revision choice stays (Revision N select) but visible UUIDs/bytes/tokens/ms must be gone.
  {
    const factsText = await page.locator('.er-lib__facts').innerText();
    assertNoUiTelemetry('reader facts open', factsText);
    const revSelectEarly = page.locator('#er-lib-revision');
    if (await revSelectEarly.count() > 0) {
      const optEarly = await revSelectEarly.locator('option').allInnerTexts();
      const joinedEarly = optEarly.join('\n');
      assert(joinedEarly.includes('Revision '), 'Revision choice must stay visible, got: ' + joinedEarly.slice(0, 300));
      assertNoUiTelemetry('revision options', joinedEarly);
    }
  }
  const sidBefore = new URL(page.url()).pathname.split('/')[4] as string;
  const rowsBefore = (await apiJson('/api/sources/' + sidBefore)).body.revisions as any[];
  const oldRow = rowsBefore.find((r: any) => r.id === revisionId);
  assert(oldRow && Number.isSafeInteger(oldRow.revisionNo) && oldRow.revisionNo >= 1, 'API must report the true original revision number.');
  const revSelect = page.locator('#er-lib-revision');
  await expect(revSelect).toBeVisible();
  {
    const optText = await revSelect.locator('option').allInnerTexts();
    const joined = optText.join('\n');
    assert(joined.includes('Revision ' + oldRow.revisionNo), 'Revision choice must list original Revision ' + oldRow.revisionNo + ', got: ' + joined.slice(0, 300));
    assertNoUiTelemetry('revision options open', joined);
  }
  await revSelect.selectOption(revisionId);
  await expect(page.locator('.er-lib__text')).not.toContainText('Новая ревизия');
  await expect(page.locator('.er-lib__text')).toContainText('Точный русский текст');
  await reopened.reload();
  await expect(reopened.locator('.er-lib__excerpt pre')).toHaveText('Точный русский текст');
  const revLoc = new URL(page.url());
  const revPid = revLoc.pathname.split('/')[2] as string;
  const revSid = revLoc.pathname.split('/')[4] as string;
  const revRows = (await apiJson('/api/sources/' + revSid)).body.revisions as any[];
  const revIds = revRows.map((r: any) => r.id) as string[];
  assert(revIds.length >= 2, 'Replaced file must keep both immutable revisions.');
  for (const r of revRows) assert(Number.isSafeInteger(r.revisionNo) && r.revisionNo >= 1, 'Every stored revision must carry its true number.');
  assert(new Set(revRows.map((r: any) => r.revisionNo)).size === revRows.length, 'True revision numbers must be unique.');
  assert(Math.max(...revRows.map((r: any) => r.revisionNo)) > oldRow.revisionNo, 'The replacement must carry a true number above the original.');
  const curRev = revLoc.searchParams.get('revisionId') as string;
  const otherRev = revIds.find((id) => id !== curRev) as string;
  assert(otherRev, 'A second immutable revision must exist.');
  const undGets: string[] = [];
  const undPosts: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/understanding')) {
      if (request.method() === 'GET') undGets.push(request.url());
      else undPosts.push(request.method() + ' ' + request.url());
    }
  });
  await page.goto(origin + '/p/' + revPid + '/source/' + revSid + '?revisionId=' + otherRev);
  await expect(page.locator('.er-und__title')).toBeVisible({ timeout: 15000 });
  // The loading title can render before the understanding read effect dispatches its GET.
  await expect.poll(() => undGets.some((u) => new URL(u).searchParams.get('revisionId') === otherRev), {
    timeout: 15000, message: 'Revision switch must GET understanding for the new exact revision.',
  }).toBe(true);
  assert.deepEqual(undPosts, [], 'Revision switch must never POST understanding.');
  addDialog = await openAddSources(page);
  await context.setOffline(true);
  await addDialog.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'offline.md', mimeType: 'text/markdown', buffer: Buffer.from('offline case') });
  await expect(addDialog.getByText(/Failed to fetch|NetworkError|fetch failed/i).first()).toBeVisible();
  await expect(addDialog.getByLabel('Choose files', { exact: true })).toBeEnabled();
  await context.setOffline(false);
  await addDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(copied);
  await expect(page.locator('.er-lib__excerpt pre')).toHaveText('Точный русский текст');
  const mainPid = new URL(copied).pathname.split('/')[2] as string;
  const dupeTextTitle = name + ' dupe text';
  const dupeTextBody = '# Дубликат\n\nТот же текст дважды ' + name + '.\n';
  const dupeUrl = resolveEvalUrl();
  let dupeUrlSrc: any = null;
  await page.goto(origin + '/p/' + mainPid + '/sources');
  // Source list chrome: title/status visible, no storage/telemetry. No paper body here.
  {
    const sources = await openSources(page);
    const rows = sources.locator('.er-sources-pane__rows');
    await expect(rows).toBeVisible();
    const listText = await rows.innerText();
    assert(listText.includes('Not analyzed') || listText.includes('Converting') || listText.includes('Needs') || listText.includes('Failed'), 'Source list must show status.');
    assertNoUiTelemetry('source list', listText);
  }
  addDialog = await openAddSources(page);
  await addDialog.getByLabel('Pasted text title', { exact: true }).fill(dupeTextTitle);
  await addDialog.getByLabel('Text', { exact: true }).fill(dupeTextBody);
  await addDialog.getByRole('button', { name: 'Add text', exact: true }).click();
  await addDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('link', { name: dupeTextTitle, exact: true })).toBeVisible({ timeout: 15000 });
  const dupeTextSrc = (await apiJson('/api/projects/' + mainPid + '/sources')).body.sources.find((s: any) => s.title === dupeTextTitle);
  assert(dupeTextSrc, 'Text source must exist in the main project.');
  if (allowNetUrl) {
    const probe = await apiJson('/api/projects/' + mainPid + '/sources/url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: dupeUrl }) });
    if (probe.status === 409) {
      assert(probe.body.duplicate && probe.body.duplicate.revisionId, 'Known URL must identify the existing revision.');
      dupeUrlSrc = { revisionId: probe.body.duplicate.revisionId };
    } else {
      assert.equal(probe.status, 202, 'URL capture must be accepted.');
      for (let attempt = 0; attempt < 40; attempt++) {
        const fetched = (await apiJson('/api/sources/' + probe.body.sourceId)).body.source;
        if (fetched && fetched.readableState === 'readable') { dupeUrlSrc = fetched; break; }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      assert(dupeUrlSrc && dupeUrlSrc.readableState === 'readable', 'Stable URL must settle readable (' + dupeUrl + ').');
    }
  }
  const other = await apiJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name + ' attached' }) });
  await page.goto(origin + '/p/' + other.body.project.id + '/sources');
  addDialog = await openAddSources(page);
  await addDialog.getByLabel('Choose files', { exact: true }).setInputFiles(batchFiles[1]);
  await expect(addDialog.getByRole('button', { name: /^Attach from Library/ })).toBeVisible();
  assert.equal((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.length, 0, 'A duplicate must not attach silently.');
  await addDialog.getByRole('button', { name: /^Attach from Library/ }).click();
  await addDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('link', { name: name + '-1.md', exact: true })).toBeVisible();
  addDialog = await openAddSources(page);
  await addDialog.getByLabel('Pasted text title', { exact: true }).fill(dupeTextTitle);
  await addDialog.getByLabel('Text', { exact: true }).fill(dupeTextBody);
  await addDialog.getByRole('button', { name: 'Add text', exact: true }).click();
  const textRow = addDialog.locator('.er-lib__progress li', { hasText: dupeTextTitle });
  await expect(textRow.getByRole('button', { name: /^Attach from Library/ })).toBeVisible({ timeout: 15000 });
  assert.equal((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.length, 1, 'A text duplicate must not attach silently.');
  await textRow.getByRole('button', { name: /^Attach from Library/ }).click();
  await addDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('link', { name: dupeTextTitle, exact: true })).toBeVisible();
  const attachedText = (await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.find((s: any) => s.title === dupeTextTitle);
  assert(attachedText, 'Attached text must be listed.');
  assert.equal(attachedText.revisionId, dupeTextSrc.revisionId, 'Attached text must reuse the original revision (no new source, no conversion).');
  assert.equal(attachedText.conversionCalls, 0, 'Attached text must perform zero conversions.');
  if (allowNetUrl) {
    const otherBefore = new Set(((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources).map((s: any) => s.id));
    addDialog = await openAddSources(page);
    await addDialog.getByLabel('Page URL (https only)', { exact: true }).fill(dupeUrl);
    await addDialog.getByRole('button', { name: 'Add URL', exact: true }).click();
    const urlRow = addDialog.locator('.er-lib__progress li', { hasText: dupeUrl });
    await expect(urlRow.getByRole('button', { name: /^Attach from Library/ })).toBeVisible({ timeout: 30000 });
    assert.equal((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.length, 2, 'A URL duplicate must not attach silently.');
    await urlRow.getByRole('button', { name: /^Attach from Library/ }).click();
    await addDialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (let attempt = 0; attempt < 20; attempt++) {
      const listed = (await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources;
      if (listed.length === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const attachedUrl = ((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources).find((s: any) => !otherBefore.has(s.id));
    assert(attachedUrl, 'Attached URL must be listed.');
    assert.equal(attachedUrl.revisionId, dupeUrlSrc.revisionId, 'Attached URL must reuse the original revision (no new source, no capture).');
    urlResult = 'Duplicate URL: explicit 409 plus Attach existing in the browser; attached revision matches the original; no new source or capture.';
  }
  assert.equal(peakUploads, 2, 'Browser file upload concurrency must be two.');
  assert.deepEqual(pageErrors, [], 'Browser runtime errors');
  await page.screenshot({ path: outDir + '/phone-reader.png', fullPage: true });
} finally { await browser.close(); }
let limitResult = '25 MiB case: NOT_RUN this pass; opt in with ELIOT_EVAL_LIMIT=1.';
if (process.env.ELIOT_EVAL_LIMIT === '1') {
  const bytes = Buffer.alloc(25 * 1024 * 1024, 97);
  bytes.write(String(Date.now()), bytes.length - 20, 'ascii');
  const body = new FormData(); body.append('file', new Blob([bytes], { type: 'text/plain' }), '25mib.txt');
  const response = await fetchEval(origin + '/api/projects/' + pid + '/sources/file', { method: 'POST', headers: H, body }, origin, process.env.ELIOT_ORIGIN);
  assert.equal(response.status, 202, 'The actual 25 MiB file must be accepted.');
  const added = await response.json() as { sourceId: string };
  let source: SourceRow | undefined;
  for (let attempt = 0; attempt < 120; attempt++) {
    source = (await apiJson('/api/sources/' + added.sourceId)).body.source;
    if (source?.readableState !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(source?.readableState === 'readable' && source.readableSize === bytes.length && source.conversionCalls === 0, 'The native boundary case must preserve all bytes without AI.');
  const over = new FormData(); over.append('file', new Blob([bytes, Buffer.from('a')], { type: 'text/plain' }), 'oversized.txt');
  const rejected = await fetchEval(origin + '/api/projects/' + pid + '/sources/file', { method: 'POST', headers: H, body: over }, origin, process.env.ELIOT_ORIGIN);
  assert.equal(rejected.status, 413, '25 MiB + 1 byte must be rejected.');
  limitResult = '25 MiB file accepted and readable with zero AI calls; 25 MiB + 1 byte returned 413.';
}
const times = list.filter((source) => source.readableState === 'readable' && source.conversionCalls === 1 && source.conversionMs !== null)
  .map((source) => source.conversionMs as number).sort((a, b) => a - b);
const p50 = times[Math.floor(times.length * 0.5)], p95 = times[Math.ceil(times.length * 0.95) - 1];
const report = [
  '# K1 Read eval', 'Origin: ' + origin + '; project: ' + pid,
  'Positive readable: ' + fx.filter((fixture) => fixture.expected !== 'needs_conversion').length + ' sources; mode: ' + (nativeOnly ? 'native-only; PDF conversion NOT_RUN' : 'ten arXiv, two Russian papers, native text') + '.',
  'Scan negative: ' + negPass + '/' + fx.filter((fixture) => fixture.expected === 'needs_conversion').length + ' needs_conversion, original byte-exact, OCR disabled.',
  '', '| source | converter | original | readable | blocks | calls | conversion tokens | ms |',
  '|---|---|---|---|---|---|---|---|', ...rows, '',
  'Exact ranges: ' + rangeTotal + '/' + (fx.filter((fixture) => fixture.expected !== 'needs_conversion').length * 4) + ' (prefix plus three random ranges per readable source).',
  'Phone: PASS, batch concurrency 2, exact links, old revision stable, offline recovery, explicit duplicate Attach.',
  'Duplicate text: explicit 409 plus Attach existing in the browser; attached revision matches the original; no new source or conversion.',
  urlResult,
  limitResult,
  'Readable PDF conversion p50/p95: ' + (times.length ? p50 + '/' + p95 + ' ms (recorded latest attempts)' : 'NOT_RUN (native-only)') + '.',
  'Model/search calls: 0. Conversion usage is listed above; no automatic retry.',
  'Cloud deployment, deployed browser login and isolate peak heap: NOT_RUN.',
].join('\n') + '\n';
await writeFile(outDir + '/k1-' + new Date().toISOString().slice(0, 10) + '.md', report);
process.stdout.write(report);
