import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
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
const origin = new URL(process.env.ELIOT_URL || 'http://127.0.0.1:5173').origin;
const nativeOnly = process.argv.includes('--native-only');
const allowNetUrl = !nativeOnly || process.env.ELIOT_EVAL_NET === '1';
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
await mkdir(cacheDir, { recursive: true });
await mkdir(outDir, { recursive: true });
async function apiJson(path: string, init?: any): Promise<any> {
  const r = await fetch(origin + path, {
    ...init,
    headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) },
  });
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
  const r = await fetch(origin + path, { headers: { ...H } });
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
const me = await apiJson('/api/me');
assert.equal(me.status, 200, 'GET /api/me must be 200; start pnpm dev first.');
assert.equal(me.body.actor.type, 'owner', 'Eval must run as owner.');
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
    const r = await fetch(origin + '/api/projects/' + encodeURIComponent(pid) + '/sources/file', {
      method: 'POST',
      headers: { ...H },
      body: fd,
    });
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
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'], extraHTTPHeaders: H });
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
  await page.locator('#er-lib-files').setInputFiles(batchFiles);
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
  await page.locator('.er-lib__facts a').filter({ hasText: revisionId.slice(0, 8) }).click();
  await expect(page.locator('.er-lib__text')).not.toContainText('Новая ревизия');
  await expect(page.locator('.er-lib__text')).toContainText('Точный русский текст');
  await reopened.reload();
  await expect(reopened.locator('.er-lib__excerpt pre')).toHaveText('Точный русский текст');
  const revLoc = new URL(page.url());
  const revPid = revLoc.pathname.split('/')[2] as string;
  const revSid = revLoc.pathname.split('/')[4] as string;
  const revIds = (await apiJson('/api/sources/' + revSid)).body.revisions.map((r: any) => r.id) as string[];
  assert(revIds.length >= 2, 'Replaced file must keep both immutable revisions.');
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
  assert(undGets.some((u) => u.includes(encodeURIComponent(otherRev))), 'Revision switch must GET understanding for the new exact revision.');
  assert.deepEqual(undPosts, [], 'Revision switch must never POST understanding.');
  await page.locator('#workspace-main').getByRole('link', { name: 'Sources', exact: true }).click();
  await expect(page.locator('#er-lib-files')).toBeVisible();
  await context.setOffline(true);
  await page.locator('#er-lib-files').setInputFiles({ name: 'offline.md', mimeType: 'text/markdown', buffer: Buffer.from('offline case') });
  await expect(page.getByText(/Failed to fetch|NetworkError|fetch failed/i).first()).toBeVisible();
  await expect(page.locator('#er-lib-files')).toBeEnabled();
  await context.setOffline(false);
  await page.goto(copied);
  await expect(page.locator('.er-lib__excerpt pre')).toHaveText('Точный русский текст');
  const mainPid = new URL(copied).pathname.split('/')[2] as string;
  const dupeTextTitle = name + ' dupe text';
  const dupeTextBody = '# Дубликат\n\nТот же текст дважды ' + name + '.\n';
  const dupeUrl = 'https://example.com/';
  let dupeUrlSrc: any = null;
  await page.goto(origin + '/p/' + mainPid + '/sources');
  await expect(page.locator('#er-lib-files')).toBeVisible();
  await page.locator('#er-lib-text-title').fill(dupeTextTitle);
  await page.locator('#er-lib-text-body').fill(dupeTextBody);
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
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
      assert(dupeUrlSrc && dupeUrlSrc.readableState === 'readable', 'Example URL must settle readable.');
    }
  }
  const other = await apiJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name + ' attached' }) });
  await page.goto(origin + '/p/' + other.body.project.id + '/sources');
  await expect(page.locator('#er-lib-files')).toBeVisible();
  await page.locator('#er-lib-files').setInputFiles(batchFiles[1]);
  await expect(page.getByRole('button', { name: /^Attach existing/ })).toBeVisible();
  assert.equal((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.length, 0, 'A duplicate must not attach silently.');
  await page.getByRole('button', { name: /^Attach existing/ }).click();
  await expect(page.getByRole('link', { name: name + '-1.md', exact: true })).toBeVisible();
  await page.locator('#er-lib-text-title').fill(dupeTextTitle);
  await page.locator('#er-lib-text-body').fill(dupeTextBody);
  await page.getByRole('button', { name: 'Save text', exact: true }).click();
  const textRow = page.locator('.er-lib__progress li', { hasText: dupeTextTitle });
  await expect(textRow.getByRole('button', { name: /^Attach existing/ })).toBeVisible({ timeout: 15000 });
  assert.equal((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.length, 1, 'A text duplicate must not attach silently.');
  await textRow.getByRole('button', { name: /^Attach existing/ }).click();
  await expect(page.getByRole('link', { name: dupeTextTitle, exact: true })).toBeVisible();
  const attachedText = (await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.find((s: any) => s.title === dupeTextTitle);
  assert(attachedText, 'Attached text must be listed.');
  assert.equal(attachedText.revisionId, dupeTextSrc.revisionId, 'Attached text must reuse the original revision (no new source, no conversion).');
  assert.equal(attachedText.conversionCalls, 0, 'Attached text must perform zero conversions.');
  if (allowNetUrl) {
    const otherBefore = new Set(((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources).map((s: any) => s.id));
    await page.locator('#er-lib-url').fill(dupeUrl);
    await page.getByRole('button', { name: 'Add URL', exact: true }).click();
    const urlRow = page.locator('.er-lib__progress li', { hasText: dupeUrl });
    await expect(urlRow.getByRole('button', { name: /^Attach existing/ })).toBeVisible({ timeout: 30000 });
    assert.equal((await apiJson('/api/projects/' + other.body.project.id + '/sources')).body.sources.length, 2, 'A URL duplicate must not attach silently.');
    await urlRow.getByRole('button', { name: /^Attach existing/ }).click();
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
  const response = await fetch(origin + '/api/projects/' + pid + '/sources/file', { method: 'POST', headers: H, body });
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
  const rejected = await fetch(origin + '/api/projects/' + pid + '/sources/file', { method: 'POST', headers: H, body: over });
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
