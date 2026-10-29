import { unsupportedNumbers, parseSingleNumber, countNumericQuantities } from "../../src/numbers.ts";
import { assertEvalOrigin, fetchEval } from "./origin.mjs";
// K3 Distill eval harness (docs/MAP.md K3; docs/IMPLEMENTATION.md 6, 8, 10, 11).
// Interface assumptions (backend contract under test):
//   GET  /api/sources/:sourceId/understanding?revisionId=<rev>
//     200 direct Understanding {sourceId,revisionId,state,error,guide,digest,glossary,claims,report} | 404 route absent
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
const UNIMINUS = String.fromCodePoint(0x2212);
const MIDDOT = String.fromCodePoint(0x00B7);
const SUPER_DIGITS = new Set(Array.from('⁰¹²³⁴⁵⁶⁷⁸⁹'));
// Selected models are frozen once from stored settings for this run (no hardcoded policy, no allowlist, no override flag).
let SELECTED_ANSWER_MODEL = '';
let SELECTED_DISTILL_MODEL = '';
const origin = assertEvalOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const H = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
const nativeOnly = process.argv.includes('--native-only');
const unchangedOnly = process.argv.includes('--unchanged-only');
const readerBrowser = process.argv.includes('--reader-browser');
const runModel = process.env.ELIOT_K3_MODEL === '1';
assert(!unchangedOnly || !runModel, '--unchanged-only forbids model work.');
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
  const chars = Array.from(String(s));
  for (let i = 1; i + 1 < chars.length; i++) {
    if (chars[i] === MIDDOT && SUPER_DIGITS.has(chars[i - 1]) && SUPER_DIGITS.has(chars[i + 1])) chars[i] = '.';
  }
  let n = chars.join('').normalize('NFKC').replace(/\[(?:S\d+|R[0-9a-f-]{36}):\d+\]/gi, ' ').toLowerCase().split(',').join('.');
  n = n.split(UNIMINUS).join('-');
  n = n.split('=').join(' = ');
  const strip = ['$', '*', '_', BT, BACKSLASH, '{', '}', '^', '(', ')', '[', ']', ':', ';', SQ, DQ, MIDDOT];
  for (const ch of strip) n = n.split(ch).join(' ');
  n = n.split(EOL).join(' ').split(TAB).join(' ');
  while (n.includes('  ')) n = n.split('  ').join(' ');
  return ' ' + n + ' ';
}
function c2FormulaPass(m) {
  const warmup4000 = /(?:\b(?:warmup|warm-up|warm up)\b|разогрев|прогрев|размин[а-яё]*)[\s\S]{0,40}\b4000\b|\b4000\b[\s\S]{0,40}(?:\b(?:warmup|warm-up|warm up)\b|разогрев|прогрев|размин[а-яё]*)/iu.test(m);
  const strictFormula = warmup4000 && /\bd model\s*-0\.5\b[\s\S]{0,120}\bmin\b[\s\S]{0,100}\bstep\s*-0\.5\b[\s\S]{0,80}\bstep\b[\s\S]{0,100}\bwarmup\s*-1\.5\b/u.test(m);
  const modelExponent = /\bd model\s*-0\.5\b|\bd model\s*-1\/2\b|1\s*\/\s*sqrt\s+d model|sqrt\s+d model\s*-1\b/u.test(m);
  const stepExponent = /\bstep\s*-0\.5\b|\bstep\s*-1\/2\b|1\s*\/\s*sqrt\s+step|sqrt\s+step\s*-1\b/u.test(m);
  const warmupExponent = /\bwarmup\s*-1\.5\b|\bwarmup\s*-3\/2\b|\/\s*warmup\s+(?:1\.5|3\/2)\b/u.test(m);
  const sqrtFormula = m.includes('sqrt') && warmup4000 && /\bmin\b/u.test(m)
    && modelExponent && stepExponent && warmupExponent;
  return strictFormula || sqrtFormula;
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
    assert(c2FormulaPass(m), 'C2 must contain the schedule formula with warmup 4000, or its sqrt equivalent.');
  }
  if (qid === 'C3') assert(has('0.001') && has('0.9') && has('0.999') && (has('1e-8') || m.includes('10 -8') || m.includes('10 - 8') || m.includes('10-8') || has('0.00000001')), 'C3 must contain Adam defaults with the numeric epsilon 1e-8 (the word alone does not pass).');
  if (qid === 'C4') assert((m.includes('синус') || m.includes('sinus')) && (m.includes('обуч') || m.includes('learn')), 'C4: sinusoidal vs learned.');
}
assert.equal(c2FormulaPass(normMath('d_model⁻⁰·⁵ · min(step⁻⁰·⁵, step · warmup⁻¹·⁵), warmup 4000')), true, 'C2 Unicode superscript schedule must pass.');
assert.equal(c2FormulaPass(normMath('1/sqrt(d_model) · min(1/sqrt(step), step/warmup^1.5), warmup 4000')), true, 'C2 equivalent square-root schedule must pass.');
assert.equal(c2FormulaPass(normMath('d_model⁻⁰·⁶ · min(step⁻⁰·⁵, step · warmup⁻¹·⁵), warmup 4000')), false, 'C2 wrong model exponent must fail.');
assert.equal(c2FormulaPass(normMath('d_model⁻⁰·⁵ · min(step⁻⁰·⁶, step · warmup⁻¹·⁵), warmup 4000')), false, 'C2 wrong step exponent must fail.');
assert.equal(c2FormulaPass(normMath('d_model⁻⁰·⁵ · min(step⁻⁰·⁵, step · warmup⁻¹·⁴), warmup 4000')), false, 'C2 wrong warmup exponent must fail.');
assert.equal(c2FormulaPass(normMath('1/sqrt(d_model) · min(1/sqrt(step), step · warmup^1.5), warmup 4000')), false, 'C2 positive warmup exponent outside the denominator must fail.');
assert.equal(c2FormulaPass(normMath('d_model⁻⁰·⁵ · min(step⁻⁰·⁵, step · warmup⁻¹·⁵), warmup 2000')), false, 'C2 wrong warmup value must fail.');
assert(!normMath('2·3').includes('2.3'), 'C2 ordinary middle dot must not become a decimal point.');
async function assertClaimTurnReadOnly(t, tag, revIdSet, revKey) {
  assert.equal(t.contextMode, 'claims', 'TurnView.contextMode must be claims (' + tag + ').');
  assert(typeof SELECTED_ANSWER_MODEL === 'string' && SELECTED_ANSWER_MODEL.length > 0, 'Selected answerModel must be frozen before claim checks (' + tag + ').');
  assert.equal(t.model, SELECTED_ANSWER_MODEL, 'Turn model must stay the frozen selected answerModel (' + tag + ').');
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
  const r = await fetchEval(origin + path, { ...init, headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) } }, origin, process.env.ELIOT_ORIGIN);
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: t.slice(0, 300) }; }
  return { status: r.status, body: b };
}
async function apiBytes(path) {
  const r = await fetchEval(origin + path, { headers: { ...H } }, origin, process.env.ELIOT_ORIGIN);
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
function compoundResultUnsupported(c) {
  if (!c || c.kind !== 'result') return [];
  if (typeof c.valueText !== 'string' || c.valueText.trim() === '') return [];
  return countNumericQuantities(c.valueText) > 1 ? ['compound-result-valueText'] : [];
}
assert.deepEqual(numericsUnsupported('Speedup 10,000x on 8 GPUs.', '10,000', 10000, '8 GPUs'), [], 'Harness selftest: unambiguous thousands must parse, verified text stays strict.');
assert.deepEqual(numericsUnsupported('quoted 10,000 dollars', '10,000 dollars', 10000), ['10000'], 'Harness selftest: compound valueText with a number must fail.');
assert.equal(countNumericQuantities('+27.1% / 8.3%'), 2, 'Harness selftest: captured compound result counts two quantities.');
assert.deepEqual(compoundResultUnsupported({ kind: 'result', valueText: '+27.1% / 8.3%', valueNumber: null }), ['compound-result-valueText'], 'Harness selftest: captured compound result card must fail.');
assert.deepEqual(compoundResultUnsupported({ kind: 'result', valueText: '27.1%', valueNumber: null }), [], 'Harness selftest: single scalar result stays passing.');
assert.deepEqual(compoundResultUnsupported({ kind: 'method', valueText: '+27.1% / 8.3%', valueNumber: null }), [], 'Harness selftest: non-result keeps existing semantics.');
assert.deepEqual(numericsUnsupported('eps 1e-8 floor', '1e-8', 1e-8), [], 'Harness selftest: scientific scalar must parse exactly.');
assert.deepEqual(numericsUnsupported('rate 95.2% agreed', '95.2%', 95.2), [], 'Harness selftest: literal percent unit is source-as-written, no conversion.');
assert(numericsUnsupported('rate 95.2% agreed', '95.2%', 0.952).length > 0, 'Harness selftest: percent must not convert (95.2% is 95.2, never 0.952).');
assert(numericsUnsupported('quote 95.2% only', '95.3%', 95.3).length > 0, 'Harness selftest: unsupported 95.3% against a 95.2% quote stays bad.');
assert(numericsUnsupported('Training cost reached 0.50.', null, null, 'Training cost decreased.', 'with 50% dropout').length > 0, 'Harness selftest: a percentage condition cannot borrow digits from a decimal axis tick.');
assert.deepEqual(numericsUnsupported('synthetic measurement 41.0; separate count 8 units.', '41.8', 41.8), ['41.8'], 'Harness selftest: split decimal runs (41.0 + separate 8) must not validate 41.8.');
assert.deepEqual(numericsUnsupported('synthetic measurement 41.0; separate count 8 units.', '41,8'), ['41.8'], 'Harness selftest: RU comma 41,8 is not supported by 41.0 plus a lone 8.');
assert.deepEqual(numericsUnsupported('score 41.8 here', '41,8'), [], 'Harness selftest: RU comma 41,8 matches dotted source 41.8.');
assert.deepEqual(numericsUnsupported('energy 41.8e2 joules', '41.8', 41.8), ['41.8'], 'Harness selftest: full tokens, 41.8 is not supported by 41.8e2.');
function snapOf(t) {
  if (!t || (t.state !== 'done' && t.state !== 'partial')) return null;
  const rep = t.report && typeof t.report === 'object' ? t.report : null;
  const usage = (rep && rep.usage) || {};
  if (typeof usage.calls !== 'number' || typeof usage.tokenLimit !== 'number' || !Array.isArray(t.claims)) return null;
  return { state: t.state, revisionId: t.revisionId, report: rep, claims: t.claims, claimRows: t.claims.length,
    calls: usage.calls, tokenLimit: usage.tokenLimit };
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
if (!proj) { console.log('K3 skipped: project ' + JSON.stringify(title) + ' not found; prep K1 corpus first, do not upload/convert again.'); process.exit(2); }
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
if (!nativeOnly && scoped.length < 10) { console.log('K3 skipped: found ' + scoped.length + '/10 arxiv readable; prep K1 first, do not upload/convert again.'); process.exit(2); }
function storedRevisionSnapshot(u, what) {
  assertUnderstanding(u, what);
  assert(Array.isArray(u.claims), what + ' must expose its exact claim rows.');
  const usage = u.report && typeof u.report === 'object' && u.report.usage && typeof u.report.usage === 'object'
    ? u.report.usage : null;
  if (u.state === 'done' || u.state === 'partial') {
    assert(usage && Number.isSafeInteger(usage.calls) && usage.calls >= 0, what + ' must carry owning-revision call count.');
    assert(Number.isSafeInteger(usage.tokenLimit) && usage.tokenLimit >= 0, what + ' must carry owning-revision tokenLimit.');
  }
  return { body: u, claimRows: u.claims.length, calls: usage ? usage.calls : null, tokenLimit: usage ? usage.tokenLimit : null };
}
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
if (unchangedOnly) {
  assert(understandingWired && overviewWired, 'K3 unchanged-only requires wired understanding and overview routes.');
  assert.equal(scoped.length, 10, 'K3 unchanged-only needs the frozen 10 arxiv readable sources; prep K1 first, no re-ingest.');
  const settingsBeforeRaw = await apiJson('/api/settings');
  assert.equal(settingsBeforeRaw.status, 200, 'GET /api/settings must be 200 (before).');
  assert(typeof settingsBeforeRaw.body.settings?.answerModel === 'string', 'GET settings must include the configured model.');
  const settingsBefore = JSON.stringify(settingsBeforeRaw.body.settings);
  const frozen = [];
  const preflightViolations = [];
  let callsBefore = 0;
  let claimRowsBefore = 0;
  for (const s of scoped) {
    const r = await apiJson('/api/sources/' + encodeURIComponent(s.id) + '/understanding?revisionId=' + encodeURIComponent(s.currentRevisionId));
    if (r.status !== 200) { preflightViolations.push(s.originalFilename + ': GET understanding ' + r.status); continue; }
    try { assertUnderstanding(r.body, 'unchanged preflight ' + s.originalFilename); } catch (e) { preflightViolations.push(s.originalFilename + ': ' + String((e && e.message) || e).split(EOL)[0]); continue; }
    if (r.body.revisionId !== s.currentRevisionId) { preflightViolations.push(s.originalFilename + ': revisionId mismatch'); continue; }
    if (r.body.state !== 'done' && r.body.state !== 'partial') { preflightViolations.push(s.originalFilename + ': state=' + r.body.state + ' (need terminal done/partial, no POST)'); continue; }
    const rep = r.body.report;
    if (!rep || !rep.usage || !Number.isSafeInteger(rep.usage.calls) || rep.usage.calls < 0 || rep.usage.calls > 2 ||
      !Number.isSafeInteger(rep.usage.tokenLimit) || rep.usage.tokenLimit < 0) { preflightViolations.push(s.originalFilename + ': invalid owning-revision usage'); continue; }
    const record = storedRevisionSnapshot(r.body, 'unchanged preflight ' + s.originalFilename);
    callsBefore += record.calls;
    claimRowsBefore += record.claimRows;
    frozen.push({ sourceId: s.id, filename: s.originalFilename, revisionId: s.currentRevisionId, record });
  }
  if (preflightViolations.length > 0 || frozen.length !== 10) {
    const mdFail = ['# K3 unchanged-only reuse (partial scope, storage-only)', '', '- project: ' + title, '- preflight: ' + frozen.length + '/10 frozen terminal, violations: ' + preflightViolations.length, '- fullK3Accepted: false', '', '## Preflight open', ''].concat(preflightViolations.map((v) => '- ' + v)).concat(['', '- no POST made (rejected before any POST).', '- K2/K3 remain unaccepted.', '']).join(EOL);
    console.log(mdFail);
    await writeFile(outDir + '/k3-unchanged-only-' + Date.now() + '.md', mdFail);
    assert.equal(preflightViolations.length, 0, 'K3 unchanged-only preflight OPEN (no POST made): ' + preflightViolations.join('; '));
    assert.equal(frozen.length, 10, 'K3 unchanged-only needs 10 frozen terminal revisions.');
    process.exit(1);
  }
  let postedUnchanged = 0;
  for (const f of frozen) {
    const p = await apiJson('/api/sources/' + encodeURIComponent(f.sourceId) + '/understanding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: f.revisionId }) });
    assert.equal(p.status, 202, 'POST unchanged understanding must be 202 idempotent for ' + f.filename + '.');
    assert(p.body && p.body.revisionId === f.revisionId, 'POST unchanged must echo {revisionId} for ' + f.filename + '.');
    postedUnchanged++;
  }
  const reuseViolations = [];
  let callsAfter = 0, revisionRowsReadAfter = 0;
  let claimRowsAfter = 0;
  const byFile = new Map();
  for (const f of frozen) {
    const r = await apiJson('/api/sources/' + encodeURIComponent(f.sourceId) + '/understanding?revisionId=' + encodeURIComponent(f.revisionId));
    if (r.status !== 200) { reuseViolations.push(f.filename + ': re-GET ' + r.status); continue; }
    if (r.body.revisionId !== f.revisionId) reuseViolations.push(f.filename + ': revisionId moved');
    if (r.body.state !== f.state) reuseViolations.push(f.filename + ': state moved ' + f.state + ' -> ' + r.body.state);
    const recordAfter = storedRevisionSnapshot(r.body, 'unchanged re-read ' + f.filename);
    revisionRowsReadAfter++;
    if (JSON.stringify(recordAfter.body) !== JSON.stringify(f.record.body)) reuseViolations.push(f.filename + ': exact stored revision record changed');
    callsAfter += recordAfter.calls;
    claimRowsAfter += recordAfter.claimRows;
    const claims = Array.isArray(r.body.claims) ? r.body.claims : [];
    for (const c of claims) {
      const rr = await apiBytes('/api/revisions/' + encodeURIComponent(f.revisionId) + '/range?start=' + c.start + '&end=' + c.end);
      if (rr.status !== 200 || rr.bytes.toString('utf8') !== c.quote) { reuseViolations.push(f.filename + ': stored quote bytes moved'); break; }
    }
    byFile.set(f.filename, claims.map((c) => ({ quote: c && c.quote, statement: c && c.statement })));
  }
  const settingsAfterRaw = await apiJson('/api/settings');
  assert.equal(settingsAfterRaw.status, 200, 'GET /api/settings must be 200 (after).');
  assert(settingsAfterRaw.body && settingsAfterRaw.body.settings, 'GET /api/settings must retain settings.');
  if (JSON.stringify(settingsAfterRaw.body.settings) !== settingsBefore) reuseViolations.push('settings changed');
  if (callsAfter !== callsBefore) reuseViolations.push('call count delta: before ' + callsBefore + ' after ' + callsAfter);
  const missing = checkAnchors(byFile);
  const md = ['# K3 unchanged revisions', '', '- project: ' + title, '- origin: ' + origin,
    '- frozen terminal revision rows before/after: ' + frozen.length + '/' + revisionRowsReadAfter, '- owning revision claim rows before/after: ' + claimRowsBefore + '/' + claimRowsAfter,
    '- idempotent POSTs: ' + postedUnchanged,
    '- stored calls before/after: ' + callsBefore + '/' + callsAfter,
    '- settings preserved: ' + String(JSON.stringify(settingsAfterRaw.body.settings) === settingsBefore),
    '- exact owning revision records preserved: ' + String(reuseViolations.length === 0),
    '- fullK3Accepted: false', '- Scope: unchanged-revision reuse only; claim-mode C1–C4 remain open.', '',
    '## Reuse violations (' + reuseViolations.length + ')', '',
    ...reuseViolations.map((v) => '- ' + v), '', '## Missing semantic anchors (' + missing.length + ')', '',
    ...missing.map((v) => '- ' + v), ''].join(EOL);
  console.log(md);
  await writeFile(outDir + '/k3-unchanged-only-' + Date.now() + '.md', md);
  assert.equal(reuseViolations.length, 0, 'K3 unchanged-only reuse OPEN: ' + reuseViolations.join('; '));
  if (missing.length > 0) assert.equal(missing.length, 0, 'K3 full semantic anchors OPEN (partial reuse only, K2/K3 not accepted): ' + missing.join(', '));
  process.exit(0);
}
const settingsForRun = await apiJson('/api/settings');
assert.equal(settingsForRun.status, 200, 'GET /api/settings must be 200 to freeze selected models.');
const storedSettings = settingsForRun.body && settingsForRun.body.settings ? settingsForRun.body.settings : {};
assert(storedSettings && typeof storedSettings === 'object', 'GET settings must expose stored model settings.');
const settingsBeforeRun = JSON.stringify(storedSettings);
assert(typeof storedSettings.answerModel === 'string' && storedSettings.answerModel.length > 0, 'Stored settings.answerModel must be a non-empty route.');
SELECTED_ANSWER_MODEL = storedSettings.answerModel;
SELECTED_DISTILL_MODEL = storedSettings.distillModel;
assert(typeof SELECTED_DISTILL_MODEL === 'string' && SELECTED_DISTILL_MODEL.length > 0, 'Stored settings.distillModel must be a non-empty route.');
const modelList = await apiJson('/api/models');
assert.equal(modelList.status, 200, 'Read current catalogue before reporting the acceptance bound.');
const answerMeta = (modelList.body.models || []).find((model) => model && model.route === SELECTED_ANSWER_MODEL);
assert(answerMeta && answerMeta.enabled, 'Selected answerModel must be present and enabled in the current catalogue; no substitution is made here.');
assert(Number.isSafeInteger(answerMeta.contextTokens) && answerMeta.contextTokens > 0, 'Selected answerModel context must be known.');
const answerOutputBound = answerMeta.outputReserveTokens ?? answerMeta.maxOutputTokens;
assert(Number.isSafeInteger(answerOutputBound) && answerOutputBound > 0, 'Selected answerModel output bound must be known.');
const distillMeta = (modelList.body.models || []).find((model) => model && model.route === SELECTED_DISTILL_MODEL);
assert(distillMeta && distillMeta.enabled, 'Selected distillModel must be present and enabled in the current catalogue; no substitution is made here.');
assert(Number.isSafeInteger(distillMeta.contextTokens) && distillMeta.contextTokens > 0, 'Selected distillModel context must be known.');
const distillOutputBound = distillMeta.outputReserveTokens ?? distillMeta.maxOutputTokens;
assert(Number.isSafeInteger(distillOutputBound) && distillOutputBound > 0, 'Selected distillModel output bound must be known.');
const answerCallTokenLimit = answerMeta.contextTokens + answerOutputBound;
const distillCallTokenLimit = distillMeta.contextTokens + distillOutputBound;
const fullFreshCalls = 28;
const revisionRecordsBefore = new Map();
const boundReport = 'Fresh full K3 bound: baseline 10*2 + overflow 2*2 + answers 4*1 = 28 calls, distill per-call token limit ' + distillCallTokenLimit + ' (ctx+output, ' + SELECTED_DISTILL_MODEL + '), answer per-call token limit ' + answerCallTokenLimit + ' (ctx+output, ' + SELECTED_ANSWER_MODEL + '), two-call distill ' + (2 * distillCallTokenLimit) + '. Historical calls are not reset or silently counted as fresh. Models frozen once from stored settings for this run.';
console.log(boundReport);
if (nativeOnly) {
  assert(understandingWired && overviewWired, 'K3 native smoke requires the actual understanding and overview routes.');
  {
    for (const source of scoped) {
      const beforeRecord = await getUnderstanding(source.id, source.currentRevisionId);
      revisionRecordsBefore.set(source.currentRevisionId, storedRevisionSnapshot(beforeRecord, 'native-only initial ' + source.originalFilename));
    }
    const recLines = [];
    const recSource = process.env.ELIOT_K3_RECOVER_SOURCE;
    const recRevEnv = process.env.ELIOT_K3_RECOVER_REVISION;
    const recoveryUpdatedRevisions = new Set();
    if (recSource) {
      let recProjId = null;
      const pl = await apiJson('/api/projects');
      assert.equal(pl.status, 200, 'GET /api/projects must be 200.');
      for (const p of pl.body.projects || []) {
        const sl = await apiJson('/api/projects/' + encodeURIComponent(p.id) + '/sources');
        assert.equal(sl.status, 200, 'GET project sources must be 200.');
        if ((sl.body.sources || []).some((x) => x && x.id === recSource)) { recProjId = p.id; break; }
      }
      assert(recProjId, 'Recovery source project was not found.');
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
      assert(u0.report.usage && Number.isSafeInteger(u0.report.usage.calls) && Number.isSafeInteger(u0.report.usage.tokenLimit), 'Terminal fixture must carry owning-revision calls and tokenLimit.');
      assert(u0.report.raw && typeof u0.report.raw === 'object', 'Terminal fixture must carry current raw excerpts (raw compat).');
      const recStartState = u0.state;
      const alreadyChecked = !!(u0.report.artifacts && u0.report.artifacts.guide === 'source/' + rev + '/checked/guide.md');
      if (!alreadyChecked) assert(u0.canRecover === true, 'Terminal fixture must expose canRecover before save (stored output only).');
      const usageBefore = u0.report.usage;
      const claimsBeforeRows = u0.claims.length;
      const textBefore = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text');
      assert.equal(textBefore.status, 200, 'GET revision text must be 200.');
      const origBefore = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/original');
      assert.equal(origBefore.status, 200, 'GET revision original must be 200.');
      const cur = await apiJson('/api/settings');
      assert.equal(cur.status, 200, 'GET /api/settings must be 200.');
      const s0 = cur.body.settings || {};
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
          const bad = [...numericsUnsupported(c.quote, c.valueText, c.valueNumber, c.statement, c.conditions), ...compoundResultUnsupported(c)];
          assert.deepEqual(bad, [], 'Recovered numeric must be quote-supported: ' + bad.join(','));
        }
        assert(u1.report && typeof u1.report === 'object', 'Recovered revision must carry its report.');
        assert.deepEqual(u1.report.usage, usageBefore, 'Recovered report.usage must equal pre-save usage (no new model work).');
        const claimsAfterRows = u1.claims.length;
        const textAfter = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text');
        assert(textBefore.bytes.equals(textAfter.bytes), 'Primary text bytes must be unchanged by save.');
        const origAfter = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/original');
        assert(origBefore.bytes.equals(origAfter.bytes), 'Original bytes must be unchanged by save.');
        const p2 = await apiJson('/api/sources/' + encodeURIComponent(recSource) + '/understanding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: rev, saveAvailable: true }) });
        assert.equal(p2.status, 202, 'Repeat POST must stay 202 (idempotent).');
        const u2 = await getUnderstanding(recSource, rev);
        assert.deepEqual(u2.claims, u1.claims, 'Repeat save must preserve the exact owning revision claim rows.');
        assert.deepEqual(u2.report, u1.report, 'Repeat save must preserve the exact owning revision report record.');
        assert.equal(u2.claims.length, claimsAfterRows, 'Repeat save must preserve owning revision claim row count.');
        recoveryUpdatedRevisions.add(rev);
        recLines.push('- recovery source: ' + recSource + ' rev ' + String(rev).slice(0, 8) + ' (' + recStartState + ' -> ' + u1.state + ', terminal cached recheck)');
        recLines.push('- owning revision usage calls/tokenLimit: ' + usageBefore.calls + '/' + usageBefore.tokenLimit + '; claim rows before/after: ' + claimsBeforeRows + '/' + claimsAfterRows);
        recLines.push('- recovery checked artifacts: report.artifacts at checked/guide.md, checked/digest.md, checked/glossary.json; canRecover false after save');
        recLines.push('- recovery text/original bytes identical; repeat POST preserves exact report and claim rows; settings untouched');
      } finally {
        const after = await apiJson('/api/settings');
        assert.deepEqual(after.body.settings, cur.body.settings, 'Storage-only recovery must not change answer/distill settings.');
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
      for (const kk of ['calls', 'inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'wallMs']) assert(typeof cusage[kk] === 'number', 'Check report.usage.' + kk + ' must be numeric owning-revision usage.');
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
        assert.deepEqual([...numericsUnsupported(cc.quote, cc.valueText, cc.valueNumber, cc.statement, cc.conditions), ...compoundResultUnsupported(cc)], [], 'Check numeric must be quote-supported.');
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
    const browserLines = [];
    if (readerBrowser) {
      let rbSrc = null;
      let rbRev = null;
      let rbU = null;
      const preferId = String(process.env.ELIOT_K3_CHECK_SOURCE || '').trim();
      const candLists = [];
      if (preferId) {
        const f = (sources || []).find((s) => s && s.id === preferId && s.currentRevisionId);
        if (f) candLists.push(f);
      }
      for (const s of scoped) if (!candLists.includes(s)) candLists.push(s);
      for (const s of (sources || [])) if (!candLists.includes(s)) candLists.push(s);
      for (const s of candLists) {
        if (!s || !s.currentRevisionId || !['readable', 'readable_with_warnings'].includes(s.readableState)) continue;
        const u = await apiJson('/api/sources/' + encodeURIComponent(s.id) + '/understanding?revisionId=' + encodeURIComponent(s.currentRevisionId));
        if (u.status === 200 && u.body && (u.body.state === 'done' || u.body.state === 'partial')) { rbSrc = s; rbRev = s.currentRevisionId; rbU = u.body; break; }
      }
      if (!rbSrc) {
        browserLines.push('- readerBrowserChecks: skipped (no stored done/partial understanding in corpus, no new derivation)');
      } else {
        assertUnderstanding(rbU, 'reader-browser stored');
        const rbText = await apiBytes('/api/revisions/' + encodeURIComponent(rbRev) + '/text');
        assert.equal(rbText.status, 200, 'Reader-browser stored text must open (GET revision text 200).');
        const rbStoredText = rbText.bytes.toString('utf8');
        assert(rbStoredText.length > 0, 'Reader-browser stored text must be non-empty.');
        const rbRecordBefore = storedRevisionSnapshot(rbU, 'reader-browser before');
        const rbOv1 = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/overview');
        assert.equal(rbOv1.status, 200, 'Reader-browser overview must be 200.');
        const rbOvKey1 = JSON.stringify(rbOv1.body);
        const hasGuide = typeof rbU.guide === 'string' && rbU.guide.length > 0;
        const hasClaims = Array.isArray(rbU.claims) && rbU.claims.length > 0;
        if (!hasGuide) browserLines.push('- readerGuideCheck: skipped (stored understanding has no guide, no mock)');
        if (!hasClaims) browserLines.push('- readerClaimCheck: skipped (stored understanding has zero claims, no mock)');
        const imp = await import('@playwright/test');
        const chromium = imp.chromium;
        const pwexpect = imp.expect;
        const browser = await chromium.launch();
        const mutations = [];
        const pageErrors = [];
        try {
          const combos = [
            { name: 'reader-1440-light', w: 1440, h: 900, theme: 'light' },
            { name: 'reader-1440-dark', w: 1440, h: 900, theme: 'dark' },
            { name: 'reader-390-light', w: 390, h: 844, theme: 'light' },
            { name: 'reader-390-dark', w: 390, h: 844, theme: 'dark' },
          ];
          const readerUrl = origin + '/p/' + encodeURIComponent(proj.id) + '/source/' + encodeURIComponent(rbSrc.id) + '?revisionId=' + encodeURIComponent(rbRev);
          let firstHref = '';
          let firstMeta = '';
          let firstGuideOk = false;
          for (const c of combos) {
            const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, colorScheme: c.theme });
            await ctx.route('**/api/**', async (route) => {
              const req = route.request();
              if (req.method() !== 'GET' && req.method() !== 'HEAD') {
                mutations.push(req.method() + ' ' + new URL(req.url()).pathname);
                await route.abort('blockedbyclient');
                return;
              }
              await route.continue();
            });
            const page = await ctx.newPage();
            page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
            await page.goto(readerUrl, { waitUntil: 'domcontentloaded' });
            await pwexpect(page.locator('.er-lib__text')).toBeVisible({ timeout: 15000 });
            const probeWords = rbStoredText.slice(0, 48).trim().split(/\s+/).slice(0, 4).join(' ');
            if (probeWords.length > 8) await pwexpect(page.locator('.er-lib__text')).toContainText(probeWords.slice(0, 24), { timeout: 15000 });
            else await pwexpect.poll(async () => (await page.locator('.er-lib__text').innerText()).trim().length, { timeout: 15000 }).toBeGreaterThan(0);
            const visText = await page.locator('.er-lib__text').innerText();
            assert(visText.trim().length > 0, 'Reader visible text must be non-empty (' + c.name + ').');
            if (probeWords.length > 8) assert(visText.includes(probeWords.slice(0, 24)) || rbStoredText.includes(visText.slice(0, 24)), 'Reader must keep source-derived text (' + c.name + ').');
            if (rbU.state === 'partial') await pwexpect(page.getByText(/Partially understood|Partial understanding/i).first()).toBeVisible({ timeout: 15000 });
            const understandingRegion = page.getByRole('region', { name: 'Understanding', exact: true });
            await pwexpect(understandingRegion.locator('details.er-und__details')).toHaveCount(0);
            await pwexpect(understandingRegion.getByRole('heading', { name: 'Verified claims', exact: true })).toBeVisible();
            if (typeof rbU.error === 'string' && rbU.error !== '')
              await pwexpect(understandingRegion.getByRole('alert').filter({ hasText: rbU.error })).toBeVisible();
            if (rbU.canRecover === true)
              await pwexpect(understandingRegion.getByRole('button', { name: 'Recheck saved output', exact: true })).toBeVisible();
            const factsBox = page.locator('details.er-lib__facts').first();
            if (await factsBox.count() > 0) {
              const factsOpen = await factsBox.evaluate((el) => (el as HTMLDetailsElement).open);
              if (!factsOpen) await factsBox.locator('summary').first().click();
            }
            if (hasGuide) {
              const guideLoc = page.locator('.er-und__guide').first();
              await pwexpect(guideLoc).toBeVisible({ timeout: 15000 });
              const guideNeedle = String(rbU.guide || '').slice(0, 80).trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 32);
              if (guideNeedle.length > 8) await pwexpect(guideLoc).toContainText(guideNeedle.slice(0, 16), { timeout: 15000 });
              else await pwexpect.poll(async () => (await guideLoc.innerText().catch(() => '')).trim().length, { timeout: 15000 }).toBeGreaterThan(0);
            }
            if (hasClaims) {
              await pwexpect(page.locator('.er-und__claims .er-und__claim').first()).toBeVisible({ timeout: 15000 });
              const claimNeedle = String((rbU.claims[0] && rbU.claims[0].statement) || '').slice(0, 80).trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 28);
              if (claimNeedle.length > 8) await pwexpect(page.locator('.er-und__claims').first()).toContainText(claimNeedle.slice(0, 16), { timeout: 15000 });
              await pwexpect(page.locator('.er-und__claims .er-und__cite').first()).toBeVisible({ timeout: 15000 });
            }
            if (c.name === 'reader-1440-light' && hasGuide) {
              const g = await page.locator('.er-und__guide').first().innerText().catch(() => '');
              if (g && g.trim().length > 0) firstGuideOk = true;
            }
            await page.locator('.er-lib__head').first().scrollIntoViewIfNeeded().catch(() => {});
            await page.screenshot({ path: outDir + '/' + c.name + '.png' });
            if (hasGuide) {
              await page.locator('.er-und__guide').first().scrollIntoViewIfNeeded().catch(() => {});
              await page.screenshot({ path: outDir + '/' + c.name + '-guide.png' });
            }
            if (hasClaims) {
              await page.locator('.er-und__claims .er-und__claim').first().scrollIntoViewIfNeeded().catch(() => {});
              await page.locator('.er-und__claims .er-und__cite').first().scrollIntoViewIfNeeded().catch(() => {});
              await page.screenshot({ path: outDir + '/' + c.name + '-claim.png' });
            }
            if (c.name === 'reader-1440-light') {
              const factsPanel = page.locator('.er-lib__facts-content').first();
              const understandingStatus = page.getByRole('region', { name: 'Understanding', exact: true }).getByRole('status').first();
              await pwexpect(factsPanel).toBeVisible();
              await pwexpect(understandingStatus).toBeVisible();
              await pwexpect(factsPanel).toContainText(/\S/);
              await pwexpect(understandingStatus).toContainText(/\S/);
              const facts = await factsPanel.innerText();
              const controls = await understandingRegion.locator(':scope > .er-und__hint, :scope > .er-und__meta, :scope > .er-und__actions, :scope > .er-und__model-details').allInnerTexts();
              firstMeta = facts + ' ' + controls.join(' ');
              assert(!/workers-ai:|gateway:|bounded calls|reserved|tokens|wallms/i.test(controls.join(' ')), 'Understanding controls must omit service machinery, raw model routes, and verification counters.');
              await pwexpect(page.getByRole('region', { name: 'Understanding', exact: true })).not.toContainText(/This attempt is terminal|re-queued automatically|Storage-only|Configured model:|Historical revision model:/i);
              if (hasClaims) {
                const cite = page.locator('.er-und__claims .er-und__cite').first();
                firstHref = await cite.getAttribute('href') || '';
              }
            }
            await ctx.close();
          }
          assert.deepEqual(mutations, [], 'Reader browser must issue zero non-GET/HEAD API calls (GET-only).');
          assert.deepEqual(pageErrors, [], 'Reader browser must report zero page errors.');
          assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(firstMeta), 'Metadata areas must not display revision UUIDs (hrefs keep full IDs).');
          assert(!/bounded calls|reserved|tokens|wallms|conversion.*calls|bytes of readable|bytes original/i.test(firstMeta), 'Metadata areas must not display model/telemetry values.');
          if (hasGuide) assert(firstGuideOk, 'Stored guide must be visible in the reader (no mock).');
          if (hasClaims) {
            assert(firstHref.includes(rbRev), 'Open quote href must keep the full revisionId.');
            const m = firstHref.match(/start=(\d+).*end=(\d+)/);
            assert(m, 'Open quote href must keep start/end.');
            const st = Number(m[1]);
            const en = Number(m[2]);
            const firstClaim = rbU.claims[0];
            assert.equal(st, firstClaim.start, 'Open quote href start must equal stored claim start.');
            assert.equal(en, firstClaim.end, 'Open quote href end must equal stored claim end.');
            const rng = await apiBytes('/api/revisions/' + encodeURIComponent(rbRev) + '/range?start=' + st + '&end=' + en);
            assert.equal(rng.status, 200, 'Open quote range must open (GET range 200).');
            assert.equal(rng.bytes.toString('utf8'), firstClaim.quote, 'Open quote GET bytes must equal the stored claim quote exactly.');
          }
          const rbU2 = await apiJson('/api/sources/' + encodeURIComponent(rbSrc.id) + '/understanding?revisionId=' + encodeURIComponent(rbRev));
          assert.equal(rbU2.status, 200, 'Understanding re-read must stay 200 after browser.');
          const rbRecordAfter = storedRevisionSnapshot(rbU2.body, 'reader-browser after');
          assert.deepEqual(rbRecordAfter.body, rbRecordBefore.body, 'GET-only reader browser must preserve the exact owning revision record.');
          assert.equal(rbRecordAfter.claimRows, rbRecordBefore.claimRows, 'GET-only reader browser must preserve the owning revision claim row count.');
          assert.equal(rbRecordAfter.calls, rbRecordBefore.calls, 'GET-only reader browser must preserve the owning revision call count.');
          const rbOv2 = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/overview');
          assert.equal(JSON.stringify(rbOv2.body), rbOvKey1, 'Overview must stay deterministic across browser.');
          browserLines.push('- readerBrowserChecks: true (1440+390 light/dark screenshots; GET-only, zero non-GET/HEAD, zero page errors)');
          browserLines.push('- reader-browser source: ' + (rbSrc.originalFilename || rbSrc.title) + ' rev ' + String(rbRev).slice(0, 8) + ' (' + rbU.state + ', stored done/partial, no new derivation)');
          browserLines.push('- reader-browser metadata: no UUID/telemetry in facts/details; source text/guide/claims kept; quote href keeps full revisionId/start/end with byte-exact GET');
          browserLines.push('- reader-browser owning revision: exact report/claim rows and call count unchanged; overview deterministic');
          if (rbU.state === 'partial') browserLines.push('- partialHintDisplayed: true');
          else {
            let otherPartial = null;
            for (const s of (sources || [])) {
              if (!s || s.id === rbSrc.id || !s.currentRevisionId) continue;
              if (s.readableState === 'needs_conversion' || s.readableState === 'failed') { otherPartial = { s: s, st: s.readableState }; break; }
              const u = await apiJson('/api/sources/' + encodeURIComponent(s.id) + '/understanding?revisionId=' + encodeURIComponent(s.currentRevisionId));
              if (u.status === 200 && (u.body.state === 'partial' || u.body.state === 'failed' || u.body.state === 'none')) { otherPartial = { s: s, st: u.body.state }; break; }
            }
            if (otherPartial) browserLines.push('- reader-browser unavailable/partial display: covered on ' + (otherPartial.s.originalFilename || otherPartial.s.title) + ' (' + otherPartial.st + ', stored data only)');
            else browserLines.push('- unavailablePartialDisplay: skipped (no stored partial/failed/needs_conversion source in this project)');
          }
        } finally {
          await browser.close();
        }
      }
    }
    for (const line of browserLines) recLines.push(line);
    let exactRevisionRecordsPreserved = 0, revisionRowsReadAfter = 0, revisionCallsAfter = 0, revisionCallCountsUnknownAfter = 0, claimRowsAfter = 0;
    for (const source of scoped) {
      const rev = source.currentRevisionId;
      const beforeRecord = revisionRecordsBefore.get(rev);
      assert(beforeRecord, 'Native-only run needs an exact before snapshot for ' + source.originalFilename + '.');
      const afterBody = await getUnderstanding(source.id, rev);
      const afterRecord = storedRevisionSnapshot(afterBody, 'native-only after ' + source.originalFilename);
      revisionRowsReadAfter++;
      if (typeof afterRecord.calls === 'number') revisionCallsAfter += afterRecord.calls;
      else revisionCallCountsUnknownAfter++;
      claimRowsAfter += afterRecord.claimRows;
      if (recoveryUpdatedRevisions.has(rev)) {
        const beforeUsage = beforeRecord.body.report && beforeRecord.body.report.usage;
        const afterUsage = afterBody.report && afterBody.report.usage;
        assert(beforeUsage && typeof beforeUsage.calls === 'number' && typeof beforeUsage.tokenLimit === 'number', 'Recovery before snapshot must carry owning revision calls/tokenLimit.');
        assert(afterUsage && typeof afterUsage.calls === 'number' && typeof afterUsage.tokenLimit === 'number', 'Recovery after snapshot must carry owning revision calls/tokenLimit.');
        assert.deepEqual(afterUsage, beforeUsage, 'Storage-only recovery must preserve the owning revision usage record.');
      } else {
        assert.deepEqual(afterBody, beforeRecord.body, 'Native-only probes must preserve the exact owning revision record (' + source.originalFilename + ').');
        exactRevisionRecordsPreserved++;
      }
    }
    const settingsAfterNative = await apiJson('/api/settings');
    assert.equal(settingsAfterNative.status, 200, 'GET /api/settings must be 200 after native-only probes.');
    assert.deepEqual(settingsAfterNative.body.settings, storedSettings, 'Native-only probes must preserve the exact settings record.');
    const revisionCallsBefore = [...revisionRecordsBefore.values()].reduce((sum, record) => sum + (typeof record.calls === 'number' ? record.calls : 0), 0);
    const revisionCallCountsUnknownBefore = [...revisionRecordsBefore.values()].filter((record) => typeof record.calls !== 'number').length;
    const claimRowsBefore = [...revisionRecordsBefore.values()].reduce((sum, record) => sum + record.claimRows, 0);
    const md = ['# K3 native-only (storage, zero model calls)', '', '- project: ' + title, '- readable arxiv rows: ' + scoped.length + '/10 (no ingestion/conversion repeats)', '- owning revision rows before/after: ' + revisionRecordsBefore.size + '/' + revisionRowsReadAfter, '- exact unchanged revision records preserved: ' + exactRevisionRecordsPreserved + '/' + (scoped.length - [...recoveryUpdatedRevisions].filter((rev) => revisionRecordsBefore.has(rev)).length), '- owning revision claim rows before/after: ' + claimRowsBefore + '/' + claimRowsAfter, '- owning revision calls before/after (known subtotal): ' + revisionCallsBefore + '/' + revisionCallsAfter + '; unknown rows ' + revisionCallCountsUnknownBefore + '/' + revisionCallCountsUnknownAfter, '- settings record preserved: true', '- understandingRouteWired: ' + String(understandingWired), '- overviewRouteWired: ' + String(overviewWired), '- reader range self-check: 1 exact range', '- paid distillation: skipped (root opt-in required)', '- claim-mode C1-C4: skipped (separate root step; hard gate remains open)', '- fullK3Accepted: false', ''].concat(recLines).concat(['']).join(EOL);
  await writeFile(outDir + '/k3-native-' + Date.now() + '.md', md);
  console.log(md);
  }
  process.exit(0);
}
if (!runModel) {
  const violations = [];
  const sRows = [];
  let sCalls = 0;
  let sCallRowsUnknown = 0;
  let sClaimRows = 0;
  const storedRevisionRecordsBefore = new Map();
  const byFile = new Map();
  if (!understandingWired) violations.push('understanding route skipped (404)');
  if (!overviewWired) violations.push('overview route skipped (404)');
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
      const record = storedRevisionSnapshot(u, 'stored-only ' + s.originalFilename);
      storedRevisionRecordsBefore.set(rev, record);
      if (typeof record.calls === 'number') sCalls += record.calls;
      else sCallRowsUnknown++;
      sClaimRows += record.claimRows;
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
      for (const g of [...numericsUnsupported(c.quote, c.valueText, c.valueNumber, c.statement, c.conditions), ...compoundResultUnsupported(c)]) violations.push(s.originalFilename + ': numeric ' + g + ' unsupported by quote');
      fileQuotes.push({ quote: c.quote, statement: c.statement });
    }
    byFile.set(s.originalFilename, fileQuotes);
    const rep = u.report;
    const record = storedRevisionSnapshot(u, 'stored-only ' + s.originalFilename);
    storedRevisionRecordsBefore.set(rev, record);
    sCalls += record.calls;
    sClaimRows += record.claimRows;
    if (!rep || typeof rep !== 'object') {
      violations.push(s.originalFilename + ': terminal state without direct report');
    } else {
      for (const kk of ['calls', 'inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'wallMs']) if (typeof rep.usage?.[kk] !== 'number') violations.push(s.originalFilename + ': owning revision usage.' + kk + ' not numeric');
      if (typeof rep.kept !== 'number') violations.push(s.originalFilename + ': kept not a number');
      if (!Array.isArray(rep.dropped)) violations.push(s.originalFilename + ': dropped not an array');
      if (typeof rep.clearedNumbers !== 'number') violations.push(s.originalFilename + ': clearedNumbers not a number');
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
  let revisionRecordsAfterCount = 0, sCallsAfter = 0, sCallRowsUnknownAfter = 0, sClaimRowsAfter = 0, exactRevisionRowsPreserved = 0;
  for (const [rev, beforeRecord] of storedRevisionRecordsBefore) {
    const source = scoped.find((entry) => entry.currentRevisionId === rev);
    assert(source, 'Each stored revision snapshot must retain its owning source row.');
    let afterBody;
    try { afterBody = await getUnderstanding(source.id, rev); }
    catch (error) {
      violations.push(source.originalFilename + ': owning revision reread failed: ' + String((error && error.message) || error));
      continue;
    }
    const afterRecord = storedRevisionSnapshot(afterBody, 'stored-only reread ' + source.originalFilename);
    revisionRecordsAfterCount++;
    if (JSON.stringify(afterRecord.body) !== JSON.stringify(beforeRecord.body)) violations.push(source.originalFilename + ': exact owning revision record changed during read-only validation');
    else exactRevisionRowsPreserved++;
    if (typeof afterRecord.calls === 'number') sCallsAfter += afterRecord.calls;
    else sCallRowsUnknownAfter++;
    sClaimRowsAfter += afterRecord.claimRows;
  }
  const settingsAfterStored = await apiJson('/api/settings');
  assert.equal(settingsAfterStored.status, 200, 'GET /api/settings must be 200 after stored validation.');
  assert(settingsAfterStored.body && settingsAfterStored.body.settings, 'GET /api/settings must retain its settings record.');
  if (JSON.stringify(settingsAfterStored.body.settings) !== JSON.stringify(settingsForRun.body.settings)) violations.push('settings record changed during stored validation');
  {
    const ct = process.env.ELIOT_K3_CLAIM_PROJECT;
    const cl = process.env.ELIOT_K3_CLAIM_CHAT;
    if (!ct || !cl) violations.push('claim-mode C1-C4 skipped: no verified claim-mode turns (separate root step)');
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
        assert(cproj, 'K3 claim-mode skipped: claim project not found: ' + ct);
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
        assert(cchat, 'K3 claim-mode skipped: claim chat not found (read-only stored run creates nothing): ' + cl);
        const cr = await apiJson('/api/projects/' + encodeURIComponent(cproj.id) + '/chats/' + encodeURIComponent(cchat.id));
        assert.equal(cr.status, 200, 'GET claim chat snapshot must be 200.');
        assert(Array.isArray(cr.body.turns), 'GET claim chat must return stored turn rows.');
        const cturns = cr.body.turns;
        for (let qi = 0; qi < CLAIM_ORDER.length; qi++) {
          const tag = CLAIM_ORDER[qi];
          const t = cturns.find((x) => x && x.question === CLAIM_QUESTIONS[qi] && x.state === 'completed' && x.scopeMode === 'explicit' && Array.isArray(x.revisionIds) && x.revisionIds.slice().sort().join(',') === ckey) || null;
          assert(t, 'K3 claim-mode ' + tag + ' skipped: no completed exact-scope stored turn (read-only, no POST).');
          await assertClaimTurnReadOnly(t, tag, cset, ckey);
        }
        const cr2 = await apiJson('/api/projects/' + encodeURIComponent(cproj.id) + '/chats/' + encodeURIComponent(cchat.id));
        assert.equal(cr2.status, 200, 'GET claim chat after stored validation must be 200.');
        assert(Array.isArray(cr2.body.turns), 'GET claim chat after stored validation must return turn rows.');
        assert.deepEqual(cr2.body.turns, cturns, 'Read-only claim validation must preserve exact stored turn records and row count.');
      } catch (e) {
        violations.push('claim-mode stored: ' + String((e && e.message) || e).split('\n')[0]);
      }
    }
  }
  const md = ['# K3 stored hard-gate validation (zero paid calls)', '', '- project: ' + title, '- owning revision rows before/after: ' + storedRevisionRecordsBefore.size + '/' + revisionRecordsAfterCount + '; exact records preserved: ' + exactRevisionRowsPreserved, '- owning revision claim rows before/after: ' + sClaimRows + '/' + sClaimRowsAfter, '- owning revision calls before/after: ' + sCalls + '/' + sCallsAfter + '; unknown rows ' + sCallRowsUnknown + '/' + sCallRowsUnknownAfter, '- chat settings record preserved: ' + String(JSON.stringify(settingsAfterStored.body.settings) === JSON.stringify(settingsForRun.body.settings)), '- fullK3Accepted: false', '- violations: ' + violations.length, '', '| source | state | claims | mode |', '|---|---|---|---|'].concat(sRows).concat(['', '## Violations / open gates', '']).concat(violations.map((v) => '- ' + v)).concat(['']).join(EOL);
  await writeFile(outDir + '/k3-stored-' + Date.now() + '.md', md);
  console.log(md);
  assert.equal(violations.length, 0, 'K3 MAP hard gates OPEN: ' + violations.length);
  process.exit(0);
}
assert(understandingWired, 'K3 preparation requires the understanding route; do not re-ingest.');
assert(overviewWired, 'K3 preparation requires the overview route.');
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
let distillCalls = 0;
const paidByFile = new Map();
const postedRevisions = new Set();
const firstPass = new Map();
let admit = true;
let newTokens = 0;
{
  const blocked = [];
  for (const s of scoped) {
    const u = await getUnderstanding(s.id, s.currentRevisionId);
    revisionRecordsBefore.set(s.currentRevisionId, storedRevisionSnapshot(u, 'paid-run preflight ' + s.originalFilename));
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
    const p = await apiJson('/api/sources/' + encodeURIComponent(s.id) + '/understanding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: rev, model: SELECTED_DISTILL_MODEL }) });
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
  if (u.state === 'paused') { pausedRevs.push(s.originalFilename); rows.push('| ' + s.originalFilename + ' | paused | - | admission blocked, operator action, no retry |'); return; }
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
    assert.deepEqual([...numericsUnsupported(c.quote, c.valueText, c.valueNumber, c.statement, c.conditions), ...compoundResultUnsupported(c)], [], 'Every numeric group must occur whole in its exact quote (' + s.originalFilename + ').');
    fileQuotes.push({ quote: c.quote, statement: c.statement });
  }
  paidByFile.set(s.originalFilename, fileQuotes);
  assert(u.report && typeof u.report === 'object', 'Terminal understanding must carry direct report (done/partial) (' + s.originalFilename + ').');
  const rep = u.report;
  const storedUsage = rep.usage || {};
  const usage = {
    calls: storedUsage.calls,
    inputTokens: storedUsage.inputTokens,
    cachedTokens: storedUsage.cachedTokens,
    outputTokens: storedUsage.outputTokens,
    tokenLimit: storedUsage.tokenLimit,
    wallMs: storedUsage.wallMs,
  };
  for (const kk of ['calls', 'inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'wallMs']) assert(typeof usage[kk] === 'number', 'report.usage.' + kk + ' must be numeric owning-revision usage (' + s.originalFilename + ').');
  assert(usage.calls >= 0 && usage.calls <= 2, 'report.usage.calls bounded 0-2 (' + s.originalFilename + ').');
  assert(Array.isArray(rep.questions) && rep.questions.length >= 3, 'report.questions (3-5 guide questions) required (' + s.originalFilename + ').');
  assert(typeof rep.kept === 'number', 'report.kept must be a number (' + s.originalFilename + ').');
  assert(Array.isArray(rep.dropped), 'report.dropped must be an array of {index,reason} (' + s.originalFilename + ').');
  assert(typeof rep.clearedNumbers === 'number', 'report.clearedNumbers must be a number (' + s.originalFilename + ').');
  distillCalls += usage.calls;
  if (postedRevisions.has(rev)) newTokens += usage.inputTokens + usage.outputTokens;
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
  rows.push('| ' + s.originalFilename + ' | ' + u.state + ' | ' + claims.length + ' | ' + usage.calls + ' | ' + usage.inputTokens + '/' + usage.cachedTokens + '/' + usage.outputTokens + ' | ' + usage.tokenLimit + ' | ' + usage.wallMs + ' |');
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
let revisionCallsAfter = 0, revisionCallRowsUnknownAfter = 0, revisionClaimRowsAfter = 0, revisionRowsReadAfter = 0, terminalSnapshotsStable = 0;
const revisionCallsBefore = [...revisionRecordsBefore.values()].reduce((sum, record) => sum + (typeof record.calls === 'number' ? record.calls : 0), 0);
const revisionCallRowsUnknownBefore = [...revisionRecordsBefore.values()].filter((record) => typeof record.calls !== 'number').length;
const revisionClaimRowsBefore = [...revisionRecordsBefore.values()].reduce((sum, record) => sum + record.claimRows, 0);
try {
  for (const s of scoped) {
    const rev = s.currentRevisionId;
    const u = await getUnderstanding(s.id, rev);
    const currentRecord = storedRevisionSnapshot(u, 'paid-run after ' + s.originalFilename);
    revisionRowsReadAfter++;
    if (typeof currentRecord.calls === 'number') revisionCallsAfter += currentRecord.calls;
    else revisionCallRowsUnknownAfter++;
    revisionClaimRowsAfter += currentRecord.claimRows;
    const beforeRecord = revisionRecordsBefore.get(rev);
    if (!beforeRecord) { unbased.push(s.originalFilename + ': no exact preflight revision record was captured'); continue; }
    const snap = firstPass.get(rev);
    if (!snap) {
      if (!postedRevisions.has(rev)) {
        if (JSON.stringify(u) !== JSON.stringify(beforeRecord.body)) changed.push(s.originalFilename + ': exact owning revision record moved without a POST');
        else terminalSnapshotsStable++;
      } else if (u.state !== 'failed' && u.state !== 'paused') {
        changed.push(s.originalFilename + ': posted revision has no stable terminal record snapshot');
      }
      continue;
    }
    if (!postedRevisions.has(rev) && JSON.stringify(u) !== JSON.stringify(beforeRecord.body)) changed.push(s.originalFilename + ': exact stored revision record changed without a POST');
    const current = snapOf(u);
    if (!current || JSON.stringify(current) !== JSON.stringify(snap)) changed.push(s.originalFilename + ': exact owning revision report/claim rows changed after the terminal read');
    else terminalSnapshotsStable++;
  }
} catch (e) {
  tailV.push('Second storage pass read failed: ' + String((e && e.message) || e).split('\n')[0]);
}
if (changed.length > 0) tailV.push('Second storage pass changed (' + changed.length + '): ' + changed.join('; '));
if (unbased.length > 0) tailV.push('Second storage pass missing baselines (' + unbased.length + '): ' + unbased.join('; '));
if (failedRevs.length > 0) tailV.push('Failed revisions (no auto retry): ' + failedRevs.join(', '));
if (pausedRevs.length > 0) tailV.push('Paused revisions need operator admission action: ' + pausedRevs.join(', '));
const missing = checkAnchors(paidByFile);
if (missing.length > 0) tailV.push('Missing anchors (reported, not weakened): ' + missing.join(', '));
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
const settingsAfterRun = await apiJson('/api/settings');
if (settingsAfterRun.status !== 200 || !settingsAfterRun.body || !settingsAfterRun.body.settings) tailV.push('Stored settings reread unavailable after K3 work.');
else if (JSON.stringify(settingsAfterRun.body.settings) !== settingsBeforeRun) tailV.push('Stored settings changed during K3 work.');
const md = ['# K3 Distill eval', '', '- project: ' + title + ' (10 arxiv, no re-ingest)', '- POSTed revisions this run: ' + posted + ' (second scan needs 0)', '- owning revision rows before/after: ' + revisionRecordsBefore.size + '/' + revisionRowsReadAfter, '- owning revision claim rows before/after: ' + revisionClaimRowsBefore + '/' + revisionClaimRowsAfter, '- owning revision calls before/after (known subtotal): ' + revisionCallsBefore + '/' + revisionCallsAfter + '; unknown rows ' + revisionCallRowsUnknownBefore + '/' + revisionCallRowsUnknownAfter, '- exact owning revision records stable on reread: ' + terminalSnapshotsStable + '/' + revisionRowsReadAfter, '- calls this run: ' + distillCalls + '; input/output tokens on posted revision records: ' + newTokens, '- settings record preserved: ' + String(settingsAfterRun.status === 200 && JSON.stringify(settingsAfterRun.body?.settings) === settingsBeforeRun), '- claim-mode C1-C4: skipped (hard gate remains open)', '- fullK3Accepted: false', '- overview: membership + deterministic re-read required; see Open gates', '', '| source | state | claims | calls | in/cached/out | tokenLimit | wall_ms |', '|---|---|---|---|---|---|---|'].concat(rows).concat(['', '## Open gates']).concat(tailV.length > 0 ? tailV.map((v) => '- ' + v) : ['- none']).concat(['']).join(EOL);
console.log(md);
await writeFile(outDir + '/k3-' + Date.now() + '.md', boundReport + EOL + EOL + md);
const claimTitle = process.env.ELIOT_K3_CLAIM_PROJECT;
const claimChatLoc = process.env.ELIOT_K3_CLAIM_CHAT;
const claimV = [];
if (!claimTitle || !claimChatLoc) claimV.push('claim-mode C1-C4 skipped: the root has not supplied the larger dataset and prepared claim chat; no paid calls made here.');
else {
  let claimProj = null, cc = undefined;
  for (let i = 0; i < 5 && !claimProj; i++) {
    const pg = await apiJson('/api/projects' + (cc ? '?cursor=' + encodeURIComponent(cc) : ''));
    assert.equal(pg.status, 200, 'GET /api/projects must be 200.');
    claimProj = (pg.body.projects || []).find((x) => x && x.title === claimTitle) || null;
    cc = pg.body.nextCursor || undefined;
    if (!cc) break;
  }
  if (!claimProj) claimV.push('claim-mode C1-C4 skipped: claim project not found: ' + claimTitle);
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
    const sizeTokens = cread.reduce((n, s) => n + (typeof s.readableSize === 'number' ? s.readableSize : 0) / 3, 0);
    const answerOverflowReserve = answerMeta.maxOutputTokens ?? answerMeta.outputReserveTokens;
    assert(Number.isSafeInteger(answerOverflowReserve) && answerOverflowReserve > 0, 'Selected answerModel output reserve must be known for whole-cap.');
    if (!(sizeTokens + answerOverflowReserve > Math.min(0.6 * answerMeta.contextTokens, 400000))) claimV.push('Claim scope must overflow whole mode (UTF8/3 + output reserve > min(0.6*ctx,400k)).');
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
        assert(!/^[0-9a-fA-F-]{36}$/.test(claimChatLoc), 'claim-mode skipped: claim chat ID was not found: ' + claimChatLoc);
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
      assert(Array.isArray(r.body.turns), 'GET claim chat snapshot must return stored turn rows.');
      return r.body.turns;
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
          const p = await apiJson('/api/projects/' + encodeURIComponent(claimProj.id) + '/chats/' + encodeURIComponent(chat.id) + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000), body: JSON.stringify({ turnId: crypto.randomUUID(), question: q, scopeMode: 'explicit', sourceIds: srcIds, model: SELECTED_ANSWER_MODEL }) });
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
    const claimMd = ['# K3 claim-mode C1-C4 (whole-overflow scope, zero mode forcing)', '', '- project: ' + claimTitle, '- chat: ' + (chat.title || chat.id), '- posted turns this run: ' + postedTurns + ' (max 4, one per question)', '- scope revisions: ' + cread.length, '- model: ' + SELECTED_ANSWER_MODEL, '- fullK3Accepted: false', '- violations: ' + claimV.length, ''].join(EOL);
    console.log(claimMd);
    await writeFile(outDir + '/k3-claim-' + Date.now() + '.md', claimMd);
  }
}
const finalViolations = [...tailV, ...claimV];
assert.equal(finalViolations.length, 0, [
  ...(tailV.length ? ['K3 paid tail gates OPEN (' + tailV.length + '): ' + tailV.join('; ')] : []),
  ...(claimV.length ? ['K3 claim-mode hard gate skipped/open: ' + claimV.join('; ')] : []),
].join('\n'));
