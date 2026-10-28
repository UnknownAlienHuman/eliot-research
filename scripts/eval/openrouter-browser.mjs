// OpenRouter smoke: read-only browser WS listener + storage checks by default (no model calls).
// Root-only RUN_TURN=1: after WS open, if the target turn is missing, the script sends exactly
// one POST /turns?wait=0 for the known free route (enabled + price 0 + gateway present), no retries.
// If the target is already terminal, no POST happens (runTurnPosted=false) and liveStreaming is
// reported NOT_RUN while storage checks can still PASS. Root prepares ids.json/ids.stream.
// Run: ELIOT_URL=http://127.0.0.1:5175 node scripts/eval/openrouter-browser.mjs
// Optional: MODEL_ROUTE=<route> picks the live entry; default is the first models entry.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

// This journey needs a WebSocket. The scoped HTTP route cannot attach Access
// headers to WebSocket handshakes, so remote authenticated browser runs fail closed.
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const H = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();

const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const RUN_TURN = process.env.RUN_TURN === '1';
const TERMINAL_WAIT_MS = RUN_TURN ? 300000 : 180000;
const IDS = fileURLToPath(new URL('../../eval/out/openrouter-smoke/ids.json', import.meta.url));
const OUT = fileURLToPath(new URL('../../eval/out/openrouter-smoke/', import.meta.url));
await mkdir(OUT, { recursive: true });

async function apiJson(path, init) {
  const scriptMethod = (init && init.method) || 'GET';
  if (scriptMethod !== 'GET' && scriptMethod !== 'HEAD' && scriptMethod !== 'OPTIONS') mutating.push({ method: scriptMethod, url: origin + path, phase: 'script:dispatch' });
  const r = await fetchEval(origin + path, {
    ...init,
    headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) },
  }, origin, process.env.ELIOT_ORIGIN);
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: String(t).slice(0, 300) }; }
  return { status: r.status, body: b };
}

const ids = JSON.parse(await readFile(IDS, 'utf8'));
const pid = ids.projectId;
assert(typeof pid === 'string' && pid.length > 0, 'ids.json must carry projectId.');
const entries = ids.models;
assert(Array.isArray(entries) && entries.length > 0, 'ids.json must carry models[].');
const LIVE_ROUTE = process.env.MODEL_ROUTE || null;
const live = LIVE_ROUTE ? entries.find((e) => e.route === LIVE_ROUTE) : entries[0];
assert(live, 'live route entry not found in ids.json.');
const liveTurnId = process.env.STREAM_TURN_ID || (ids.stream && ids.stream.turnId) || live.turnId;
const liveEntry = Object.assign({}, live, { turnId: liveTurnId });
assert(typeof liveTurnId === 'string' && liveTurnId.length > 0, 'live turnId required (manifest or STREAM_TURN_ID).');

const mutating = [];
function track(req, phase) {
  if (req.method() === 'GET' || req.method() === 'HEAD' || req.method() === 'OPTIONS') return;
  mutating.push({ method: req.method(), url: req.url(), phase });
}
const chatPath = (chatId) => '/api/projects/' + encodeURIComponent(pid) + '/chats/' + encodeURIComponent(chatId);
async function getChat(chatId, what) {
  const h = await apiJson(chatPath(chatId));
  assert.equal(h.status, 200, 'GET chat must be 200 and storage-only (' + what + ').');
  assert(h.body && Array.isArray(h.body.turns), 'GET chat must return turns (' + what + ').');
  return h.body;
}
async function getSources() {
  const s = await apiJson('/api/projects/' + encodeURIComponent(pid) + '/sources');
  assert.equal(s.status, 200, 'GET sources must be 200.');
  return s.body.sources || [];
}
const turnKey = (t) => t.turnId + '|' + t.state + '|' + String(t.answer || '').length;

const browser = await chromium.launch();
// The browser uses local development auth; Access credentials stay on Node's
// origin-pinned HTTP requests and are never installed as context-wide headers.
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const facts = { origin, liveRoute: live.route, entries: [], mutating };
process.on('uncaughtException', async (err) => {
  try {
    await writeFile(OUT + 'browser-failed-' + Date.now() + '.json', JSON.stringify({ storage: 'FAIL', liveStreaming: 'NOT_RUN', liveRoute: live.route, streamTurnId: typeof liveTurnId !== 'undefined' ? liveTurnId : null, error: String(err && err.message ? err.message : err).slice(0, 500), pendingEntry: facts.pendingEntry || null, frames: (facts.pendingFrames || []).slice(-200) }, null, 2));
  } catch { /* best effort */ }
  try { await browser.close(); } catch { /* best effort */ }
  process.exit(1);
});

