import { unsupportedNumbers, parseSingleNumber } from "../../src/numbers.ts";
// K3 Distill eval harness (docs/MAP.md K3; docs/IMPLEMENTATION.md 6, 8, 10, 11).
// Interface assumptions (backend contract under test):
//   GET  /api/sources/:sourceId/understanding?revisionId=<rev>
//     200 direct Understanding {sourceId,revisionId,state,error,guide,digest,glossary,claims,report} | 404 K3_NOT_WIRED
//   POST /api/sources/:sourceId/understanding {revisionId}
//     always 202 idempotent {revisionId}; done/partial/running no-op, paused visible on later GET, failed 409
//   GET  /api/projects/:projectId/overview -> 200 {sources:[...]} assembled storage-only
//   GET  /api/revisions/:rev/range?start=&end= -> exact canonical bytes (semantic quote check)
// Default: validate stored hard gates, fail on missing work, zero model calls.
// --native-only is explicitly limited. Paid distillation requires ELIOT_K3_MODEL=1.
import assert from 'node:assert/strict';
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
const FLASH_MODEL = 'workers-ai:@cf/zai-org/glm-5.3-flash';
const origin = new URL(process.env.ELIOT_URL || 'http://127.0.0.1:5173').origin;
const H = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
const nativeOnly = process.argv.includes('--native-only');
const runModel = process.env.ELIOT_K3_MODEL === '1';
const outDir = fileURLToPath(new URL('../../eval/out/k3/', import.meta.url));
await mkdir(outDir, { recursive: true });
const evalDir = fileURLToPath(new URL('../../eval/', import.meta.url));
const CLAIM_ORDER = ['C1', 'C2', 'C3', 'C4'];
const CLAIM_Q = new Map();
for (const line of (await readFile(evalDir + '/arxiv-10/questions.md', 'utf8')).split(EOL)) {
  const parts = line.split('|').map((p) => p.trim());
  if (parts.length >= 3 && CLAIM_ORDER.includes(parts[1]) && parts[2]) CLAIM_Q.set(parts[1], parts[2]);
}
assert.equal(CLAIM_Q.size, 4, 'questions.md must define C1-C4.');
const CLAIM_QUESTIONS = CLAIM_ORDER.map((k) => CLAIM_Q.get(k));
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
function checkClaimAnswer(qid, ans) {
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
    assert(strictFormula || sqrtFormula, 'C2 must contain the schedule formula with warmup 4000, or its sqrt equivalent.');
  }
  if (qid === 'C3') assert(has('0.001') && has('0.9') && has('0.999') && (has('1e-8') || m.includes('10 -8') || m.includes('10 - 8') || m.includes('10-8') || has('0.00000001')), 'C3 must contain Adam defaults with the numeric epsilon 1e-8 (the word alone does not pass).');
  if (qid === 'C4') assert((m.includes('синус') || m.includes('sinus')) && (m.includes('обуч') || m.includes('learn')), 'C4: sinusoidal vs learned.');
}
async function assertClaimTurnReadOnly(t, tag, revIdSet, revKey) {
  assert.equal(t.contextMode, 'claims', 'TurnView.contextMode must be claims (' + tag + ').');
  assert.equal(t.model, FLASH_MODEL, 'Turn model must stay Flash (' + tag + ').');
  assert.equal(t.scopeMode, 'explicit', 'Claim turn must use the explicit all-large scope (' + tag + ').');
  assert(Array.isArray(t.revisionIds) && t.revisionIds.slice().sort().join(',') === revKey, 'Claim turn must span the full large scope (' + tag + ').');
  assert(typeof t.answer === 'string' && t.answer.trim().length > 0, 'Claim turn needs a non-empty answer (' + tag + ').');
  assert(Array.isArray(t.citations) && t.citations.length > 0, 'Claim turn needs at least one citation (' + tag + ').');
  assert.equal(t.invalidLabels, 0, 'Claim turn must resolve every label (' + tag + ').');
  assert.equal(t.state, 'completed', 'Claim turn must be completed, not partial (' + tag + ' state=' + t.state + ').');
  const texts = [];
  for (const c of t.citations) {
    assert(c && typeof c.revisionId === 'string' && typeof c.block === 'number' && Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end) && c.end > c.start, 'Claim citation needs revision/block/exact byte range (' + tag + ').');
    assert(revIdSet.has(c.revisionId), 'Claim citation revision must belong to the frozen large scope (' + tag + ').');
    const r = await apiBytes('/api/revisions/' + encodeURIComponent(c.revisionId) + '/range?start=' + c.start + '&end=' + c.end);
    assert.equal(r.status, 200, 'Each claim citation range must open (GET range 200) (' + tag + ').');
    assert.equal(r.bytes.length, c.end - c.start, 'Each claim citation range must return exact bytes (' + tag + ').');
    if (typeof c.quote === 'string' && c.quote.length > 0) assert.equal(r.bytes.toString('utf8'), c.quote, 'Each claim citation quote must equal the range bytes exactly (' + tag + ').');
    texts.push(r.bytes.toString('utf8'));
  }
  const deLabeled = t.answer.replace(/\[(?:S\d+:\d+|R[0-9a-fA-F-]{36}:\d+)\]/g, '');
  assert.deepEqual(numericsUnsupported(texts.join('\n'), deLabeled, undefined), [], 'Every stated number must occur whole in cited ranges (' + tag + ').');
  checkClaimAnswer(tag, t.answer);
}
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function runsOf(s) { return String(s).match(/[0-9]+/g) || []; }
function scalarNumberOk(text, num) {
  return typeof text === 'string' && typeof num === 'number' && Number.isFinite(num) && parseSingleNumber(text) === num;
}
function numericsUnsupported(quote, valueText, valueNumber, ...texts) {
  const bad = [];
  const check = (text) => {
    if (typeof text === 'string') bad.push(...unsupportedNumbers(text, quote));
  };
  check(valueText);
  for (const text of texts) check(text);
  if (valueNumber !== null && valueNumber !== undefined && !scalarNumberOk(valueText, valueNumber)) {
    const groups = runsOf(String(valueNumber));
    bad.push(...(groups.length ? groups : ['value-number']));
  }
  return [...new Set(bad)];
}
assert.deepEqual(numericsUnsupported('Speedup 10,000x on 8 GPUs.', '10,000', 10000, '8 GPUs'), [], 'Harness selftest: unambiguous thousands must parse, verified text stays strict.');
assert.deepEqual(numericsUnsupported('quoted 10,000 dollars', '10,000 dollars', 10000), ['10000'], 'Harness selftest: compound valueText with a number must fail.');
assert.deepEqual(numericsUnsupported('eps 1e-8 floor', '1e-8', 1e-8), [], 'Harness selftest: scientific scalar must parse exactly.');
assert.deepEqual(numericsUnsupported('rate 95.2% agreed', '95.2%', 95.2), [], 'Harness selftest: literal percent unit is source-as-written, no conversion.');
assert.deepEqual(numericsUnsupported('rate 95.2% agreed', '95.2%', 0.952), ['0', '952'], 'Harness selftest: percent must not convert (95.2% is 95.2, never 0.952).');
assert.deepEqual(numericsUnsupported('quote 95.2% only', '95.3%', 95.3), ['3'], 'Harness selftest: unsupported 95.3% against a 95.2% quote stays bad.');
assert.deepEqual(numericsUnsupported('block37 records 41.0 BLEU with 8 P100 GPUs.', '41.8', 41.8), ['41.8'], 'Harness selftest: split decimal runs (41.0 + separate 8) must not validate 41.8.');
assert.deepEqual(numericsUnsupported('block37 records 41.0 BLEU with 8 P100 GPUs.', '41,8'), ['41.8'], 'Harness selftest: RU comma 41,8 is not supported by 41.0 plus a lone 8.');
assert.deepEqual(numericsUnsupported('score 41.8 here', '41,8'), [], 'Harness selftest: RU comma 41,8 matches dotted source 41.8.');
assert.deepEqual(numericsUnsupported('energy 41.8e2 joules', '41.8', 41.8), ['41.8'], 'Harness selftest: full tokens, 41.8 is not supported by 41.8e2.');
function snapOf(t) {
  if (!t || (t.state !== 'done' && t.state !== 'partial')) return null;
  const rep = t.report && typeof t.report === 'object' ? t.report : null;
  const usage = (rep && rep.usage) || {};
  if (typeof usage.calls !== 'number' || typeof usage.estimatedCostMicrousd !== 'number') return null;
  if (!Array.isArray(t.claims)) return null;
  return { calls: usage.calls, cost: usage.estimatedCostMicrousd, claims: t.claims.map((c) => c && c.id) };
}
async function assertStoredQuote(rev, c, tag) {
  await checkRange(rev, c.start, c.end);
  const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + c.start + '&end=' + c.end);
  assert.equal(r.status, 200, 'Each claim quote must open (GET range 200) ' + tag + '.');
  assert.equal(r.bytes.toString('utf8'), c.quote, 'Each claim quote must equal the range bytes exactly ' + tag + '.');
}
function anchorHay(byFile) {
  // Keep statement and this same card's quote separate; never pool fields or cards.
  const normalize = (value) => (typeof value === 'string' ? value : '').toLowerCase().replace(/-\s*\n\s*/g, '').replace(/\s+/g, ' ');
  return (file) => (byFile.get(file) || []).map((c) => ({
    statement: normalize(c && c.statement),
    quote: normalize(c && c.quote),
  }));
}
function checkAnchors(byFile) {
  const missing = [];
  // Every independent anchor must be stated by one owner-visible card and supported by that card's own exact quote.
  const cards = anchorHay(byFile);
  const q01 = cards('arxiv-01.pdf'), q03 = cards('arxiv-03.pdf'), q07 = cards('arxiv-07.pdf');
  const wmt = (q) => /wmt\s*(?:2014|14)/.test(q);
  const french = (q) => /english.{0,25}french|en[-– ]fr/.test(q);
  const paired = (items, predicate) => items.some((card) => predicate(card.statement) && predicate(card.quote));
  if (!paired(q01, (q) => q.includes('28.4') && q.includes('bleu') && wmt(q) && /english.{0,25}german|en[-– ]de/.test(q))) missing.push('A1-English-German-28.4-BLEU');
  if (!paired(q01, (q) => q.includes('41.8') && q.includes('bleu') && wmt(q) && french(q))) missing.push('A1-English-French-41.8-BLEU');
  if (!paired(q01, (q) => q.includes('41.8') && french(q) && /3\.5\s*days?/.test(q) && /(?:\b8\b|\beight\b).{0,30}gpus?/.test(q))) missing.push('A1-compute(3.5d/8GPU-for-French-result)');
  if (!paired(q03, (q) => q.includes('residual') && q.includes('function') && /reformulat|learn|mapping/.test(q))) missing.push('A2-residual-functions');
  if (!paired(q03, (q) => runsOf(q).includes('152') && /layer/.test(q))) missing.push('A2-152-layers');
  if (!paired(q03, (q) => q.includes('3.57') && q.includes('ensemble') && q.includes('imagenet') && q.includes('test') && q.includes('error'))) missing.push('A2-ensemble-3.57%-ImageNet-test-error');
  if (!paired(q07, (q) => /freez|froz/.test(q) && /weight/.test(q) && /low.{0,8}rank/.test(q) && /train/.test(q))) missing.push('A3-frozen-weights-trained-lowrank');
  const gpt = (q) => /gpt[- ]?3/.test(q) && /175\s*b/.test(q);
  if (!paired(q07, (q) => gpt(q) && /10[, ]*000/.test(q) && q.includes('trainable') && q.includes('parameter'))) missing.push('A3-GPT3-175B-10000x-trainable-params');
  if (!paired(q07, (q) => gpt(q) && /(?:\b3\b|\bthree\b).{0,20}(?:times|[x×]|fold)/.test(q) && q.includes('gpu') && q.includes('memory'))) missing.push('A3-GPT3-175B-3x-GPU-memory');
  if (!paired(q07, (q) => /(?:\bno\b|without|does not|do not).{0,80}latency/.test(q) && q.includes('inference'))) missing.push('A3-no-additional-inference-latency');
  return missing;
}
const BUDGET_DEFAULT = 5000000;
const TERMINAL = new Set(['done', 'partial', 'failed']);
const POLL_MS = 5000;
const REV_TIMEOUT_MS = 600000;
const DISTILL_STATES = ['none', 'queued', 'running', 'paused', 'done', 'partial', 'failed'];
function assertUnderstanding(u, what) {
  assert(u && typeof u === 'object', 'GET understanding must return the direct Understanding object (' + what + ').');
  assert(typeof u.sourceId === 'string' && typeof u.revisionId === 'string', 'Understanding must carry sourceId/revisionId (' + what + ').');
  assert(DISTILL_STATES.includes(u.state), 'Understanding.state must be a direct distill state (' + what + ').');
  assert(u.error === null || typeof u.error === 'string', 'Understanding.error must be null|string (' + what + ').');
  assert(u.guide === null || typeof u.guide === 'string', 'Understanding.guide must be null|string (' + what + ').');
  assert(u.digest === null || typeof u.digest === 'string', 'Understanding.digest must be null|string (' + what + ').');
  assert(Array.isArray(u.glossary), 'Understanding.glossary must be an array (' + what + ').');
  assert(Array.isArray(u.claims), 'Understanding.claims must be an array (' + what + ').');
  assert(u.report === null || typeof u.report === 'object', 'Understanding.report must be null|object (' + what + ').');
}
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
async function monthlyUsage() {
  const s = await apiJson('/api/settings');
  assert.equal(s.status, 200, 'GET /api/settings must be 200.');
  assert(typeof s.body.monthlyUsedMicrousd === 'number', 'GET /api/settings must return monthlyUsedMicrousd.');
  assert(typeof s.body.monthlyBudgetMicrousd === 'number', 'GET /api/settings must return monthlyBudgetMicrousd.');
  return { used: s.body.monthlyUsedMicrousd, budget: s.body.monthlyBudgetMicrousd };
}
const m0 = await monthlyUsage();
assert(m0.budget >= 0 && m0.budget <= BUDGET_DEFAULT, 'The test allowance must not exceed the documented $5 budget; this script never raises it.');
const modelList = await apiJson('/api/models');
assert.equal(modelList.status, 200, 'Read current dated prices before reporting the acceptance bound.');
const price = (modelList.body.models || []).find((model) => model.route === FLASH_MODEL);
assert(price && price.enabled, 'Flash metadata is required; no model substitution is allowed.');
const callBound = Math.ceil((price.contextTokens * price.inputMicrousdPerMillion + price.maxOutputTokens * price.outputMicrousdPerMillion) / 1000000);
const fullFreshBound = 28 * callBound;
const boundReport = 'Fresh full K3 bound: baseline 10*2 + overflow 2*2 + answers 4*1 = 28 calls, ' + fullFreshBound + ' micro-USD plus PDF conversion (not included); remaining allowance ' + (m0.budget - m0.used) + '. Full bound fits: ' + (fullFreshBound <= m0.budget - m0.used) + '. Historical calls are not reset or silently counted as fresh.';
console.log(boundReport);
const whole = new Map();
async function checkRange(rev, st, en) {
  let w = whole.get(rev);
  if (!w) {
    const t = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text');
    assert.equal(t.status, 200, 'GET revision text 200 for ' + rev.slice(0, 8) + '.');
    w = t.bytes; whole.set(rev, w);
  }
  const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + st + '&end=' + en);
  assert.equal(r.status, 200, 'Each cited range must open (GET range 200).');
  assert(r.bytes.equals(w.subarray(st, en)), 'Cited range must equal the whole-text slice.');
}
const probeRev = scoped[0] ?? (nativeOnly ? sources.find((s) => s.currentRevisionId && ['readable', 'readable_with_warnings'].includes(s.readableState)) : undefined);
assert(probeRev, 'A readable K1 source is required for route probes.');
const u0 = await apiJson('/api/sources/' + encodeURIComponent(probeRev.id) + '/understanding?revisionId=' + encodeURIComponent(probeRev.currentRevisionId));
const o0 = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/overview');
const understandingWired = u0.status !== 404;
const overviewWired = o0.status !== 404;
if (understandingWired) assertUnderstanding(u0.body, 'probe');
if (overviewWired) assert(o0.body && Array.isArray(o0.body.sources), 'GET overview must return the direct Overview object with sources array.');
async function setAutoDistill(on) {
  const cur = await apiJson('/api/settings');
  const s = cur.body.settings || {};
  const r = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: s.answerModel, monthlyModelBudgetMicrousd: s.monthlyModelBudgetMicrousd, autoDistill: on }) });
  assert.equal(r.status, 200, 'PUT /api/settings autoDistill fixture must be 200.');
  return s.autoDistill === true || s.autoDistill === 1;
}
if (nativeOnly) {
  assert(understandingWired && overviewWired, 'K3 native smoke requires the actual understanding and overview routes.');
  const wasAuto = await setAutoDistill(false);
  try {
  const m1 = await monthlyUsage();
  assert.equal(m1.used, m0.used, 'Native-only probes must not change monthly usage.');
    const recLines = [];
    const recSource = process.env.ELIOT_K3_RECOVER_SOURCE;
    const recRevEnv = process.env.ELIOT_K3_RECOVER_REVISION;
    if (recSource) {
      let recProjId = null;
      const pl = await apiJson('/api/projects');
      assert.equal(pl.status, 200, 'GET /api/projects must be 200.');
      for (const p of pl.body.projects || []) {
        const sl = await apiJson('/api/projects/' + encodeURIComponent(p.id) + '/sources');
        assert.equal(sl.status, 200, 'GET project sources must be 200.');
        if ((sl.body.sources || []).some((x) => x && x.id === recSource)) { recProjId = p.id; break; }
      }
      assert(recProjId, 'K3 recovery NOT_RUN: recovery source project not found.');
      const rov = await apiJson('/api/projects/' + encodeURIComponent(recProjId) + '/overview');
      assert.equal(rov.status, 200, 'GET overview must be 200.');
      const busy = (rov.body.sources || []).filter((x) => x && (x.state === 'running' || x.state === 'queued'));
      assert.equal(busy.length, 0, 'K3 recovery blocked: distillation jobs active: ' + busy.map((x) => x.sourceId).join(','));
      let u0 = null, rev = recRevEnv || null;
      if (rev) u0 = await getUnderstanding(recSource, rev);
      else {
        const probe = await apiJson('/api/sources/' + encodeURIComponent(recSource) + '/understanding');
        assert.equal(probe.status, 200, 'GET recovery understanding (current revision) must be 200.');
        assertUnderstanding(probe.body, 'recovery current');
        u0 = probe.body;
        rev = u0.revisionId;
      }
      assert(u0.state === 'failed' || u0.state === 'done' || u0.state === 'partial', 'Recovery fixture must be terminal (failed/done/partial), got ' + u0.state + ' (no model distill here).');
      assert(u0.report && typeof u0.report === 'object', 'Terminal fixture must carry its terminal report (raw compat).');
      assert(u0.report.usage && typeof u0.report.usage.calls === 'number' && typeof u0.report.usage.estimatedCostMicrousd === 'number', 'Terminal fixture must carry its usage (raw compat).');
      assert(u0.report.raw && typeof u0.report.raw === 'object', 'Terminal fixture must carry current raw excerpts (raw compat).');
      const recStartState = u0.state;
      const alreadyChecked = !!(u0.report.artifacts && u0.report.artifacts.guide === 'source/' + rev + '/checked/guide.md');
      if (!alreadyChecked) assert(u0.canRecover === true, 'Terminal fixture must expose canRecover before save (stored output only).');
      const usageBefore = u0.report.usage;
      const textBefore = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text');
      assert.equal(textBefore.status, 200, 'GET revision text must be 200.');
      const origBefore = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/original');
      assert.equal(origBefore.status, 200, 'GET revision original must be 200.');
      const cur = await apiJson('/api/settings');
      assert.equal(cur.status, 200, 'GET /api/settings must be 200.');
      const s0 = cur.body.settings || {};
      const wasBudget = cur.body.monthlyBudgetMicrousd;
      const mu = await monthlyUsage();
      const zb = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: s0.answerModel, monthlyModelBudgetMicrousd: mu.used, autoDistill: !!s0.autoDistill }) });
      assert.equal(zb.status, 200, 'PUT zero-headroom budget must be 200.');
      try {
        const p = await apiJson('/api/sources/' + encodeURIComponent(recSource) + '/understanding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: rev, saveAvailable: true }) });
        if (p.status === 409) throw new Error('K3 recovery incompatible (409): ' + JSON.stringify(p.body && p.body.error) + ' - stopped, no retry.');
        assert.equal(p.status, 202, 'POST saveAvailable must be 202.');
        assert(p.body && p.body.revisionId === rev, 'POST saveAvailable must echo {revisionId}.');
        const u1 = await getUnderstanding(recSource, rev);
        assert(u1.state === 'done' || u1.state === 'partial', 'Recovered revision must be done/partial, got ' + u1.state + '.');
        assert(u1.report && u1.report.artifacts && u1.report.artifacts.guide === 'source/' + rev + '/checked/guide.md' && u1.report.artifacts.digest === 'source/' + rev + '/checked/digest.md' && u1.report.artifacts.glossary === 'source/' + rev + '/checked/glossary.json', 'Recovered report must carry checked artifacts (checked/guide.md, checked/digest.md, checked/glossary.json).');
        assert(u1.canRecover === false, 'Recovered checked head must clear canRecover.');
        assert(typeof u1.guide === 'string' && u1.guide.length > 0, 'Recovered guide must be readable.');
        assert(Array.isArray(u1.claims) && u1.claims.length > 0, 'Recovered revision must carry saved claims.');
        for (const c of u1.claims) {
          assert(c && typeof c.quote === 'string' && c.quote.length > 0, 'Recovered claim needs a non-empty quote.');
          await assertStoredQuote(rev, c, '(recovered)');
          const bad = numericsUnsupported(c.quote, c.valueText, c.valueNumber, c.statement, c.conditions);
          assert.deepEqual(bad, [], 'Recovered numeric must be quote-supported: ' + bad.join(','));
        }
        assert(u1.report && typeof u1.report === 'object', 'Recovered revision must carry its report.');
        assert.deepEqual(u1.report.usage, usageBefore, 'Recovered report.usage must equal pre-save usage (no new model work).');
        const textAfter = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text');
        assert(textBefore.bytes.equals(textAfter.bytes), 'Primary text bytes must be unchanged by save.');
        const origAfter = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/original');
        assert(origBefore.bytes.equals(origAfter.bytes), 'Original bytes must be unchanged by save.');
        const p2 = await apiJson('/api/sources/' + encodeURIComponent(recSource) + '/understanding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: rev, saveAvailable: true }) });
        assert.equal(p2.status, 202, 'Repeat POST must stay 202 (idempotent).');
        const u2 = await getUnderstanding(recSource, rev);
        assert.deepEqual((u2.claims || []).map((c) => c && c.id), (u1.claims || []).map((c) => c && c.id), 'Repeat save must keep identical claim IDs.');
        assert.deepEqual(u2.report && u2.report.usage, usageBefore, 'Repeat save must keep identical report usage.');
        const m2 = await monthlyUsage();
        assert.equal(m2.used, mu.used, 'Monthly usage must not move during storage-only recovery.');
        recLines.push('- recovery source: ' + recSource + ' rev ' + String(rev).slice(0, 8) + ' (' + recStartState + ' -> ' + u1.state + ', terminal cached recheck)');
        recLines.push('- recovery usage unchanged: ' + JSON.stringify(usageBefore) + '; claims: ' + u1.claims.length);
        recLines.push('- recovery checked artifacts: report.artifacts at checked/guide.md, checked/digest.md, checked/glossary.json; canRecover false after save');
        recLines.push('- recovery text/original bytes identical, repeat POST idempotent, monthly delta 0, allowance+auto restored');
      } finally {
        const rb = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: (await apiJson('/api/settings')).body.settings.answerModel, monthlyModelBudgetMicrousd: wasBudget, autoDistill: !!s0.autoDistill }) });
        assert.equal(rb.status, 200, 'PUT budget restore must be 200.');
      }
    }
    const checkLines = [];
    const checkSource = process.env.ELIOT_K3_CHECK_SOURCE;
    if (checkSource) {
      const cprobe = await apiJson('/api/sources/' + encodeURIComponent(checkSource) + '/understanding');
      assert.equal(cprobe.status, 200, 'GET check understanding (current revision) must be 200.');
      assertUnderstanding(cprobe.body, 'check current');
      const cu = cprobe.body;
      const crev = cu.revisionId;
      assert(cu.state === 'done' || cu.state === 'partial', 'Check source must be terminal (done/partial), got ' + cu.state + ' (read-only, no POST).');
      const crep = cu.report;
      assert(crep && typeof crep === 'object', 'Check report must be present.');
      const cusage = crep.usage || {};
      for (const kk of ['calls', 'inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'wallMs']) assert(typeof cusage[kk] === 'number', 'Check report.usage.' + kk + ' must be numeric.');
      assert(cusage.calls <= 2, 'Check calls bounded at most 2, got ' + cusage.calls + '.');
      const cclaims = Array.isArray(cu.claims) ? cu.claims : [];
      assert(cclaims.length <= 32, 'Check claims capped at 32.');
      assert(typeof crep.kept === 'number' && crep.kept === cclaims.length, 'Check report.kept must equal served claim count.');
      assert(typeof cu.guide === 'string' && cu.guide.length > 0, 'Check guide must be readable.');
      const cDeLabeled = cu.guide.replace(/\[(?:S\d+:\d+|R[0-9a-fA-F-]{36}:\d+)\]/g, ' ');
      const cseg = [...new Intl.Segmenter(['en', 'ru'], { granularity: 'sentence' }).segment(cDeLabeled)].map((s) => s.segment.trim()).filter((s) => s.length > 0);
      assert(cseg.length >= 3 && cseg.length <= 5, 'Check guide must be 3-5 sentences, got ' + cseg.length + '.');
      for (const cc of cclaims) {
        await assertStoredQuote(crev, cc, '(check)');
        assert.deepEqual(numericsUnsupported(cc.quote, cc.valueText, cc.valueNumber, cc.statement, cc.conditions), [], 'Check numeric must be quote-supported.');
      }
      const cmap = new Map((Array.isArray(cu.citations) ? cu.citations : []).map((b) => [b.block, b]));
      const cblocks = new Set();
      const checkLabels = (text, tag) => {
        if (typeof text !== 'string' || !text) return;
        assert(!/\[S\d+:\d+\]/.test(text), 'Check ' + tag + ' must not carry compact labels (stored labels use full revision UUID).');
        for (const tok of text.match(/R[0-9a-fA-F-]{36}:\d+/g) || []) {
          const mm = tok.match(/^R([0-9a-fA-F-]{36}):(\d+)$/);
          assert(mm, 'Check label shape (' + tag + ').');
          assert.equal(mm[1], crev, 'Check label must reference own revision (' + tag + ').');
          const bn = Number(mm[2]);
          assert(cmap.has(bn), 'Check label block must exist in own block map (' + tag + ' block ' + bn + ').');
          cblocks.add(bn);
        }
      };
      checkLabels(cu.guide, 'guide');
      checkLabels(cu.digest, 'digest');
      for (const g of (Array.isArray(cu.glossary) ? cu.glossary : [])) for (const lab of (g && Array.isArray(g.labels) ? g.labels : [])) checkLabels(lab, 'glossary');
      for (const bn of cblocks) {
        const b = cmap.get(bn);
        const rr = await apiBytes('/api/revisions/' + encodeURIComponent(crev) + '/range?start=' + b.start + '&end=' + b.end);
        assert.equal(rr.status, 200, 'Check label range must open (block ' + bn + ').');
        assert.equal(rr.bytes.length, b.end - b.start, 'Check label range must return exact bytes (block ' + bn + ').');
      }
      const cprobe2 = await apiJson('/api/sources/' + encodeURIComponent(checkSource) + '/understanding');
      assert.equal(cprobe2.status, 200, 'GET check re-read must be 200 (deterministic head).');
      assertUnderstanding(cprobe2.body, 'check re-read');
      assert.deepEqual((Array.isArray(cprobe2.body.claims) ? cprobe2.body.claims : []).map((c) => c && c.id), cclaims.map((c) => c && c.id), 'Check normal head must return stable claim IDs across GETs.');
      checkLines.push('- check source: ' + checkSource + ' rev ' + String(crev).slice(0, 8) + ' (' + cu.state + ', read-only, no POST)');
      checkLines.push('- check guide sentences: ' + cseg.length + '; claims: ' + cclaims.length + ' (kept ' + crep.kept + '); calls: ' + cusage.calls);
      checkLines.push('- check labels resolve own revision ranges (' + cblocks.size + ' blocks probed); quotes byte-exact; numerics quote-supported');
      checkLines.push('- check normal head deterministic: claim IDs identical across two GETs');
      for (const line of checkLines) recLines.push(line);
    }
    const md = ['# K3 native-only (storage, zero model calls)', '', '- project: ' + title, '- readable arxiv: ' + scoped.length + '/10 (no ingestion/conversion repeats)', '- reader range self-check: 1 exact range', '- understanding route: ' + (understandingWired ? (recSource ? 'wired (probes GET + explicit storage-only save POST when requested)' : 'wired (GET only, no POST)') : 'NOT_WIRED (404)'), '- overview route: ' + (overviewWired ? 'wired (GET only)' : 'NOT_WIRED (404)'), '- autoDistill fixture: set false for this run (was ' + wasAuto + '), restored after', '- monthly usage stable: ' + m0.used + ' micro-USD', '- MODEL_NOT_RUN: set ELIOT_K3_MODEL=1 (root signal) for paid distillation; claim-mode C1-C4: NOT_RUN here.', ''].concat(recLines).concat(['']).join(EOL);
  await writeFile(outDir + '/k3-native-' + Date.now() + '.md', md);
  console.log(md);
  } finally { await setAutoDistill(wasAuto); }
  process.exit(0);
}
if (!runModel) {
  const violations = [];
  const sRows = [];
  let sMicro = 0;
  const byFile = new Map();
  if (!understandingWired) violations.push('understanding route NOT_WIRED (404)');
  if (!overviewWired) violations.push('overview route NOT_WIRED (404)');
  for (const s of scoped) {
    const rev = s.currentRevisionId;
    let u = null;
    try {
      u = await getUnderstanding(s.id, rev);
    } catch (e) {
      violations.push(s.originalFilename + ': understanding unreadable');
      sRows.push('| ' + s.originalFilename + ' | unreadable | - | - |');
      continue;
    }
    if (u.state !== 'done' && u.state !== 'partial') {
      violations.push(s.originalFilename + ': state=' + u.state + ' (not terminal-verified; no paid calls made here)');
      const rep0 = u.report && typeof u.report === 'object' ? u.report : null;
      if (rep0 && rep0.usage && typeof rep0.usage.estimatedCostMicrousd === 'number') sMicro += rep0.usage.estimatedCostMicrousd;
      sRows.push('| ' + s.originalFilename + ' | ' + u.state + ' | - | - |');
      continue;
    }
    const claims = Array.isArray(u.claims) ? u.claims : [];
    if (claims.length > 32) violations.push(s.originalFilename + ': claims exceed 32');
    const fileQuotes = [];
    for (const c of claims) {
      if (!c || typeof c.quote !== 'string' || !c.quote) { violations.push(s.originalFilename + ': claim without quote'); continue; }
      if (!(Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end) && c.end > c.start)) { violations.push(s.originalFilename + ': claim without integer byte range'); continue; }
      try {
        await assertStoredQuote(rev, c, '(' + s.originalFilename + ')');
      } catch (e) {
        violations.push(s.originalFilename + ': quote not byte-equal to stored range (' + (e.message || e) + ')');
        continue;
      }
      for (const g of numericsUnsupported(c.quote, c.valueText, c.valueNumber, c.statement, c.conditions)) violations.push(s.originalFilename + ': numeric ' + g + ' unsupported by quote');
      fileQuotes.push({ quote: c.quote, statement: c.statement });
    }
    byFile.set(s.originalFilename, fileQuotes);
    const rep = u.report;
    if (!rep || typeof rep !== 'object') {
      violations.push(s.originalFilename + ': terminal state without direct report');
    } else {
      for (const kk of ['calls', 'inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'wallMs']) if (typeof rep.usage?.[kk] !== 'number') violations.push(s.originalFilename + ': usage not numeric');
      if (typeof rep.kept !== 'number') violations.push(s.originalFilename + ': kept not a number');
      if (!Array.isArray(rep.dropped)) violations.push(s.originalFilename + ': dropped not an array');
      if (typeof rep.clearedNumbers !== 'number') violations.push(s.originalFilename + ': clearedNumbers not a number');
      if (rep.usage && typeof rep.usage.estimatedCostMicrousd === 'number') sMicro += rep.usage.estimatedCostMicrousd;
    }
    await writeFile(outDir + '/k3-stored-' + String(rev).slice(0, 8) + '.json', JSON.stringify({ revisionId: rev, source: s.originalFilename, state: u.state, claims: claims.length, error: u.error || null }, null, 2));
    sRows.push('| ' + s.originalFilename + ' | ' + u.state + ' | ' + claims.length + ' | stored-only |');
  }
  for (const m of checkAnchors(byFile)) violations.push('anchor missing from owner-visible statement + supporting quote: ' + m);
  try {
    const ov1 = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/overview');
    assert.equal(ov1.status, 200, 'GET overview must be 200.');
    assert(ov1.body && Array.isArray(ov1.body.sources), 'GET overview must return direct Overview with sources.');
    const ovIds = new Set(JSON.stringify(ov1.body).match(/[0-9a-f-]{36}/g) || []);
    for (const s of scoped) if (!ovIds.has(s.currentRevisionId)) violations.push('overview missing revision (' + s.originalFilename + ')');
    const ov2 = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/overview');
    if (JSON.stringify(ov2.body) !== JSON.stringify(ov1.body)) violations.push('overview not deterministic');
  } catch (e) {
    violations.push('overview check failed');
  }
  const m1 = await monthlyUsage();
  if (m1.used !== m0.used) violations.push('monthly chat usage moved without paid calls');
  assert.equal(m1.budget, m0.budget, 'Monthly budget must not move during a read-only stored run.');
  {
    const ct = process.env.ELIOT_K3_CLAIM_PROJECT;
    const cl = process.env.ELIOT_K3_CLAIM_CHAT;
    if (!ct || !cl) violations.push('claim-mode C1-C4 NOT_RUN: no verified claim-mode turns (separate root step)');
    else {
      try {
        let cproj = null, ccur = undefined;
        for (let i = 0; i < 5 && !cproj; i++) {
          const pg = await apiJson('/api/projects' + (ccur ? '?cursor=' + encodeURIComponent(ccur) : ''));
          assert.equal(pg.status, 200, 'GET /api/projects must be 200.');
          cproj = (pg.body.projects || []).find((x) => x && x.title === ct) || null;
          ccur = pg.body.nextCursor || undefined;
          if (!ccur) break;
        }
        assert(cproj, 'K3 claim-mode NOT_RUN: claim project not found: ' + ct);
        assert.notEqual(cproj.id, proj.id, 'Claim project must be separate from the baseline corpus project.');
        let csrc = [], scc = undefined;
        for (let i = 0; i < 10; i++) {
          const s = await apiJson('/api/projects/' + encodeURIComponent(cproj.id) + '/sources' + (scc ? '?cursor=' + encodeURIComponent(scc) : ''));
          assert.equal(s.status, 200, 'GET claim sources must be 200.');
          csrc = csrc.concat(s.body.sources || []);
          scc = s.body.nextCursor || undefined;
          if (!scc) break;
        }
        const cset = new Set(csrc.filter((s) => s.currentRevisionId).map((s) => s.currentRevisionId));
        const ckey = [...cset].sort().join(',');
        const cl0 = await apiJson('/api/projects/' + encodeURIComponent(cproj.id) + '/chats');
        assert.equal(cl0.status, 200, 'GET claim chats must be 200.');
        const cchat = (cl0.body.chats || []).find((x) => x && (x.id === cl || x.title === cl)) || null;
        assert(cchat, 'K3 claim-mode NOT_RUN: claim chat not found (read-only stored run creates nothing): ' + cl);
        const cr = await apiJson('/api/projects/' + encodeURIComponent(cproj.id) + '/chats/' + encodeURIComponent(cchat.id));
        assert.equal(cr.status, 200, 'GET claim chat snapshot must be 200.');
        const cturns = Array.isArray(cr.body.turns) ? cr.body.turns : [];
        for (let qi = 0; qi < CLAIM_ORDER.length; qi++) {
          const tag = CLAIM_ORDER[qi];
          const t = cturns.find((x) => x && x.question === CLAIM_QUESTIONS[qi] && x.state === 'completed' && x.scopeMode === 'explicit' && Array.isArray(x.revisionIds) && x.revisionIds.slice().sort().join(',') === ckey) || null;
          assert(t, 'K3 claim-mode ' + tag + ' NOT_RUN: no completed exact-scope stored turn (read-only, no POST).');
          await assertClaimTurnReadOnly(t, tag, cset, ckey);
        }
      } catch (e) {
        violations.push('claim-mode stored: ' + String((e && e.message) || e).split('\n')[0]);
      }
    }
  }
  const md = ['# K3 stored hard-gate validation (zero paid calls)', '', '- project: ' + title, '- stored distill total micro-USD: ' + sMicro, '- test allowance (monthly budget): ' + m0.budget + ' micro-USD (cap 5000000, never raised by this script)', '- monthly chat usage delta: ' + (m1.used - m0.used), '- violations: ' + violations.length, '', '| source | state | claims | mode |', '|---|---|---|---|'].concat(sRows).concat(['', '## Violations / open gates', '']).concat(violations.map((v) => '- ' + v)).concat(['']).join(EOL);
  await writeFile(outDir + '/k3-stored-' + Date.now() + '.md', md);
  console.log(md);
  assert.equal(violations.length, 0, 'K3 MAP hard gates OPEN: ' + violations.length);
  process.exit(0);
}
assert(understandingWired, 'PREP_K3_NOT_WIRED: GET understanding is 404; wire the K3 product API first, do not re-ingest.');
assert(overviewWired, 'PREP_K3_NOT_WIRED: GET overview is 404; wire the K3 product API first.');
async function getUnderstanding(sourceId, rev) {
  const r = await apiJson('/api/sources/' + encodeURIComponent(sourceId) + '/understanding?revisionId=' + encodeURIComponent(rev));
  assert.equal(r.status, 200, 'GET understanding must be 200 for distilled revision.');
  const u = r.body;
  assertUnderstanding(u, rev.slice(0, 8));
  return u;
}
const rows = [];
let posted = 0;
const failedRevs = [], pausedRevs = [];
let distillMicro = 0;
const paidByFile = new Map();
const postedRevisions = new Set();
const firstPass = new Map();
let admit = true;
let newCost = 0;
{
  const blocked = [];
  for (const s of scoped) {
    const u = await getUnderstanding(s.id, s.currentRevisionId);
    if (u.state === 'failed' || u.state === 'paused') blocked.push(s.originalFilename + ':' + u.state);
  }
  assert.equal(blocked.length, 0, 'Paid preflight aborts: known failed/paused sources would fail the run, no paid calls made: ' + blocked.join(', '));
}
async function distillOne(s) {
  const rev = s.currentRevisionId;
  let u = await getUnderstanding(s.id, rev);
  if ((u.state === 'none' || u.state === 'queued') && !admit) {
    rows.push('| ' + s.originalFilename + ' | ' + u.state + ' | - | admitting stopped after first failure, no POST |');
    return;
  }
  if (u.state === 'none' || u.state === 'queued') {
    const p = await apiJson('/api/sources/' + encodeURIComponent(s.id) + '/understanding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: rev }) });
    assert.equal(p.status, 202, 'POST understanding is always 202 idempotent for ' + s.originalFilename + '.');
    assert(p.body && p.body.revisionId === rev, 'POST understanding must echo {revisionId} for ' + s.originalFilename + '.');
    posted++;
    postedRevisions.add(rev);
    u = await getUnderstanding(s.id, rev);
  }
  const t0 = Date.now();
  while (!TERMINAL.has(u.state)) {
    if (u.state === 'paused') break;
    assert(Date.now() - t0 < REV_TIMEOUT_MS, 'Distill poll timed out for ' + s.originalFilename + '; operator inspects, no auto retry.');
    await sleep(POLL_MS);
    u = await getUnderstanding(s.id, rev);
  }
  if (u.state === 'paused') { pausedRevs.push(s.originalFilename); rows.push('| ' + s.originalFilename + ' | paused | - | budget blocked, operator action, no retry |'); return; }
  if (u.state === 'failed') { failedRevs.push(s.originalFilename); rows.push('| ' + s.originalFilename + ' | failed | - | no auto retry |'); admit = false; return; }
  const claims = Array.isArray(u.claims) ? u.claims : [];
  assert(claims.length <= 32, 'Claims per revision capped at 32 (' + s.originalFilename + ').');
  const fileQuotes = [];
  for (const c of claims) {
    assert(c && typeof c.quote === 'string' && c.quote.length > 0, 'Each claim needs a non-empty quote (' + s.originalFilename + ').');
    const st = c.start;
    const en = c.end;
    assert(Number.isSafeInteger(st) && Number.isSafeInteger(en) && en > st, 'Each claim needs integer byte range (' + s.originalFilename + ').');
    const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + st + '&end=' + en);
    assert.equal(r.status, 200, 'Each claim quote must open (GET range 200).');
    assert.equal(r.bytes.toString('utf8'), c.quote, 'Each claim quote must equal the range bytes exactly (' + s.originalFilename + ').');
    assert.deepEqual(numericsUnsupported(c.quote, c.valueText, c.valueNumber, c.statement, c.conditions), [], 'Every numeric group must occur whole in its exact quote (' + s.originalFilename + ').');
    fileQuotes.push({ quote: c.quote, statement: c.statement });
  }
  paidByFile.set(s.originalFilename, fileQuotes);
  assert(u.report && typeof u.report === 'object', 'Terminal understanding must carry direct report (done/partial) (' + s.originalFilename + ').');
  const rep = u.report;
  const usage = rep.usage || {};
  for (const kk of ['calls', 'inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'wallMs']) assert(typeof usage[kk] === 'number', 'report.usage.' + kk + ' must be a number (' + s.originalFilename + ').');
  assert(usage.calls >= 0 && usage.calls <= 2, 'report.usage.calls bounded 0-2 (' + s.originalFilename + ').');
  assert(Array.isArray(rep.questions) && rep.questions.length >= 3, 'report.questions (3-5 guide questions) required (' + s.originalFilename + ').');
  assert(typeof rep.kept === 'number', 'report.kept must be a number (' + s.originalFilename + ').');
  assert(Array.isArray(rep.dropped), 'report.dropped must be an array of {index,reason} (' + s.originalFilename + ').');
  assert(typeof rep.clearedNumbers === 'number', 'report.clearedNumbers must be a number (' + s.originalFilename + ').');
  distillMicro += usage.estimatedCostMicrousd;
  if (postedRevisions.has(rev)) newCost += usage.estimatedCostMicrousd;
  let stable = snapOf(u);
  let agreed = false;
  for (let i = 0; i < 2 && !agreed; i++) {
    await sleep(POLL_MS);
    const r = await getUnderstanding(s.id, rev);
    const nxt = snapOf(r);
    if (nxt && stable && JSON.stringify(nxt) === JSON.stringify(stable)) { stable = nxt; agreed = true; }
    else stable = nxt;
  }
  if (!agreed || !stable) {
    admit = false;
    failedRevs.push(s.originalFilename + ': distill output not stable across reads, no baseline to compare');
    rows.push('| ' + s.originalFilename + ' | error | - | no stable terminal snapshot, no new admissions |');
    return;
  }
  firstPass.set(rev, stable);
  await writeFile(outDir + '/k3-' + String(rev).slice(0, 8) + '.json', JSON.stringify({ revisionId: rev, source: s.originalFilename, state: u.state, claims: claims.length, usage, kept: rep.kept, dropped: rep.dropped, clearedNumbers: rep.clearedNumbers }, null, 2));
  rows.push('| ' + s.originalFilename + ' | ' + u.state + ' | ' + claims.length + ' | ' + usage.calls + ' | ' + usage.inputTokens + '/' + usage.cachedTokens + '/' + usage.outputTokens + ' | ' + usage.estimatedCostMicrousd + ' | ' + usage.wallMs + ' |');
}
const pending = scoped.slice();
async function pump() {
  let s;
  while ((s = pending.shift()) !== undefined) {
    try {
      await distillOne(s);
    } catch (e) {
      admit = false;
      const msg = String((e && e.message) || e).split('\n')[0].replace(/\|/g, '/');
      console.error('K3 paid job failed, no new admissions: ' + s.originalFilename + ': ' + ((e && e.stack) || e));
      failedRevs.push(s.originalFilename + ': ' + msg);
      rows.push('| ' + s.originalFilename + ' | error | - | no new admissions after failure, no retry |');
    }
  }
}
await Promise.all([pump(), pump()]);
const changed = [];
const unbased = [];
const tailV = [];
try {
  for (const s of scoped) {
    const rev = s.currentRevisionId;
    const u = await getUnderstanding(s.id, rev);
    const snap = firstPass.get(rev);
    if (!snap) { unbased.push(s.originalFilename + ': ' + (u.state === 'failed' || u.state === 'paused' ? 'terminal failure, no baseline taken' : 'not processed this run, no terminal baseline')); continue; }
    const rep = u.report && typeof u.report === 'object' ? u.report : null;
    const usage = (rep && rep.usage) || {};
    const ids = Array.isArray(u.claims) ? u.claims.map((c) => c && c.id) : [];
    if (u.state === 'none' || u.state === 'queued' || usage.calls !== snap.calls || usage.estimatedCostMicrousd !== snap.cost || JSON.stringify(ids) !== JSON.stringify(snap.claims)) changed.push(s.originalFilename + ': calls/cost/claim identity moved without a new POST');
  }
} catch (e) {
  tailV.push('Second storage pass read failed: ' + String((e && e.message) || e).split('\n')[0]);
}
if (changed.length > 0) tailV.push('Second storage pass changed (' + changed.length + '): ' + changed.join('; '));
if (unbased.length > 0) tailV.push('Second storage pass missing baselines (' + unbased.length + '): ' + unbased.join('; '));
if (failedRevs.length > 0) tailV.push('Failed revisions (no auto retry): ' + failedRevs.join(', '));
if (pausedRevs.length > 0) tailV.push('Paused revisions need operator budget action: ' + pausedRevs.join(', '));
const missing = checkAnchors(paidByFile);
if (missing.length > 0) tailV.push('Missing anchors (reported, not weakened): ' + missing.join(', '));
let m1 = null;
try {
  const ov1 = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/overview');
  if (ov1.status !== 200) tailV.push('GET overview must be 200.');
  else {
    const ovIds = new Set(JSON.stringify(ov1.body).match(/[0-9a-f-]{36}/g) || []);
    for (const s of scoped) if (!ovIds.has(s.currentRevisionId)) tailV.push('Overview must list every readable revision (' + s.originalFilename + ').');
    const ov2 = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/overview');
    if (JSON.stringify(ov2.body) !== JSON.stringify(ov1.body)) tailV.push('Overview re-read must be deterministic.');
  }
} catch (e) {
  tailV.push('Overview read failed: ' + String((e && e.message) || e).split('\n')[0]);
}
try {
  m1 = await monthlyUsage();
  if (m1.used - m0.used !== newCost) tailV.push('Monthly usage delta must equal newly admitted distillation cost.');
  if (!(m1.used <= m1.budget)) tailV.push('Monthly model budget exceeded.');
} catch (e) {
  tailV.push('Monthly usage read failed: ' + String((e && e.message) || e).split('\n')[0]);
}
const md = ['# K3 Distill eval', '', '- project: ' + title + ' (10 arxiv, no re-ingest)', '- POSTed revisions this run: ' + posted + ' (second scan needs 0)', '- stored distill total: ' + distillMicro + ' micro-USD; newly admitted: ' + newCost, '- monthly usage delta: ' + (m1 ? (m1.used - m0.used) : 'unread'), '- no model or autoDistill settings changed', '- claim-mode C1-C4: NOT_RUN (hard gate remains open)', '- overview: membership + deterministic re-read required; see Open gates', '', '| source | state | claims | calls | in/cached/out | cost_uUSD | wall_ms |', '|---|---|---|---|---|---|---|'].concat(rows).concat(['', '## Open gates']).concat(tailV.length > 0 ? tailV.map((v) => '- ' + v) : ['- none']).concat(['']).join(EOL);
console.log(md);
await writeFile(outDir + '/k3-' + Date.now() + '.md', boundReport + EOL + EOL + md);
const claimTitle = process.env.ELIOT_K3_CLAIM_PROJECT;
const claimChatLoc = process.env.ELIOT_K3_CLAIM_CHAT;
const claimV = [];
if (!claimTitle || !claimChatLoc) claimV.push('K3 claim-mode NOT_RUN: set ELIOT_K3_CLAIM_PROJECT and ELIOT_K3_CLAIM_CHAT; root builds the larger dataset and chat preparation, no paid calls made here.');
else {
  let claimProj = null, cc = undefined;
  for (let i = 0; i < 5 && !claimProj; i++) {
    const pg = await apiJson('/api/projects' + (cc ? '?cursor=' + encodeURIComponent(cc) : ''));
    assert.equal(pg.status, 200, 'GET /api/projects must be 200.');
    claimProj = (pg.body.projects || []).find((x) => x && x.title === claimTitle) || null;
    cc = pg.body.nextCursor || undefined;
    if (!cc) break;
  }
  if (!claimProj) claimV.push('K3 claim-mode NOT_RUN: claim project not found: ' + claimTitle);
  else {
    assert.notEqual(claimProj.id, proj.id, 'Claim project must be separate from the baseline corpus project.');
    let csrc = [], sc = undefined;
    for (let i = 0; i < 10; i++) {
      const s = await apiJson('/api/projects/' + encodeURIComponent(claimProj.id) + '/sources' + (sc ? '?cursor=' + encodeURIComponent(sc) : ''));
      assert.equal(s.status, 200, 'GET claim sources must be 200.');
      csrc = csrc.concat(s.body.sources || []);
      sc = s.body.nextCursor || undefined;
      if (!sc) break;
    }
    const cread = csrc.filter((s) => s.currentRevisionId && (s.readableState === 'readable' || s.readableState === 'readable_with_warnings'));
    for (const rev of scoped.map((s) => s.currentRevisionId)) if (!cread.some((s) => s.currentRevisionId === rev)) claimV.push('Claim project misses baseline revision ' + String(rev).slice(0, 8));
    if (cread.length < scoped.length + 2) claimV.push('Claim project needs the baseline 10 plus at least two extra readable papers (GPT-3/PaLM minimum).');
    const mj = await apiJson('/api/models');
    assert.equal(mj.status, 200, 'GET /api/models must be 200.');
    const flash = (mj.body.models || []).find((x) => x && x.route === FLASH_MODEL);
    assert(flash && typeof flash.contextTokens === 'number' && typeof flash.maxOutputTokens === 'number' && flash.enabled !== false, 'Flash route must publish context/output numbers.');
    const sizeTokens = cread.reduce((n, s) => n + (typeof s.readableSize === 'number' ? s.readableSize : 0) / 3, 0);
    if (!(sizeTokens + flash.maxOutputTokens > Math.min(0.6 * flash.contextTokens, 400000))) claimV.push('Claim scope must overflow whole mode (UTF8/3 + output reserve > min(0.6*ctx,400k)).');
    for (const s of cread) {
      const u = await getUnderstanding(s.id, s.currentRevisionId);
      if (u.state !== 'done') claimV.push('Claim scope needs completed understanding, no hidden distill on reads: ' + s.originalFilename + ' is ' + u.state);
    }
    const revSet = cread.map((s) => s.currentRevisionId).sort().join(',');
    const revIdSet = new Set(cread.map((s) => s.currentRevisionId));
    const srcIds = cread.map((s) => s.id);
    let chat = null;
    const preOk = claimV.length === 0;
    {
      const cl = await apiJson('/api/projects/' + encodeURIComponent(claimProj.id) + '/chats');
      assert.equal(cl.status, 200, 'GET claim chats must be 200.');
      chat = (cl.body.chats || []).find((x) => x && (x.id === claimChatLoc || x.title === claimChatLoc)) || null;
      if (!chat) {
        assert(!/^[0-9a-fA-F-]{36}$/.test(claimChatLoc), 'K3 claim-mode NOT_RUN: claim chat id not found: ' + claimChatLoc);
        assert(runModel, 'K3 claim-mode read-only: claim chat missing, creation needs ELIOT_K3_MODEL=1.');
        assert(preOk, 'K3 claim-mode blocked: preconditions open, no paid chat creation.');
        const created = await apiJson('/api/projects/' + encodeURIComponent(claimProj.id) + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: claimChatLoc }) });
        assert.equal(created.status, 201, 'POST claim chat must be 201.');
        chat = created.body.chat;
      }
    }
    async function claimTurns() {
      const r = await apiJson('/api/projects/' + encodeURIComponent(claimProj.id) + '/chats/' + encodeURIComponent(chat.id));
      assert.equal(r.status, 200, 'GET claim chat snapshot must be 200.');
      return Array.isArray(r.body.turns) ? r.body.turns : [];
    }
    async function assertClaimTurn(t, tag) {
      await assertClaimTurnReadOnly(t, tag, revIdSet, revSet);
    }
    let postedTurns = 0;
    for (let qi = 0; qi < CLAIM_QUESTIONS.length; qi++) {
      const q = CLAIM_QUESTIONS[qi], tag = 'C' + (qi + 1);
      try {
        const turns = await claimTurns();
        let t = turns.find((x) => x && x.question === q && x.state === 'completed' && x.scopeMode === 'explicit' && Array.isArray(x.revisionIds) && x.revisionIds.slice().sort().join(',') === revSet) || null;
        if (!t) {
          const prior = turns.find((x) => x && x.question === q && x.state !== 'completed');
          if (prior) throw new Error(tag + ' already ' + (prior.state || 'unknown') + ', no retry');
          assert(runModel, 'K3 claim-mode read-only: missing ' + tag + ' turn, paid POST needs ELIOT_K3_MODEL=1.');
          assert(preOk, 'K3 claim-mode blocked: ' + tag + ' preconditions open, no paid POST.');
          const p = await apiJson('/api/projects/' + encodeURIComponent(claimProj.id) + '/chats/' + encodeURIComponent(chat.id) + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000), body: JSON.stringify({ turnId: crypto.randomUUID(), question: q, scopeMode: 'explicit', sourceIds: srcIds, model: FLASH_MODEL }) });
          assert.equal(p.status, 200, 'POST claim turn (wait=1) must be 200 (' + tag + ').');
          t = p.body && p.body.turn;
          assert(t && typeof t === 'object' && !t.busy, 'POST claim turn must return the TurnView (' + tag + ').');
          postedTurns++;
          assert(postedTurns <= 4, 'At most one call per question, max 4.');
          assert.equal(t.state, 'completed', 'Claim turn must be completed, not partial (' + tag + ' state=' + t.state + ').');
        }
        await assertClaimTurn(t, tag);
      } catch (e) {
        claimV.push(tag + ': ' + (e && e.message ? e.message : String(e)));
      }
    }
    const claimMd = ['# K3 claim-mode C1-C4 (whole-overflow scope, zero mode forcing)', '', '- project: ' + claimTitle, '- chat: ' + (chat.title || chat.id), '- posted turns this run: ' + postedTurns + ' (max 4, one per question)', '- scope revisions: ' + cread.length, '- model: ' + FLASH_MODEL, '- violations: ' + claimV.length, ''].join(EOL);
    console.log(claimMd);
    await writeFile(outDir + '/k3-claim-' + Date.now() + '.md', claimMd);
  }
}
const finalViolations = [...tailV, ...claimV];
assert.equal(finalViolations.length, 0, [
  ...(tailV.length ? ['K3 paid tail gates OPEN (' + tailV.length + '): ' + tailV.join('; ')] : []),
  ...(claimV.length ? ['K3 claim-mode hard gate NOT_RUN/OPEN: ' + claimV.join('; ')] : []),
].join('\n'));
