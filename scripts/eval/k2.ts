import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const EOL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const BACKSLASH = String.fromCharCode(92);
const BT = String.fromCharCode(96);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const SUPMINUS = String.fromCodePoint(0x207B);
const SUP8 = String.fromCodePoint(0x2078);
const UNIMINUS = String.fromCodePoint(0x2212);
const MIDDOT = String.fromCodePoint(0x00B7);
const origin = new URL(process.env.ELIOT_URL || 'http://127.0.0.1:5173').origin;
const H = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
const nativeOnly = process.argv.includes('--native-only');
const runModel = !nativeOnly && process.env.ELIOT_K2_MODEL === '1';
const resumeChat = process.env.ELIOT_EVAL_CHAT || null;
const evalDir = fileURLToPath(new URL('../../eval/', import.meta.url));
const outDir = fileURLToPath(new URL('../../eval/out/k2/', import.meta.url));
await mkdir(outDir, { recursive: true });
async function apiJson(path, init) {
  const r = await fetch(origin + path, { ...init, headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) } });
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: t.slice(0, 300) }; }
  return { status: r.status, body: b };
}
async function apiBytes(path) {
  const r = await fetch(origin + path, { headers: { ...H } });
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
}
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function normMath(s) {
  let n = String(s).replace(/\[(?:S\d+|R[0-9a-f-]{36}):\d+\]/gi, ' ').toLowerCase().split(',').join('.');
  n = n.split(SUPMINUS).join('-').split(SUP8).join('8').split(UNIMINUS).join('-');
  n = n.split('=').join(' = ');
  const strip = ['$', '*', '_', BT, BACKSLASH, '{', '}', '^', '(', ')', '[', ']', ':', ';', SQ, DQ, MIDDOT];
  for (const ch of strip) n = n.split(ch).join(' ');
  n = n.split(EOL).join(' ').split(TAB).join(' ');
  while (n.includes('  ')) n = n.split('  ').join(' ');
  return ' ' + n + ' ';
}
function checkAnswer(qid, ans) {
  const m = normMath(ans);
  const has = (...ss) => ss.every((s) => m.includes(s));
  if (qid === 'C1') {
    assert(m.includes('512'), 'C1 must contain 512.');
    const w = m.split(' ');
    let heads8 = /\bh\s*=\s*8(?!\d)/u.test(m) || /(?:голов[а-яё]*|heads?)[^.!?\n]{0,70}\b8\b|\b8\b[^.!?\n]{0,70}(?:голов[а-яё]*|heads?)/iu.test(m);
    for (let i = 0; i < w.length && !heads8; i++) {
      if (w[i] === '8' && i > 0 && (String(w[i - 1]).includes('head') || String(w[i - 1]).includes('голов'))) heads8 = true;
      if (w[i] === '8' && i + 1 < w.length && (String(w[i + 1]).includes('head') || String(w[i + 1]).includes('голов'))) heads8 = true;
    }
    assert(heads8 || m.includes(' восемь ') || m.includes(' eight '), 'C1 must contain h=8 or 8 heads in either order.');
  }
  if (qid === 'C2') {
    const warm = m.includes('warmup') || m.includes('warm-up') || m.includes('warm up') || m.includes('разогрев') || m.includes('прогрев') || m.includes('размин');
    const strictFormula = has('4000') && warm && (m.includes('d model') || m.includes('step')) && m.includes('min') && m.includes('-0.5') && m.includes('-1.5');
    const sqrtFormula = m.includes('sqrt') && has('4000') && warm;
    assert(strictFormula || sqrtFormula, 'C2 must contain the schedule formula d_model^-0.5 min(step^-0.5, step warmup^-1.5) with warmup 4000, or its sqrt equivalent.');
  }
  if (qid === 'C3') assert(has('0.001') && has('0.9') && has('0.999') && (has('1e-8') || m.includes('10 -8') || m.includes('10 - 8') || m.includes('10-8') || has('0.00000001')), 'C3 must contain Adam defaults with the numeric epsilon 1e-8 (the word alone does not pass).');
  if (qid === 'C4') assert((m.includes('синус') || m.includes('sinus')) && (m.includes('обуч') || m.includes('learn')), 'C4: sinusoidal vs learned.');
  if (qid === 'O8') assert(/нет в корпусе|в корпусе нет|не решают|не содержат|ни одн(?:а|ой|ого|у)|abstain|not in (the )?corpus|no paper/i.test(ans), 'O8 must abstain: the corpus does not solve hallucinations.');
}
const BUDGET_DEFAULT = 5000000;
const me = await apiJson('/api/me');
assert.equal(me.status, 200, 'GET /api/me must be 200; start pnpm dev first.');
assert.equal(me.body.actor.type, 'owner', 'Eval must run as owner.');
const title = process.env.ELIOT_EVAL_PROJECT || (nativeOnly ? 'k1-eval' : 'Библиотека — PDF и точные ссылки');
let projects = [], cursor = undefined;
for (let i = 0; i < 5; i++) {
  const p = await apiJson('/api/projects' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  assert.equal(p.status, 200, 'GET /api/projects must be 200.');
  projects = projects.concat(p.body.projects || []);
  cursor = p.body.nextCursor || undefined;
  if (!cursor) break;
}
const proj = projects.find((p) => p.title === title);
if (!proj) { console.log('PREP_K1_NOT_READY: project ' + JSON.stringify(title) + ' not found; prep K1 corpus first, do not upload/convert again.'); process.exit(2); }
let sources = [], scur = undefined;
for (let i = 0; i < 10; i++) {
  const s = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/sources' + (scur ? '?cursor=' + encodeURIComponent(scur) : ''));
  assert.equal(s.status, 200, 'GET sources must be 200.');
  sources = sources.concat(s.body.sources || []);
  scur = s.body.nextCursor || undefined;
  if (!scur) break;
}
const want = new Set(Array.from({ length: 10 }, (_, i) => 'arxiv-' + String(i + 1).padStart(2, '0') + '.pdf'));
const scoped = sources.filter((s) => want.has(s.originalFilename) && s.currentRevisionId && (s.readableState === 'readable' || s.readableState === 'readable_with_warnings'));
if (!nativeOnly && scoped.length < 10) { console.log('PREP_K1_NOT_READY: found ' + scoped.length + '/10 arxiv readable; prep K1 first, do not upload/convert again.'); process.exit(2); }
const sourceIds = scoped.map((s) => s.id);
const revSet = new Set(scoped.map((s) => s.currentRevisionId));
const qmd = await readFile(evalDir + '/arxiv-10/questions.md', 'utf8');
const order = ['C1', 'C2', 'C3', 'C4', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8'];
const Q = new Map();
for (const line of qmd.split(EOL)) {
  const parts = line.split('|').map((p) => p.trim());
  if (parts.length >= 3 && order.includes(parts[1]) && parts[2]) Q.set(parts[1], parts[2]);
}
assert.equal(Q.size, 12, 'questions.md must define C1-4 and O1-8.');
let chatId = resumeChat;
if (!chatId) {
  const cj = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'k2-eval ' + Date.now() }) });
  assert(cj.status === 201 || cj.status === 200, 'POST chats must be 201/200; got ' + cj.status + ' (K2 product API not wired yet).');
  assert(cj.body && typeof cj.body.chat === 'object', 'POST chats must return {chat}.');
  assert(typeof cj.body.chat.id === 'string' && cj.body.chat.id.length > 0, 'chat.id required.');
  chatId = cj.body.chat.id;
}
const chatPath = '/api/projects/' + encodeURIComponent(proj.id) + '/chats/' + encodeURIComponent(chatId);
async function getChat(what) {
  const h = await apiJson(chatPath);
  assert.equal(h.status, 200, 'GET chat must be 200 and storage-only (' + what + ').');
  assert(h.body && typeof h.body.chat === 'object', 'GET chat must return {chat, turns, monthlyUsedMicrousd, monthlyBudgetMicrousd}.');
  assert(Array.isArray(h.body.turns), 'GET chat must return turns array.');
  assert(typeof h.body.monthlyUsedMicrousd === 'number', 'GET chat must return monthlyUsedMicrousd.');
  assert(typeof h.body.monthlyBudgetMicrousd === 'number', 'GET chat must return monthlyBudgetMicrousd.');
  assert.equal(h.body.monthlyBudgetMicrousd, BUDGET_DEFAULT, 'Monthly budget must stay at the $5 default; this script never overrides it.');
  return h.body;
}
const h0 = await getChat(resumeChat ? 'resume' : 'before');
if (resumeChat) assert.equal(h0.chat.id, resumeChat, 'Resumed chat id must match ELIOT_EVAL_CHAT.');
const m0 = h0.monthlyUsedMicrousd;
const whole = new Map();
async function checkRange(rev, st, en) {
  let w = whole.get(rev);
  if (!w) { const t = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text'); assert.equal(t.status, 200, 'GET revision text 200.'); w = t.bytes; whole.set(rev, w); }
  const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + st + '&end=' + en);
  assert.equal(r.status, 200, 'Each cited range must open (GET range 200).');
  assert(r.bytes.equals(w.subarray(st, en)), 'Cited range must equal the whole-text slice.');
}
{
  const s0 = scoped[0] || sources.find((source) => source.currentRevisionId && ['readable', 'readable_with_warnings'].includes(source.readableState));
  assert(s0, 'A readable K1 source is required for the native reader check.');
  const t = await apiBytes('/api/revisions/' + encodeURIComponent(s0.currentRevisionId) + '/text');
  assert.equal(t.status, 200, 'Native reader check needs GET text 200.');
  let end = Math.min(512, t.bytes.length);
  while (end > 0 && (t.bytes[end] & 192) === 128) end--;
  await checkRange(s0.currentRevisionId, 0, end);
}
async function saveTurn(qid, turn, extra) {
  const doc = { chatId, qid, turnId: turn.turnId, reused: !!extra.reused, src: extra.src, question: extra.question || null, answer: turn.answer ?? null, state: turn.state, citations: turn.citations ?? null, invalidLabels: turn.invalidLabels ?? null, inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null, estimatedCostMicrousd: turn.estimatedCostMicrousd ?? null, firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: extra.wall ?? null };
  await writeFile(outDir + '/k2-' + qid + '-' + String(turn.turnId).slice(0, 8) + '.json', JSON.stringify(doc, null, 2));
}
function reusableCandidate(qid, turns, used) {
  for (const t of turns) {
    if (!t || typeof t.turnId !== 'string' || used.has(t.turnId) || t.state !== 'completed') continue;
    if (!Array.isArray(t.citations) || t.citations.length < 1 || t.invalidLabels !== 0) continue;
    if (typeof t.answer !== 'string') continue;
    if (!t.citations.every((c) => c && revSet.has(c.revisionId))) continue;
    if (t.question !== Q.get(qid)) continue;
    if (!Array.isArray(t.sourceIds) || t.sourceIds.length !== sourceIds.length || !sourceIds.every((id) => t.sourceIds.includes(id))) continue;
    return t;
  }
  return null;
}
if (!runModel) {
  const h1 = await getChat('re-read');
  assert.equal(h1.turns.length, h0.turns.length, 'History re-read must not add turns.');
  assert.equal(h1.monthlyUsedMicrousd, m0, 'Pure history re-read must not change usage.');
  const md = ['# K2 native-only (storage, zero model calls)', '', '- project: ' + title, '- chat: ' + chatId + (resumeChat ? ' (resumed)' : ''), '- history: ' + h0.turns.length + ' turns, monthlyUsedMicrousd stable across re-reads', '- reader range self-check: 1 exact range', '- MODEL_NOT_RUN: set ELIOT_K2_MODEL=1 (root signal) for C1-4/O1-8 paid turns.', '- Stop/reconnect/Save: NOT_RUN here (root browser journey).', ''].join(EOL);
  await writeFile(outDir + '/k2-native-' + Date.now() + '.md', md);
  console.log(md);
  process.exit(0);
}
const rows = [];
const firstMs = [], totalMs = [];
let newCostMicro = 0, reportedMicro = 0, failed = 0, manual = 0, newCount = 0;
const completedQuestions = new Set();
const used = new Set();
for (const qid of order) {
  let turn = null, src = 'new', wall = null;
  if (resumeChat) {
    const cand = reusableCandidate(qid, h0.turns, used);
    if (cand) { turn = cand; src = 'reused'; used.add(cand.turnId); }
    else if (h0.turns.some((t) => t && t.question === Q.get(qid) && t.state !== 'completed')) { rows.push('| ' + qid + ' | PENDING_MANUAL | - | - | - | - | - | - | - |'); manual++; continue; }
  }
  if (!turn) {
    const turnId = randomUUID();
    const t0 = Date.now();
    const r = await apiJson(chatPath + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000), body: JSON.stringify({ turnId, question: Q.get(qid), scopeMode: 'explicit', sourceIds }) });
    wall = Date.now() - t0;
    assert(r.status === 200 || r.status === 201, 'POST turns?wait=1 must be 200/201 for ' + qid + '.');
    assert(r.body && typeof r.body.turn === 'object', 'POST turns?wait=1 must return {turn} for ' + qid + '.');
    turn = r.body.turn;
    assert.equal(turn.turnId, turnId, qid + ': turn.turnId must echo the request turnId.');
    newCount++;
  } else {
    assert(typeof turn.turnId === 'string' && turn.turnId.length > 0, qid + ': reused turn.turnId required.');
  }
  assert(typeof turn.answer === 'string', qid + ': turn.answer must be a string.');
  if (turn.state !== 'completed') { await saveTurn(qid, turn, { src, wall, question: Q.get(qid) }); failed++; rows.push('| ' + qid + ' | ' + turn.state + ' | - | - | - | - | - | - | ' + (wall ===null ? '-' : wall) + ' |'); break; }
  assert(Array.isArray(turn.citations) && turn.citations.length >= 1, qid + ': completed answer needs >=1 citation.');
  assert(typeof turn.invalidLabels === 'number' && turn.invalidLabels === 0, qid + ': invalidLabels must be 0.');
  for (const c of turn.citations) {
    assert(c && typeof c.revisionId === 'string', qid + ': citation needs full revisionId.');
    assert(typeof c.sourceId === 'string', qid + ': citation needs sourceId.');
    assert(typeof c.block === 'number', qid + ': citation needs numeric block.');
    assert(typeof c.start === 'number' && typeof c.end === 'number', qid + ': citation needs numeric start/end.');
    await checkRange(c.revisionId, c.start, c.end);
  }
  await saveTurn(qid, turn, { src, wall, reused: src === 'reused', question: Q.get(qid) });
  checkAnswer(qid, turn.answer);
  completedQuestions.add(qid);
  for (const k of ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs']) assert(typeof turn[k] === 'number', qid + ': turn.' + k + ' must be a number.');
  assert(turn.totalMs <= 90000, qid + ': catastrophic ceiling 90s exceeded.');
  reportedMicro += turn.estimatedCostMicrousd;
  if (src === 'new') newCostMicro += turn.estimatedCostMicrousd;
  firstMs.push(turn.firstTokenMs); totalMs.push(turn.totalMs);
  rows.push('| ' + qid + ' | completed(' + src + ') | ' + turn.citations.length + ' | 0 | ' + turn.inputTokens + '/' + turn.cachedTokens + '/' + turn.outputTokens + ' | ' + turn.estimatedCostMicrousd + ' | ' + turn.firstTokenMs + ' | ' + turn.totalMs + ' | ' + (wall === null ? 'reused' : wall) + ' |');
}
const h1 = await getChat('after turns');
const h2 = await getChat('final re-read');
const usdNew = newCostMicro / 1e6;
const md = ['# K2 Ask eval', '', '- project: ' + title + ' (10 arxiv explicit scope)', '- chat: ' + chatId + (resumeChat ? ' (resumed, no paid retry)' : ''), '- mode: whole, one call/turn, no paid retry', '- reported cost all turns: ' + reportedMicro + ' micro-USD; new-turn delta: ' + newCostMicro + ' micro-USD ($' + usdNew.toFixed(4) + ', budget default $5, never overridden)', '- monthly: ' + h1.monthlyUsedMicrousd + '/' + h1.monthlyBudgetMicrousd + ' micro-USD', '- cold first/total: ' + firstMs[0] + '/' + totalMs[0] + ' ms', '- warm first p50/p95: ' + pct(firstMs.slice(1), 0.5) + '/' + pct(firstMs.slice(1), 0.95) + ' ms', '- warm total p50/p95: ' + pct(totalMs.slice(1), 0.5) + '/' + pct(totalMs.slice(1), 0.95) + ' ms', '- O1/O2/O3/O8 quality vs eval/arxiv-10/baseline.md: OWNER_JUDGMENT_REQUIRED (script never auto-passes human gates)', '- Stop/reconnect/Save: NOT_RUN here (root browser journey).', '', '| q | state | cites | invalid | in/cached/out | cost_uUSD | first_ms | total_ms | wall_ms |', '|---|---|---|---|---|---|---|---|---|'].concat(rows).concat(['']).join(EOL);
await writeFile(outDir + '/k2-' + Date.now() + '.md', md);
console.log(md);
assert.equal(failed, 0, failed + ' paid turn(s) did not complete; no retry by design. Operator must create any manual new turn separately.');
assert.equal(manual, 0, manual + ' question(s) PENDING_MANUAL: a same-question turn already failed; no auto re-request. Operator must create any manual new turn separately.');
assert(order.every((q) => completedQuestions.has(q)), 'All 12 questions must complete.');
assert.equal(h1.turns.length, h0.turns.length + newCount, 'History must hold exactly the pre-existing plus new turns.');
assert.equal(h1.monthlyUsedMicrousd - m0, newCostMicro, 'Monthly usage delta must equal new-turn cost only (reused turns cost nothing new).');
assert(h1.monthlyUsedMicrousd < h1.monthlyBudgetMicrousd, 'Monthly budget exceeded: ' + h1.monthlyUsedMicrousd + ' >= ' + h1.monthlyBudgetMicrousd);
assert.equal(h2.monthlyUsedMicrousd, h1.monthlyUsedMicrousd, 'Pure history re-read must not change usage.');