async function openChat(entry) {
  const page = await context.newPage();
  const frames = [];
  page.on('request', (req) => track(req, 'chat:' + entry.chatId));
  page.on('websocket', (ws) => {
    if (!String(ws.url()).includes('/agents/chat-agent/')) return;
    ws.on('framereceived', (event) => {
      if (frames.length > 2000) return;
      try {
        const data = event && typeof event.payload !== 'undefined' ? event.payload : event;
        const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const msg = JSON.parse(raw);
        if (!msg || typeof msg.type !== 'string') return;
       const summary = { at: Date.now(), type: msg.type };
        if (Array.isArray(msg.turns)) summary.turns = msg.turns.map((t) => t.turnId + ':' + t.state + ':' + String((t.answer || '').length));
        if (msg.turn) summary.turn = msg.turn.turnId + ':' + msg.turn.state + ':' + String((msg.turn.answer || '').length);
        frames.push(summary);
      } catch { /* control/binary frame */ }
    });
  });
  await page.goto(origin + '/p/' + encodeURIComponent(pid) + '/chat/' + encodeURIComponent(entry.chatId));
  await expect(page.getByRole('status').filter({ hasText: 'Socket: open' }).first()).toBeVisible({ timeout: 30000 });
  return { page, frames };
}

async function waitTerminal(frames, turnId) {
  const deadline = Date.now() + TERMINAL_WAIT_MS;
  while (Date.now() < deadline) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (f.turn) {
        const parts = String(f.turn).split(':');
        if (parts[0] === turnId && TERMINAL.has(parts[1])) return f;
      }
      if (Array.isArray(f.turns)) {
        const hit = f.turns.find((s) => String(s).split(':')[0] === turnId && TERMINAL.has(String(s).split(':')[1]));
        if (hit) return { at: f.at, type: f.type, turn: hit };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Terminal turn frame not seen within 180s for ' + turnId + ' (root may not have started it).');
}

function frameKind(frames, want) {
  return frames.find((f) => {
    if (want === 'initial') return f.type === 'snapshot';
    const s = f.turn || '';
    if (want === 'started') return String(s).includes(':started:') && !String(s).endsWith(':0');
    return false;
  }) || null;
}
function frameStartedLive(frames, turnId) {
  const hit = (s) => { const p = String(s).split(':'); return p[0] === turnId && p[1] === 'started' && p[2] !== '0'; };
  return frames.find((f) => (f.turn && hit(f.turn)) || (Array.isArray(f.turns) && f.turns.some(hit))) || null;
}

async function checkReloadSame(entry, page, before) {
  const mark = mutating.length;
  await page.reload();
  await expect(page.getByText(/Answered|Partial answer|Stopped|Failed/, { exact: false }).first()).toBeVisible({ timeout: 30000 });
  const after = await getChat(entry.chatId, 'after-reload');
  const bt = before.turns.find((t) => t.turnId === entry.turnId);
  const at = after.turns.find((t) => t.turnId === entry.turnId);
  assert(bt && at, 'target turn must exist before and after reload.');
  assert.equal(at.turnId, bt.turnId, 'turnId must survive reload.');
  assert.equal(at.answer, bt.answer, 'answer must survive reload byte-identical.');
  const fresh = mutating.slice(mark);
  assert.equal(fresh.length, 0, 'reload must send no mutating requests, got ' + JSON.stringify(fresh));
  return after;
}

// ---- live entry: full streaming listen + save + page ----
const base0 = await getChat(live.chatId, 'baseline');
const used0 = base0.monthlyUsedMicrousd;
const budget0 = base0.monthlyBudgetMicrousd;
const src0 = await getSources();
const liveRec = { route: live.route, chatId: live.chatId, manifestTurnId: live.turnId, turnId: liveTurnId, usedBefore: used0, budget: budget0, sourceCountBefore: src0.length };
const opened = await openChat(liveEntry);
facts.pendingEntry = liveRec;
facts.pendingFrames = opened.frames;
console.log('READY:' + live.chatId);
await writeFile(OUT + 'ready-' + live.chatId + '.json', JSON.stringify({ ready: true, chatId: live.chatId, at: Date.now() }));
const preRun = await getChat(live.chatId, 'pre-run-check');
const preExisting = preRun.turns.find((t) => t.turnId === liveTurnId);
liveRec.runTurnPosted = false;
if (!preExisting && RUN_TURN) {
  const mm = await apiJson('/api/models');
  assert.equal(mm.status, 200, 'GET /models must be 200 before RUN_TURN.');
  const spec = (mm.body.models || []).find((x) => x && x.route === live.route);
  assert(spec, 'live route must be listed in GET /models.');
  assert(spec.enabled, 'live route must be enabled.');
  assert(spec.inputMicrousdPerMillion === 0 && spec.outputMicrousdPerMillion === 0 && (spec.cachedMicrousdPerMillion || 0) === 0, 'live route price must be 0.');
  const conn = await apiJson('/api/models/connection');
  assert(conn.status === 200 && conn.body && conn.body.connection && typeof conn.body.connection.gatewayId === 'string' && conn.body.connection.gatewayId.length > 0, 'gateway connection must exist before RUN_TURN.');
  const streamQ = (ids.stream && ids.stream.question) || null;
  assert(typeof streamQ === 'string' && streamQ.trim().length > 0, 'ids.stream.question required for RUN_TURN.');
  const streamSrc = (ids.stream && ids.stream.sourceId) || live.sourceId;
  assert(typeof streamSrc === 'string' && streamSrc.length > 0, 'stream sourceId required for RUN_TURN.');
  const posted = await apiJson(chatPath(live.chatId) + '/turns?wait=0', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId: liveTurnId, question: streamQ, scopeMode: 'explicit', sourceIds: [streamSrc], model: live.route }) });
  assert.equal(posted.status, 202, 'RUN_TURN POST /turns?wait=0 must be 202.');
  liveRec.runTurnPosted = true;
} else if (!preExisting) {
  throw new Error('target turn missing and RUN_TURN!=1; root launches the script with RUN_TURN=1.');
}
const termFrame = await waitTerminal(opened.frames, liveTurnId);
const termApi = await getChat(live.chatId, 'after-terminal');
const termTurn = termApi.turns.find((t) => t.turnId === liveTurnId);
assert(termTurn, 'terminal turn must be stored.');
assert(TERMINAL.has(termTurn.state), 'stored turn must be terminal, got ' + termTurn.state + '.');
const firstSnap = frameKind(opened.frames, 'initial');
assert(firstSnap, 'initial snapshot frame required.');
let startedLive = frameStartedLive(opened.frames, liveTurnId);
liveRec.liveStreaming = 'PASS';
if (!startedLive) {
  const snapTurns = (firstSnap && firstSnap.turns) || [];
  const pre = snapTurns.some((s) => { const p = String(s).split(':'); return p[0] === liveTurnId && TERMINAL.has(p[1]); });
  if (pre) { liveRec.liveStreaming = 'NOT_RUN'; startedLive = 'ALREADY_TERMINAL_AT_OPEN'; }
}
assert(startedLive, 'started non-empty frame required (live).');
liveRec.frames = { initial: firstSnap, started: startedLive, terminal: termFrame };
liveRec.terminal = { state: termTurn.state, answerChars: String(termTurn.answer || '').length, citations: (termTurn.citations || []).length, invalidLabels: termTurn.invalidLabels };
liveRec.usedAfterTerminal = termApi.monthlyUsedMicrousd;
assert.equal(termApi.monthlyBudgetMicrousd, budget0, 'budget must not move.');
const afterReload = await checkReloadSame(liveEntry, opened.page, termApi);
liveRec.reloadSame = true;

if (process.env.SAVE_PAGE === '1') {
// Save target-turn answer via UI (storage-only); scoped to the new turn because the old one exists.
const saveMark = mutating.length;
await opened.page.locator('li.er-chat__turn', { hasText: String(termTurn.question || '').slice(0, 40) }).getByRole('button', { name: 'Save as page', exact: true }).click();
await expect(opened.page.getByText('Saved.', { exact: true })).toBeVisible({ timeout: 30000 });
const saveReqs = mutating.slice(saveMark);
assert.equal(saveReqs.length, 1, 'save must send exactly one mutating request, got ' + JSON.stringify(saveReqs));
assert(saveReqs[0].method === 'POST' && saveReqs[0].url.includes('/pages/from-turn'), 'save must only POST pages/from-turn.');
liveRec.savePost = saveReqs[0].url;

// Open the saved page in Studio and check exact citation links.
const pageTitle = String(termTurn.question || '').slice(0, 120) || 'Saved answer';
await opened.page.goto(origin + '/p/' + encodeURIComponent(pid) + '/studio');
await opened.page.getByRole('button', { name: pageTitle, exact: true }).click();
await expect(opened.page.locator('.er-chat__page')).toBeVisible({ timeout: 30000 });
const bodyText = await opened.page.locator('.er-chat__page').innerText();
assert(bodyText.trim().length > 0, 'saved page body must be non-empty.');
const citeHref = await opened.page.locator('.er-chat__cite a').first().getAttribute('href');
assert(citeHref && /\/p\/.+\/source\/.+[?&]revisionId=.+[?&]start=\d+.+[?&]end=\d+/.test(citeHref), 'page must link exact revision bytes, got ' + citeHref);
const m = /\/source\/([^?]+)\?revisionId=([^&]+)&start=(\d+)&end=(\d+)/.exec(citeHref);
assert(m, 'citation href must parse.');
const range = await fetchEval(origin + '/api/revisions/' + encodeURIComponent(m[2]) + '/range?start=' + m[3] + '&end=' + m[4], { headers: { ...H } }, origin, process.env.ELIOT_ORIGIN);
assert.equal(range.status, 200, 'citation range must open (storage-only).');
const rangeBytes = Buffer.from(await range.arrayBuffer());
assert.equal(rangeBytes.length, Number(m[4]) - Number(m[3]), 'citation range must return exact bytes.');
liveRec.page = { title: pageTitle, bodyChars: bodyText.length, citeHref, rangeBytes: rangeBytes.length };
}
await opened.page.close();

// Storage tail: usage and turns must be stable after all read-only steps.
const tail = await getChat(live.chatId, 'storage-tail');
const srcTail = await getSources();
assert.equal(tail.monthlyUsedMicrousd, liveRec.usedAfterTerminal, 'usage must be stable across storage-only steps.');
assert.equal(tail.monthlyBudgetMicrousd, budget0, 'budget must not move.');
assert.deepEqual(tail.turns.map(turnKey), afterReload.turns.map(turnKey), 'turns must be stable across storage-only steps.');
assert.deepEqual(srcTail.map((s) => s.id).sort(), src0.map((s) => s.id).sort(), 'sources must be unchanged.');
liveRec.usedAfterStorage = tail.monthlyUsedMicrousd;
liveRec.sourceCountAfter = srcTail.length;
facts.entries.push(liveRec);

// ---- other entries: read-only storage checks only ----
for (const entry of entries) {
  if (entry.chatId === live.chatId) continue;
  const rec = { route: entry.route, chatId: entry.chatId, turnId: entry.turnId, readOnly: true };
  const b0 = await getChat(entry.chatId, 'ro-baseline');
  const o = await openChat(entry);
  rec.initial = frameKind(o.frames, 'initial');
  assert(rec.initial, 'initial snapshot frame required.');
  const mark = mutating.length;
  await o.page.reload();
  await expect(o.page.getByRole('status').filter({ hasText: 'Socket: open' }).first()).toBeVisible({ timeout: 30000 });
  const b1 = await getChat(entry.chatId, 'ro-after-reload');
  assert.deepEqual(b1.turns.map(turnKey), b0.turns.map(turnKey), 'turns must survive reload.');
  assert.equal(mutating.length, mark, 'read-only entry must send no mutating requests.');
  rec.same = true;
  await o.page.close();
  facts.entries.push(rec);
}

// Global proof: the only mutating request in the whole run is the single page save.
const turnPosts = mutating.filter((m) => m.method === 'POST' && /\/turns(\?|$)/.test(m.url));
const savePosts = mutating.filter((m) => m.method === 'POST' && m.url.includes('/pages/from-turn'));
assert(turnPosts.length === (liveRec.runTurnPosted ? 1 : 0), 'exactly one POST /turns when runTurnPosted.');
assert(savePosts.length === (process.env.SAVE_PAGE === '1' ? 1 : 0), 'exactly one save POST when SAVE_PAGE=1.');
assert(mutating.length === turnPosts.length + savePosts.length, 'no other mutating requests allowed.');
facts.mutating = mutating;
await writeFile(OUT + 'browser-' + Date.now() + '.json', JSON.stringify(facts, null, 2));
console.log(JSON.stringify({ storage: 'PASS', liveStreaming: liveRec.liveStreaming, liveRoute: live.route, streamTurnId: liveTurnId, usedBefore: used0, usedAfterTerminal: liveRec.usedAfterTerminal, usedAfterStorage: liveRec.usedAfterStorage, budget: budget0 }, null, 2));
await browser.close();
process.exit(0);
