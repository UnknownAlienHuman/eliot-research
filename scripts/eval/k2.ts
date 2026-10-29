import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertEvalOrigin, assertEvalBrowserOrigin, fetchEval } from './origin.mjs';
import { uncitedStatements, unsupportedNumericStatements } from '../../src/citations.ts';
const EOL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const BACKSLASH = String.fromCharCode(92);
const BT = String.fromCharCode(96);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const UNIMINUS = String.fromCodePoint(0x2212);
const MIDDOT = String.fromCodePoint(0x00B7);
const SUPER_DIGITS = new Set(Array.from('⁰¹²³⁴⁵⁶⁷⁸⁹'));
const REQUIRED_PROVIDER_IDS = ['workers-ai', 'openrouter', 'command-code', 'kilo', 'nous', 'opencode-go'];
const ADDED_PROVIDER_IDS = ['command-code', 'kilo', 'nous', 'opencode-go'];
const DISABLED_DEFAULT_PROVIDER_IDS = ['kilo', 'nous', 'opencode-go'];
const staticSelftest = process.argv.includes('--static-selftest');
const nativeOnly = process.argv.includes('--native-only');
const storedOnly = process.argv.includes('--stored-only');
const modelsOnly = process.argv.includes('--models-only');
const runModel = !staticSelftest && !nativeOnly && process.env.ELIOT_K2_MODEL === '1';
const requestedOrigin = staticSelftest ? 'http://127.0.0.1:5173' : process.env.ELIOT_URL || 'http://127.0.0.1:5173';
const configuredOrigin = staticSelftest ? undefined : process.env.ELIOT_ORIGIN;
const origin = staticSelftest ? null : assertEvalOrigin(requestedOrigin, configuredOrigin);
const H = staticSelftest ? {} : { Origin: origin };
if (!staticSelftest && !modelsOnly && process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (!staticSelftest && !modelsOnly && process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
if (modelsOnly && !staticSelftest) {
  assertEvalBrowserOrigin(origin, configuredOrigin);
  assert(process.env.ELIOT_K2_MODEL !== '1', '--models-only forbids ELIOT_K2_MODEL opt-in.');
}
const resumeChat = staticSelftest || modelsOnly ? null : process.env.ELIOT_EVAL_CHAT || null;
const evalModelOverride = staticSelftest || modelsOnly ? null : (process.env.ELIOT_EVAL_MODEL ?? '').trim() || null;
assert(!storedOnly || (!!resumeChat && !runModel && !modelsOnly), '--stored-only requires an existing chat and forbids model dispatch/catalogue tests.');
assert(!runModel || evalModelOverride === null, 'K2 benchmark uses the frozen global configured default; ELIOT_EVAL_MODEL overrides are disabled.');
const evalDir = fileURLToPath(new URL('../../eval/', import.meta.url));
const outDir = fileURLToPath(new URL('../../eval/out/k2/', import.meta.url));
const notebookAnswersPath = staticSelftest || modelsOnly ? '' : (process.env.ELIOT_K2_NOTEBOOKLM_ANSWERS ?? '').trim()
  || fileURLToPath(new URL('../../eval/out/notebooklm-20261026/answers.md', import.meta.url));
const order = ['C1', 'C2', 'C3', 'C4', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8'];
if (!staticSelftest) await mkdir(outDir, { recursive: true });
async function apiJson(path, init) {
  // Finite READ default (30s observer bound); explicit caller signal (e.g. 90s POST) is preserved verbatim.
  const readSignal = init && init.signal ? init.signal : AbortSignal.timeout(30000);
  const r = await fetchEval(origin + path, { ...init, signal: readSignal, headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) } }, origin, configuredOrigin);
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: t.slice(0, 300) }; }
  return { status: r.status, body: b };
}
async function apiBytes(path, init) {
  // Same finite READ default for range/text GETs; explicit caller signal preserved verbatim.
  const readSignal = init && init.signal ? init.signal : AbortSignal.timeout(30000);
  const r = await fetchEval(origin + path, { ...init, signal: readSignal, headers: { ...H, ...((init && init.headers) || {}) } }, origin, configuredOrigin);
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
}
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function assertProviderConfigs(providers, source, requireExactIds = false) {
  assert(Array.isArray(providers), source + ' must be a provider array.');
  const byId = new Map();
  for (const provider of providers) {
    assert(provider && typeof provider === 'object' && !Array.isArray(provider), source + ' entries must be objects.');
    assert(typeof provider.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider.id), source + ' provider IDs must be valid.');
    assert(!byId.has(provider.id), source + ' provider IDs must be unique (' + provider.id + ').');
    assert(['workers-ai', 'openai-compatible'].includes(provider.type), source + ' provider type must be supported (' + provider.id + ').');
    assert(typeof provider.enabled === 'boolean', source + ' enabled must be boolean (' + provider.id + ').');
    assert(typeof provider.gatewayPath === 'string' && /^(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/.test(provider.gatewayPath), source + ' Gateway path must be valid (' + provider.id + ').');
    if (provider.type === 'workers-ai') {
      assert.equal(provider.id, 'workers-ai', source + ' native binding must use its stable provider ID.');
      assert.equal(provider.baseUrl, null, source + ' native binding must not have a base URL.');
      assert.equal(provider.gatewaySlug, null, source + ' native binding must not have a Gateway slug.');
      assert.equal(provider.gatewayPath, '', source + ' native binding must not have a Gateway path.');
      assert.equal(provider.modelsUrl, undefined, source + ' native binding must not have a models URL.');
      assert.equal(provider.metadataUrl, undefined, source + ' native binding must not have a metadata URL.');
    } else {
      assert(provider.id !== 'workers-ai', source + ' cannot route a compatible provider through the native ID.');
      assert(typeof provider.baseUrl === 'string', source + ' compatible providers need an HTTPS base URL (' + provider.id + ').');
      let baseUrl;
      try { baseUrl = new URL(provider.baseUrl); } catch { assert.fail(source + ' compatible provider base URL must be valid (' + provider.id + ').'); }
      assert.equal(baseUrl.protocol, 'https:', source + ' compatible provider base URL must use HTTPS (' + provider.id + ').');
      assert.equal(baseUrl.username, '', source + ' provider URLs must not contain credentials (' + provider.id + ').');
      assert.equal(baseUrl.password, '', source + ' provider URLs must not contain credentials (' + provider.id + ').');
      assert.equal(baseUrl.search, '', source + ' provider URLs must not contain a query (' + provider.id + ').');
      assert.equal(baseUrl.hash, '', source + ' provider URLs must not contain a fragment (' + provider.id + ').');
      assert(typeof provider.gatewaySlug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider.gatewaySlug), source + ' compatible providers need a valid Gateway slug (' + provider.id + ').');
      for (const field of ['modelsUrl', 'metadataUrl']) {
        const endpoint = provider[field];
        if (endpoint === undefined) continue;
        assert(typeof endpoint === 'string', source + ' ' + field + ' must be a URL when present (' + provider.id + ').');
        let endpointUrl;
        try { endpointUrl = new URL(endpoint); } catch { assert.fail(source + ' ' + field + ' must be a valid URL (' + provider.id + ').'); }
        assert.equal(endpointUrl.protocol, 'https:', source + ' ' + field + ' must use HTTPS (' + provider.id + ').');
        assert.equal(endpointUrl.username, '', source + ' ' + field + ' must not contain credentials (' + provider.id + ').');
        assert.equal(endpointUrl.password, '', source + ' ' + field + ' must not contain credentials (' + provider.id + ').');
        assert.equal(endpointUrl.search, '', source + ' ' + field + ' must not contain a query (' + provider.id + ').');
        assert.equal(endpointUrl.hash, '', source + ' ' + field + ' must not contain a fragment (' + provider.id + ').');
      }
    }
    byId.set(provider.id, provider);
  }
  for (const id of REQUIRED_PROVIDER_IDS) assert(byId.has(id), source + ' must preserve required provider ID ' + id + '.');
  if (requireExactIds) assert.deepEqual([...byId.keys()].sort(), [...REQUIRED_PROVIDER_IDS].sort(), source + ' must contain exactly the six expected provider IDs.');
  return byId;
}
function normMath(s) {
  const chars = Array.from(String(s));
  for (let i = 1; i + 1 < chars.length; i++) {
    if (chars[i] === MIDDOT && SUPER_DIGITS.has(chars[i - 1]) && SUPER_DIGITS.has(chars[i + 1])) chars[i] = '.';
  }
  let n = chars.join('').normalize('NFKC').replace(/\[(?:S\d+|R[0-9a-f-]{36}):\d+\]/gi, ' ').toLowerCase().replace(/\bstep_num\b/g, 'step').replace(/\bwarmup_steps\b/g, 'warmup').split(',').join('.');
  n = n.split(UNIMINUS).join('-');
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
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), hard: true, detail });
  if (typeof ans !== 'string' || !ans.trim()) return [{ name: 'answer present', passed: false, hard: true, detail: 'No answer text was stored.' }];
  if (qid === 'C1') {
    add('d_model=512', m.includes('512'), 'Expected Transformer base model d_model 512.');
    const w = m.split(' ');
    let heads8 = /\bh\s*=\s*8(?!\d)/u.test(m) || /(?:голов[а-яё]*|heads?)[^.!?\n]{0,70}\b8\b|\b8\b[^.!?\n]{0,70}(?:голов[а-яё]*|heads?)/iu.test(m);
    for (let i = 0; i < w.length && !heads8; i++) {
      if (w[i] === '8' && i > 0 && (String(w[i - 1]).includes('head') || String(w[i - 1]).includes('голов'))) heads8 = true;
      if (w[i] === '8' && i + 1 < w.length && (String(w[i + 1]).includes('head') || String(w[i + 1]).includes('голов'))) heads8 = true;
    }
    add('attention heads=8', heads8 || m.includes(' восемь ') || m.includes(' eight '), 'Expected eight attention heads.');
  }
  if (qid === 'C2') {
    const warmup4000 = /(?:\b(?:warmup|warm-up|warm up)\b|разогрев|прогрев|размин[а-яё]*)[\s\S]{0,40}\b4000\b|\b4000\b[\s\S]{0,40}(?:\b(?:warmup|warm-up|warm up)\b|разогрев|прогрев|размин[а-яё]*)/iu.test(m);
    const strictFormula = warmup4000 && /\bd model\s*-0\.5\b[\s\S]{0,120}\bmin\b[\s\S]{0,100}\bstep\s*-0\.5\b[\s\S]{0,80}\bstep\b[\s\S]{0,100}\bwarmup\s*-1\.5\b/u.test(m);
    const sqrtModelExponent = /\bd model\s*-0\.5\b|\bd model\s*-1\/2\b|1\s*\/\s*sqrt\s+d model|sqrt\s+d model\s*-1\b/u.test(m);
    const sqrtStepExponent = /\bstep\s*-0\.5\b|\bstep\s*-1\/2\b|1\s*\/\s*sqrt\s+step|sqrt\s+step\s*-1\b/u.test(m);
    const sqrtWarmupExponent = /\bwarmup\s*-1\.5\b|\bwarmup\s*-3\/2\b|\/\s*warmup\s+(?:1\.5|3\/2)\b/u.test(m);
    const sqrtFormula = m.includes('sqrt') && warmup4000 && /\bmin\b/u.test(m)
      && sqrtModelExponent && sqrtStepExponent && sqrtWarmupExponent;
    add('learning-rate formula and warmup=4000', strictFormula || sqrtFormula, 'Expected d_model^-0.5 min(step^-0.5, step·warmup^-1.5), warmup 4000, or an equivalent square-root expression.');
  }
  if (qid === 'C3') add('Adam defaults', has('0.001') && has('0.9') && has('0.999') && (has('1e-8') || m.includes('10 -8') || m.includes('10 - 8') || m.includes('10-8') || has('0.00000001')), 'Expected alpha=0.001, beta1=0.9, beta2=0.999 and epsilon=1e-8.');
  if (qid === 'C4') add('positional encoding contrast', (m.includes('синус') || m.includes('sinus')) && (m.includes('обуч') || m.includes('learn')), 'Expected sinusoidal versus learned positional encodings.');
  if (qid === 'O8') add('honest abstention', /нет в корпусе|в корпусе нет|не решают|не содержат|ни одн(?:а|ой|ого|у)|abstain|not in (the )?corpus|no paper/i.test(ans), 'Expected an answer that the corpus does not solve hallucinations.');
  if (['O1', 'O2', 'O3', 'O8'].includes(qid))
    checks.push({ name: 'semantic quality', ownerReviewRequired: true, detail: 'Gold facts are shown for owner review; the evaluator does not judge entailment or usefulness.' });
  else if (['O4', 'O5', 'O6', 'O7'].includes(qid))
    checks.push({ name: 'semantic coverage', passed: false, skipped: 'not automated', detail: 'Gold facts are shown; no automatic semantic judgment is made.' });
  return checks;
}
function assertC2StaticSelftests() {
  const c2 = (answer) => checkAnswer('C2', answer).find((check) => check.name === 'learning-rate formula and warmup=4000')?.passed;
  assert.equal(c2('d_model⁻⁰·⁵ · min(step⁻⁰·⁵, step · warmup⁻¹·⁵), warmup 4000'), true, 'Unicode superscript learning-rate formula must pass.');
  assert.equal(c2('1/sqrt(d_model) · min(1/sqrt(step), step/warmup^1.5), warmup 4000'), true, 'Equivalent square-root learning-rate formula must pass.');
  assert.equal(c2('d_model⁻⁰·⁶ · min(step⁻⁰·⁵, step · warmup⁻¹·⁵), warmup 4000'), false, 'Wrong d_model exponent must fail.');
  assert.equal(c2('d_model⁻⁰·⁵ · min(step⁻⁰·⁶, step · warmup⁻¹·⁵), warmup 4000'), false, 'Wrong step exponent must fail.');
  assert.equal(c2('d_model⁻⁰·⁵ · min(step⁻⁰·⁵, step · warmup⁻¹·⁴), warmup 4000'), false, 'Wrong warmup exponent must fail.');
  assert.equal(c2('d_model⁻⁰·⁶ · min(1/sqrt(step), step/warmup^1.5), warmup 4000'), false, 'Wrong model exponent in the square-root form must fail.');
  assert.equal(c2('1/sqrt(d_model) · min(1/sqrt(step), step/warmup^1.4), warmup 4000'), false, 'Wrong warmup exponent in the square-root form must fail.');
  assert.equal(c2('1/sqrt(d_model) · min(1/sqrt(step), step · warmup^1.5), warmup 4000'), false, 'Warmup to a positive exponent must be in the denominator.');
  assert.equal(c2('d_model⁻⁰·⁵ · min(step⁻⁰·⁵, step · warmup⁻¹·⁵), warmup 2000'), false, 'Wrong warmup value must fail.');
  assert.equal(c2('lrate = d_model⁻⁰·⁵ × min(step_num⁻⁰·⁵, step_num × warmup_steps⁻¹·⁵), warmup_steps 4000'), true, 'Original-paper step_num/warmup_steps identifiers must pass.');
  assert.equal(c2('d_model⁻⁰·⁵ · min(step_num⁻⁰·⁶, step_num · warmup_steps⁻¹·⁵), warmup_steps 4000'), false, 'Wrong step exponent must fail for step_num aliases.');
  assert.equal(c2('d_model⁻⁰·⁵ · min(step_num⁻⁰·⁵, step_num · warmup_steps⁻¹·⁵), warmup_steps 2000'), false, 'Wrong warmup value must fail for warmup_steps aliases.');
  assert(!normMath('2·3').includes('2.3'), 'An ordinary middle dot must not become a decimal point.');
}
function assertDispatchStopStaticSelftests() {
  assert.equal(dispatchUnavailable(404, { error: { code: 'not_found', message: 'External model request failed (HTTP 404). Check the Gateway connection and provider status; no retry was started.' } }, null), true, 'HTTP 404 response status must stop the batch.');
  assert.equal(dispatchUnavailable(200, { turn: { error: 'External model request failed (HTTP 404). Check the Gateway connection and provider status; no retry was started.' } }, null), true, 'Embedded HTTP 404 turn error must stop the batch.');
  assert.equal(dispatchUnavailable(200, null, { error: 'Partial answer stored; 2 unsupported numeric statements remain' }), false, 'Ordinary quality partial must not stop the batch.');
}
assertC2StaticSelftests();
assertDispatchStopStaticSelftests();
if (staticSelftest) {
  console.log('K2 evaluator static selftests passed.');
  process.exit(0);
}
const qmd = await readFile(evalDir + '/arxiv-10/questions.md', 'utf8');
const Q = new Map();
const goldFacts = new Map();
for (const line of qmd.split(EOL)) {
  const parts = line.split('|').map((part) => part.trim());
  if (parts.length >= 4 && order.includes(parts[1]) && parts[2]) {
    Q.set(parts[1], parts[2]);
    goldFacts.set(parts[1], parts[3]);
  }
}
assert.equal(Q.size, 12, 'questions.md must define C1-4 and O1-8.');
async function baselineNotebookSummaries() {
  const raw = await readFile(evalDir + '/arxiv-10/baseline.md', 'utf8');
  const answers = new Map();
  let inNotebookTable = false;
  for (const line of raw.split(EOL)) {
    if (/^##\s+Ответы Gemini Notebook/.test(line)) { inNotebookTable = true; continue; }
    if (inNotebookTable && /^##\s+/.test(line)) break;
    if (!inNotebookTable || !line.startsWith('|')) continue;
    const parts = line.split('|').map((part) => part.trim());
    if (order.includes(parts[1]) && parts[4]) answers.set(parts[1], parts[4]);
  }
  return answers;
}
function parseNotebookAnswers(raw) {
  const answers = new Map();
  let qid = null;
  let body = [];
  const save = () => { if (qid && body.join(EOL).trim()) answers.set(qid, body.join(EOL).trim()); };
  for (const line of raw.split(EOL)) {
    const heading = /^##\s+(C[1-4]|O[1-8])(?:\s|[-—])/.exec(line);
    if (heading) { save(); qid = heading[1]; body = []; continue; }
    if (qid) body.push(line);
  }
  save();
  return answers;
}
const baselineAnswers = await baselineNotebookSummaries();
let notebookAnswers = new Map();
let notebookAnswerSource = 'eval/arxiv-10/baseline.md (recorded summary)';
try {
  notebookAnswers = parseNotebookAnswers(await readFile(notebookAnswersPath, 'utf8'));
  if (notebookAnswers.size > 0) notebookAnswerSource = notebookAnswersPath;
} catch { /* use the tracked baseline summary below */ }
for (const qid of order) {
  if (!notebookAnswers.has(qid)) {
    notebookAnswers.set(qid, baselineAnswers.get(qid)
      || 'Baseline records this response as received and saved; no individual answer text is present in baseline.md.');
  }
}
const compareRows = new Map(order.map((qid) => [qid, {
  qid,
  answer: null,
  model: null,
  turnState: 'skipped',
  passed: false,
  ownerReviewRequired: false,
  skipped: 'no exact stored turn has been selected',
  factChecks: [],
  citationRanges: [],
  citationSummary: 'skipped',
  timing: null,
  usage: null,
  reason: null,
} ]));
function markQuestionSkipped(qid, reason, turnState = 'skipped') {
  compareRows.set(qid, { ...compareRows.get(qid), passed: false, ownerReviewRequired: false, skipped: reason, reason, turnState });
}
function mdCell(value) {
  return String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
}
async function writeCompare(rows, metadata) {
  const turnRows = order.map((qid) => rows.get(qid)).filter((row) => row && row.usage);
  const sumKnown = (field) => {
    const values = turnRows.map((row) => row.usage?.[field]).filter((value) => typeof value === 'number' && Number.isFinite(value));
    return { sum: values.reduce((total, value) => total + value, 0), unknown: turnRows.length - values.length, count: values.length };
  };
  const percentile = (values, p) => {
    const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return 'skipped';
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  };
  const firstTimes = turnRows.map((row) => row.timing?.firstTokenMs);
  const totalTimes = turnRows.map((row) => row.timing?.totalMs);
  const ranges = turnRows.flatMap((row) => Array.isArray(row.citationRanges) ? row.citationRanges : []);
  const numericCheckDetails = turnRows.flatMap((row) => Array.isArray(row.factChecks) ? row.factChecks : [])
    .filter((check) => check.name === 'numeric citation support').map((check) => check.detail || '');
  const unsupportedNumericCount = numericCheckDetails.reduce((total, detail) => total + (Number(/([0-9]+) unsupported/.exec(detail)?.[1]) || 0), 0);
  const uncitedCheckDetails = turnRows.flatMap((row) => Array.isArray(row.factChecks) ? row.factChecks : [])
    .filter((check) => check.name === 'uncited factual statements').map((check) => check.detail || '');
  const uncitedAdvisoryCount = uncitedCheckDetails.reduce((total, detail) => total + (Number(/([0-9]+) found/.exec(detail)?.[1]) || 0), 0);
  const inputs = sumKnown('inputTokens'), cached = sumKnown('cachedTokens'), outputs = sumKnown('outputTokens');
  const limits = sumKnown('tokenLimit');
  const lines = [
    '# K2 — Eliot / NotebookLM comparison',
    '',
    '- Questions and gold facts: `eval/arxiv-10/questions.md` (read-only).',
    '- NotebookLM answer source: ' + mdCell(notebookAnswerSource) + '.',
    '- Eliot mode: ' + mdCell(metadata.mode) + '.',
    '- Effective eval target: ' + mdCell(metadata.target ?? origin ?? 'UNKNOWN') + '.',
    '- Configured global answer model: ' + mdCell(metadata.defaultModel ?? 'UNKNOWN') + '.',
    '- Project answer-model override: ' + mdCell(metadata.projectModelOverride ?? 'none') + '.',
    '- Chat: ' + mdCell(metadata.chatId ?? 'UNKNOWN') + '.',
    '- Stored turn rows before/after: ' + (metadata.turnCountBefore ?? 'unknown') + '/' + (metadata.turnCountAfter ?? 'unknown') + '; original records preserved: ' + String(metadata.originalTurnRecordsPreserved === true) + '.',
    '- Turn records with usage: ' + turnRows.length + ' / 12.',
    '- Per-turn usage totals: input ' + inputs.sum + ' (' + inputs.unknown + ' unknown), cached ' + cached.sum + ' (' + cached.unknown + ' unknown), output ' + outputs.sum + ' (' + outputs.unknown + ' unknown), tokenLimit ' + limits.sum + ' (' + limits.unknown + ' unknown).',
    '- Latency sample n=' + turnRows.filter((row) => typeof row.timing?.firstTokenMs === 'number' && typeof row.timing?.totalMs === 'number').length + ' ms: first p50/p95 ' + percentile(firstTimes, 0.50) + '/' + percentile(firstTimes, 0.95) + '; total p50/p95 ' + percentile(totalTimes, 0.50) + '/' + percentile(totalTimes, 0.95) + '.',
    '- Exact citation ranges checked: ' + ranges.filter((range) => range.passed === true).length + '/' + ranges.length + '; failed ' + ranges.filter((range) => range.passed === false).length + '.',
    '- Unsupported numeric statements (advisory WARN, not a hard gate): ' + unsupportedNumericCount + '.',
    '- Uncited factual statements (advisory WARN, not a hard gate): ' + uncitedAdvisoryCount + '.',
    '- Actual Eliot turn model is shown per row; non-default stored answers are diagnostic only.',
    '- Owner semantic gate required: ' + String(metadata.ownerReviewRequired === true) + '; this report does not judge meaning.',
    '- Hard checks passed: ' + String(metadata.hardChecksPassed === true) + (metadata.stopReason ? ' — ' + mdCell(metadata.stopReason) : ''),
    '- Full K2 accepted: false (this report is scoped evidence only).',
    '',
    '| # | Turn ID | Question | Gold facts | NotebookLM answer | Eliot answer | Model / state | Checks passed | ownerReviewRequired | Fact checks | Citation ranges / quotes | Time / usage |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const qid of order) {
    const row = rows.get(qid) || {};
    const checkParts = Array.isArray(row.factChecks) ? row.factChecks.map((check) => {
      const value = check.ownerReviewRequired ? 'ownerReviewRequired' : check.skipped ? 'skipped' : String(check.passed === true);
      return check.name + ': ' + value + (check.detail ? ' (' + check.detail + ')' : '');
    }) : [];
    if (Array.isArray(row.hardFailures)) checkParts.push(...row.hardFailures);
    if (row.reason && !row.skipped) checkParts.push(row.reason);
    if (row.skipped) checkParts.push('skipped: ' + row.skipped);
    const factText = checkParts.length ? checkParts.join('; ') : 'skipped';
    const rangeText = Array.isArray(row.citationRanges) && row.citationRanges.length
      ? row.citationRanges.map((r) => r.label + ' ' + r.revisionId + ':' + r.block + '[' + r.start + ',' + r.end + ') ' + String(r.passed === true) + (r.skipped ? ' skipped' : '') + (r.reason ? ' (' + r.reason + ')' : '') + (r.quote ? ' quote=' + r.quote : '')).join('<br>')
      : row.citationSummary ?? 'skipped';
    const usage = row.usage ? [row.usage.inputTokens, row.usage.cachedTokens, row.usage.outputTokens].map((v) => v ?? 'UNKNOWN').join('/')
      + ' tok; limit ' + (row.usage.tokenLimit ?? 'UNKNOWN')
      : 'skipped';
    const time = row.timing ? 'first ' + (row.timing.firstTokenMs ?? 'UNKNOWN') + ' ms / total ' + (row.timing.totalMs ?? 'UNKNOWN') + ' ms'
      + (row.timing.wallMs === null || row.timing.wallMs === undefined ? '' : ' / wall ' + row.timing.wallMs + ' ms') : 'skipped';
    lines.push('| ' + [qid, row.turnId ?? 'skipped', Q.get(qid), goldFacts.get(qid), notebookAnswers.get(qid), row.answer ?? 'skipped',
      (row.model ?? 'unknown') + ' [' + (row.routeStatus ?? 'unknown-route') + '] / ' + (row.turnState ?? 'skipped'), String(row.passed === true), String(row.ownerReviewRequired === true), factText, rangeText, time + '; ' + usage]
      .map(mdCell).join(' | ') + ' |');
  }
  lines.push('');
  await writeFile(outDir + '/compare.md', lines.join(EOL) + EOL);
  console.log('K2 compare written: ' + outDir + '/compare.md (' + order.length + ' rows; hardChecksPassed=' + String(metadata.hardChecksPassed === true) + ').');
}
const me = await apiJson('/api/me');
assert.equal(me.status, 200, 'GET /api/me must be 200; start pnpm dev first.');
assert.equal(me.body.actor.type, 'owner', 'Eval must run as owner.');
if (process.argv.includes('--models-only')) {
  // Catalog/storage checks only. Never dispatches a model turn; the isolated UI Gateway roundtrip restores blank.
  const before = await apiJson('/api/settings');
  const providersBefore = await apiJson('/api/models/providers');
  assert.equal(providersBefore.status, 200, 'GET /api/models/providers must be 200.');
  const providerConfigs = assertProviderConfigs(providersBefore.body?.providers, 'Stored provider configuration', true);
  for (const id of DISABLED_DEFAULT_PROVIDER_IDS) assert.equal(providerConfigs.get(id).enabled, false, 'New provider defaults stay disabled pending explicit Gateway setup (' + id + ').');
  let providerCrud = { skipped: true };
  const connection = await apiJson('/api/models/connection');
  assert.equal(before.status, 200);
  assert.equal(connection.status, 200);
  assert.equal(connection.body.connection.gatewayId, null, 'Use a disconnected local namespace; this check never disables an existing connection.');
  const firstRead = await apiJson('/api/models');
  assert.equal(firstRead.status, 200);
  assert(Array.isArray(firstRead.body.models), 'GET /api/models must return a catalogue array.');
  assert(firstRead.body.snapshot && typeof firstRead.body.snapshot.refreshNeeded === 'boolean', 'GET /api/models must report snapshot metadata.');
  const refreshed = await apiJson('/api/models/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(refreshed.status, 200, 'Explicit catalogue refresh must succeed as the owner action, got ' + refreshed.status);
  assert(Array.isArray(refreshed.body.models), 'Refresh must return a catalogue array.');
  assert(refreshed.body.snapshot && typeof refreshed.body.snapshot.updatedAt === 'string', 'Refresh must stamp the stored snapshot.');
  const rereadA = await apiJson('/api/models');
  const rereadB = await apiJson('/api/models');
  assert.equal(rereadA.status, 200);
  assert.equal(rereadB.status, 200);
  assert.deepEqual(rereadA.body.models, refreshed.body.models, 'First GET after refresh must equal the refreshed snapshot (no discovery on GET).');
  assert.deepEqual(rereadB.body.models, refreshed.body.models, 'Second GET after refresh must equal the refreshed snapshot (no discovery on GET).');
  assert.deepEqual(rereadA.body.snapshot, refreshed.body.snapshot, 'Snapshot metadata must be identical between refresh and GET.');
  assert.deepEqual(rereadB.body.snapshot, refreshed.body.snapshot, 'Snapshot metadata must stay stable across GETs.');
  assert.deepEqual(rereadA.body.warnings, refreshed.body.warnings, 'Warnings must be identical between refresh and GET.');
  assert.deepEqual(rereadB.body.warnings, refreshed.body.warnings, 'Warnings must stay stable across GETs.');
  const models = rereadB;
  const warnings = models.body.warnings;
  assert(Array.isArray(warnings) && warnings.every((w) => typeof w === 'string' && w.trim().length > 0), 'Catalogue discovery warnings must remain visible, including partial provider failures.');
  const externals = models.body.models.filter((m) => m && typeof m.route === 'string' && m.route.startsWith('gateway:'));
  assert(externals.length > 0, 'At least one discovered Gateway provider route is required.');
  assert.equal(new Set(externals.map((m) => m.route)).size, externals.length, 'Discovered Gateway routes must be unique.');
  const nativePairs = externals.map((m) => {
    const parts = /^gateway:([^/]+)\/.+/.exec(m.route);
    assert(parts && typeof m.id === 'string' && m.id.trim().length > 0, 'Gateway entries require a provider and native ID.');
    assert(providerConfigs.has(parts[1]), 'Every Gateway catalogue route must have stored provider configuration (' + parts[1] + ').');
    return [parts[1], m.id];
  });
  assert.equal(new Set(nativePairs.map((pair) => JSON.stringify(pair))).size, externals.length, 'Provider/native ID pairs must be unique.');
  for (const m of externals) assert(m && !m.enabled && m.unavailableReason, 'External model must be visibly disabled without owner credential opt-in (' + m.route + ').');
  const external = externals[0];
  assert(external, 'At least one external Gateway route is required.');
  const firstRouteByProvider = new Map();
  for (const model of externals) {
    const providerId = /^gateway:([^/]+)\/.+/.exec(model.route)?.[1];
    if (providerId && !firstRouteByProvider.has(providerId)) firstRouteByProvider.set(providerId, model.route);
  }
  const providerRoutesForBrowser = [];
  for (const providerId of ADDED_PROVIDER_IDS) {
    const provider = providerConfigs.get(providerId);
    const route = firstRouteByProvider.get(providerId);
    if (provider.enabled) {
      assert(route, 'Enabled provider ' + providerId + ' must return a discovered model route.');
      providerRoutesForBrowser.push(route);
    }
  }
  const browserModelRoutes = [...new Set([external.route, ...providerRoutesForBrowser])];
  const embedders = models.body.models.filter((m) => m && /embed|rerank/i.test(m.route + ' ' + (m.id || '') + ' ' + (m.label || '')));
  for (const m of embedders) assert(!m.enabled && m.unavailableReason, 'Embed/rerank inventory entries must not be selectable (' + m.route + ').');
  const flash = models.body.models.find((m) => m.route === 'workers-ai:@cf/zai-org/glm-5.3-flash');
  assert(flash && flash.enabled, 'Native Flash default must stay enabled.');
  assert.equal(before.body.settings.answerModel, flash.route, 'Default answer model stays Flash.');
  const denied = await apiJson('/api/models/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId: 'eliotr-reasoning' }) });
  assert.equal(denied.status, 400, 'Saving a Gateway without explicit credential consent must fail before mutation.');
  const connectionAfterDenied = await apiJson('/api/models/connection');
  assert.equal(connectionAfterDenied.status, 200);
  assert.equal(connectionAfterDenied.body.connection.gatewayId, null, 'Server must preserve the blank Gateway setting after rejecting missing consent.');
  const invalid = await apiJson('/api/models/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId: 'default' }) });
  assert.equal(invalid.status, 400, 'The auto-created default Gateway is not an allowed connection.');
  const changed = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: external.route }) });
  assert.equal(changed.status, 503, 'A disconnected external route cannot become the default.');
  const emptyDistill = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: before.body.settings.answerModel, distillModel: '' }) });
  assert.equal(emptyDistill.status, 400, 'An empty distillModel must fail before mutation (no truthiness bypass).');
  const afterEmpty = await apiJson('/api/settings');
  assert.deepEqual(afterEmpty.body.settings, before.body.settings, 'Rejected empty distillModel must leave global settings unchanged.');
  const originalMode = before.body.settings.nativeUsageMode;
  assert(originalMode === 'included' || originalMode === 'standard', 'Native usage mode must be a saved included/standard choice.');
  const settingsBase = { answerModel: before.body.settings.answerModel, distillModel: before.body.settings.distillModel };
  const putNativeUsageMode = (nativeUsageMode) => apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settingsBase, nativeUsageMode }) });
  try {
    for (const mode of ['included', 'standard']) {
      const saved = await putNativeUsageMode(mode);
      assert.equal(saved.status, 200, 'Saving the native usage choice must succeed without inference.');
      const persisted = await apiJson('/api/settings');
      assert.equal(persisted.body.settings.nativeUsageMode, mode, 'Native usage choice must persist on GET.');
      assert.equal(persisted.body.settings.answerModel, settingsBase.answerModel);
      assert.equal(persisted.body.settings.distillModel, settingsBase.distillModel);
    }
    const beforeInvalidMode = await apiJson('/api/settings');
    assert.equal((await putNativeUsageMode('metered')).status, 400, 'An invalid mode must fail before mutation.');
    assert.deepEqual((await apiJson('/api/settings')).body.settings, beforeInvalidMode.body.settings, 'Rejected native mode must leave all saved settings unchanged.');
  } finally {
    assert.equal((await putNativeUsageMode(originalMode)).status, 200, 'Restore the original native usage choice.');
  }
  const project = await apiJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'External model admission ' + Date.now() }) });
  assert.equal(project.status, 201);
  const projectId = project.body.project.id;
  const emptyProjectModel = await apiJson('/api/projects/' + projectId + '/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: '' }) });
  assert.equal(emptyProjectModel.status, 400, 'An empty project answerModel must fail before mutation (no truthiness bypass).');
  const projectAfterEmpty = await apiJson('/api/projects/' + projectId);
  assert.equal(projectAfterEmpty.body.project.answerModel, null, 'Rejected empty project answerModel must leave the project override null.');
  const created = await apiJson('/api/projects/' + projectId + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(created.status, 201);
  const chatId = created.body.chat.id;
  const admissionChatPath = '/api/projects/' + encodeURIComponent(projectId) + '/chats/' + encodeURIComponent(chatId);
  const chatBeforeTurn = await apiJson(admissionChatPath);
  assert.equal(chatBeforeTurn.status, 200);
  assert(Array.isArray(chatBeforeTurn.body.turns), 'Chat snapshot must expose its stored turn rows.');
  const disconnectedTurnId = randomUUID();
  const turn = await apiJson(admissionChatPath + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId: disconnectedTurnId, question: 'Disconnected model check', scopeMode: 'empty', model: external.route }) });
  assert.equal(turn.status, 200);
  assert.equal(turn.body.turn.state, 'failed');
  assert.equal(turn.body.turn.turnId, disconnectedTurnId);
  assert.strictEqual(turn.body.turn.tokenLimit, 0, 'Undispatched disconnected failure must carry tokenLimit 0 (no reservation, no paid call).');
  assert.equal(turn.body.turn.inputTokens, 0);
  assert.equal(turn.body.turn.cachedTokens, 0);
  assert.equal(turn.body.turn.outputTokens, 0);
  assert.match(turn.body.turn.error, /disconnected|Gateway|credential/i);
  const chatAfterTurn = await apiJson(admissionChatPath);
  assert.equal(chatAfterTurn.status, 200);
  assert(Array.isArray(chatAfterTurn.body.turns), 'Post-turn chat snapshot must return stored turn rows.');
  assert.equal(chatAfterTurn.body.turns.length, chatBeforeTurn.body.turns.length + 1, 'Only the rejected turn record may be added.');
  const storedRejectedTurns = chatAfterTurn.body.turns.filter((stored) => stored && stored.turnId === disconnectedTurnId);
  assert.equal(storedRejectedTurns.length, 1, 'The rejected turn must have exactly one stored row.');
  assert.deepEqual(storedRejectedTurns[0], turn.body.turn, 'The exact stored rejected-turn record must equal the owning POST result.');
  let distill = { skipped: true, reason: 'storage fixture not attempted' };
  let sourceId = null;
  {
    const added = await apiJson('/api/projects/' + projectId + '/sources/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'External connection gate', text: 'Storage-only connection fixture ' + randomUUID() + '. This source has no model-derived knowledge.' }) });
    assert.equal(added.status, 202);
    sourceId = added.body.sourceId;
    const revisionId = added.body.revisionId;
    let view;
    for (let i = 0; i < 40; i++) {
      view = await apiJson('/api/sources/' + sourceId);
      if (['readable', 'readable_with_warnings'].includes(view.body.source?.readableState)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(['readable', 'readable_with_warnings'].includes(view.body.source?.readableState), 'Text fixture must finish its native ingest.');
    const path = '/api/sources/' + sourceId + '/understanding';
    const prior = await apiJson(path + '?revisionId=' + revisionId);
    assert.equal(prior.body.state, 'none');
    assert.equal(prior.body.progress.attempts, 0);
    const deniedDistill = await apiJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId, model: external.route }) });
    assert.equal(deniedDistill.status, 503, 'Disconnected external distillation must fail before queueing/admission/dispatch.');
    const next = await apiJson(path + '?revisionId=' + revisionId);
    assert.equal(next.body.state, 'none');
    assert.equal(next.body.progress.attempts, 0);
    assert.deepEqual(next.body, prior.body, 'Rejected disconnected distillation must preserve the exact owning revision record.');
    distill = { skipped: false, rejectedBeforeAdmission: true, attemptsBefore: prior.body.progress.attempts,
      attemptsAfter: next.body.progress.attempts, revisionRecordPreserved: true };
  }
  const { chromium, expect } = await import('@playwright/test');
  const accessHeaderNames = ['CF-Access-Client-Id', 'CF-Access-Client-Secret', 'cf-access-jwt-assertion'];
  assert(!accessHeaderNames.some((name) => typeof H[name] === 'string' && H[name].length > 0),
    'Browser eval refuses Access credential headers; use the bare loopback development path.');
  const browserOrigin = assertEvalBrowserOrigin(origin, configuredOrigin);
  const browser = await chromium.launch();
  let gatewayConsentChecks = { skipped: true };
  try {
    const context = await browser.newContext();
    let settingsPuts = 0;
    const mutations = [];
    const gatewayConsentRequests = [];
    await context.route('**/api/**', async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (request.method() === 'PUT' && requestUrl.pathname === '/api/models/connection') {
        gatewayConsentRequests.push(request.postDataJSON());
        await route.continue();
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        if (requestUrl.pathname === '/api/settings' && request.method() === 'PUT') settingsPuts += 1;
        mutations.push({ method: request.method(), url: request.url() });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const errors = [];
    async function setAdvancedGateway(page, open) {
      const details = page.locator('details.er-models__details').filter({ hasText: 'Advanced provider settings' });
      assert.equal(await details.count(), 1, 'Models card must expose one Advanced provider settings disclosure.');
      const isOpen = (await details.getAttribute('open')) !== null;
      if (open && !isOpen) await details.locator('summary').click();
      if (!open && isOpen) await details.locator('summary').click();
    }
    async function openSettings(page) {
      const reads = ['/api/settings', '/api/models/connection', '/api/models'].map(async (path) => {
        const response = await page.waitForResponse((r) => r.url() === browserOrigin + path && r.request().method() === 'GET', { timeout: 30000 });
        assert.equal(response.status(), 200, 'Settings reader must load ' + path + '.');
        await response.finished();
      });
      await Promise.all([page.goto(browserOrigin + '/settings'), ...reads]);
      const modelsRegion = page.getByRole('region', { name: 'Models', exact: true });
      await expect(modelsRegion).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
      const answersRadio = page.locator('input[type="radio"][value="answer"]');
      const understandingRadio = page.locator('input[type="radio"][value="distill"]');
      await expect(answersRadio).toBeVisible();
      await expect(understandingRadio).toBeVisible();
      await expect(page.getByRole('group', { name: 'Use model for' })).toBeVisible();
      assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Expanded picker must not use a Find disclosure.');
      assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Expanded picker must not paginate.');
      assert.strictEqual(await page.locator('section.er-model-picker__advanced').count(), 0, 'Expanded picker must not hide Model details.');
      await answersRadio.check();
      await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toBeEnabled({ timeout: 30000 });
      await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(before.body.settings.answerModel);
      await expect(page.getByRole('combobox', { name: 'Answer model: provider', exact: true })).toBeVisible();
      await expect(page.getByRole('searchbox', { name: 'Answer model: search models', exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: /free/i })).toBeVisible();
      await understandingRadio.check();
      await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toBeEnabled({ timeout: 30000 });
      await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toHaveValue(before.body.settings.distillModel);
      await expect(page.getByRole('combobox', { name: 'Understanding model: provider', exact: true })).toBeVisible();
      await expect(page.getByRole('searchbox', { name: 'Understanding model: search models', exact: true })).toBeVisible();
      await answersRadio.check();
      // Opening Settings is read-only; the Models Save button is not used here.
      await setAdvancedGateway(page, true);
      await expect(modelsRegion.getByRole('textbox', { name: 'Gateway ID Blank disables external routing.', exact: true })).toHaveValue('');
      await expect(modelsRegion.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true })).not.toBeChecked();
      await setAdvancedGateway(page, false);
    }
    async function activePicker(page, mode) {
      const label = mode === 'answers' ? 'Answer model' : 'Understanding model';
      await page.locator(mode === 'answers' ? 'input[type="radio"][value="answer"]' : 'input[type="radio"][value="distill"]').check();
      const select = page.getByRole('combobox', { name: label, exact: true });
      await expect(select).toBeVisible();
      await expect(select).toBeEnabled({ timeout: 30000 });
      return {
        select,
        provider: page.getByRole('combobox', { name: label + ': provider', exact: true }),
        search: page.getByRole('searchbox', { name: label + ': search models', exact: true }),
        free: page.getByRole('checkbox', { name: /free/i }),
      };
    }
    async function assertDisabledChoice(page, mode, routes) {
      const label = mode === 'answers' ? 'Answer model' : 'Understanding model';
      const expected = mode === 'answers' ? before.body.settings.answerModel : before.body.settings.distillModel;
      const picked = await activePicker(page, mode);
      const select = picked.select;
      const provider = picked.provider;
      const search = picked.search;
      const free = picked.free;
      await expect(select).toHaveValue(expected);
      for (const route of routes) {
        const parts = /^gateway:([^/]+)\/.+/.exec(route);
        assert(parts, 'Browser check requires a complete provider/native route.');
        await free.uncheck();
        await search.fill('');
        await provider.selectOption(parts[1]);
        assert.equal(await select.locator('option').evaluateAll((options, value) => options.filter((option) => option.value === value).length, route), 1,
          'Expanded catalogue must attach the exact provider/native route without paging (' + parts[1] + ', ' + label + ').');
        await expect(select).toHaveValue(expected);
        const choice = models.body.models.find((entry) => entry.route === route);
        assert(choice, 'The native model must exist in the frozen catalogue.');
        await search.fill(choice.id);
        await expect(select).toHaveValue(expected);
        await expect.poll(() => select.locator('option').evaluateAll((options, chosen) => options
          .filter((option) => option.getAttribute('value') === chosen).map((option) => option.hasAttribute('disabled')), route), { timeout: 30000 }).toEqual([true]);
      }
      await free.check();
      await expect(select).toHaveValue(expected);
      await free.uncheck();
      await expect(select).toHaveValue(expected);
      await search.fill('');
      await expect(select).toHaveValue(expected);
      await provider.selectOption('');
      await expect(select).toHaveValue(expected);
      assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Filters must not introduce a Find disclosure (' + label + ').');
      assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Filters must not introduce pagination (' + label + ').');
    }
    const desktop = await context.newPage();
    await desktop.setViewportSize({ width: 1440, height: 900 });
    desktop.on('pageerror', (error) => errors.push(error.message));
    await openSettings(desktop);
    await desktop.screenshot({ path: outDir + '/external-models-desktop.png', fullPage: true });
    await desktop.close();
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    page.on('pageerror', (error) => errors.push(error.message));
    await openSettings(page);
    const modelsSection = page.getByRole('region', { name: 'Models', exact: true });
    const consent = modelsSection.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true });
    const gatewayId = modelsSection.getByRole('textbox', { name: 'Gateway ID Blank disables external routing.', exact: true });
    const saveModels = modelsSection.getByRole('button', { name: 'Save', exact: true });
    assert.equal(await saveModels.count(), 1, 'Models card must have one Save button for defaults, providers, and Gateway connection.');
    await setAdvancedGateway(page, true);
    await gatewayId.fill('eliotr-reasoning');
    await expect(consent).not.toBeChecked();
    await saveModels.click();
    await expect(page.getByText(/check the box to connect a Gateway/i)).toBeVisible();
    assert.deepEqual(gatewayConsentRequests, [], 'Unconsented Gateway-only Save must not send a connection request.');
    assert.deepEqual(mutations, [], 'Gateway-only edit without consent must be rejected before an API write.');
    const connectionAfterUnconsentedSave = await apiJson('/api/models/connection');
    assert.equal(connectionAfterUnconsentedSave.status, 200);
    assert.equal(connectionAfterUnconsentedSave.body.connection.gatewayId, null, 'Unconsented Gateway-only Save must leave the stored connection blank.');
    await consent.check();
    await expect(consent).toBeChecked();
    const consentedConnectionResponse = page.waitForResponse((response) =>
      response.url() === browserOrigin + '/api/models/connection' && response.request().method() === 'PUT', { timeout: 30000 });
    await saveModels.click();
    assert.equal((await consentedConnectionResponse).status(), 200, 'Consent-enabled Gateway Save must persist the existing named Gateway.');
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    assert.deepEqual(gatewayConsentRequests, [{ gatewayId: 'eliotr-reasoning', confirmCredentialAccess: true }],
      'Gateway consent must be explicit in the connection request body.');
    const connectionAfterConsentSave = await apiJson('/api/models/connection');
    assert.equal(connectionAfterConsentSave.status, 200);
    assert.equal(connectionAfterConsentSave.body.connection.gatewayId, 'eliotr-reasoning',
      'Readback must show the actual stored Gateway setting; this does not prove provider usability.');
    await expect(consent).not.toBeChecked();
    await gatewayId.fill('');
    const restoreConnectionResponse = page.waitForResponse((response) =>
      response.url() === browserOrigin + '/api/models/connection' && response.request().method() === 'PUT', { timeout: 30000 });
    await saveModels.click();
    assert.equal((await restoreConnectionResponse).status(), 200, 'The same Models Save must restore the Gateway setting to blank.');
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    const connectionAfterRestore = await apiJson('/api/models/connection');
    assert.equal(connectionAfterRestore.status, 200);
    assert.equal(connectionAfterRestore.body.connection.gatewayId, null,
      'Readback must confirm the original blank Gateway setting was restored.');
    await saveModels.click();
    await expect(page.getByText('No changes.', { exact: true })).toBeVisible();
    assert.deepEqual(gatewayConsentRequests, [
      { gatewayId: 'eliotr-reasoning', confirmCredentialAccess: true },
      { gatewayId: null },
    ], 'Gateway roundtrip must persist only the consented ID and restore blank through the UI.');
    gatewayConsentChecks = {
      unconsentedSaveRejected: true,
      unconsentedStoredGatewayId: connectionAfterUnconsentedSave.body.connection.gatewayId,
      consentedStoredGatewayId: connectionAfterConsentSave.body.connection.gatewayId,
      restoredGatewayId: connectionAfterRestore.body.connection.gatewayId,
      connectionPutCount: gatewayConsentRequests.length,
      blankOnlySaveNoOp: true,
      providerUsabilityProven: false,
    };
    await setAdvancedGateway(page, false);
    assert((await page.locator('#workspace-main details.er-models__details').count()) >= 1, 'Gateway technical details stay collapsed separately from the expanded picker.');
    assert.strictEqual(await page.locator('#workspace-main details.er-models__details[open]').count(), 0, 'Gateway technical details must start collapsed.');
    assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Expanded picker must not introduce a Find disclosure.');
    assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Expanded picker must not introduce pagination.');
    assert.strictEqual(await page.locator('section.er-model-picker__advanced').count(), 0, 'Expanded picker must not hide Model details.');
    const summaries = page.locator('#workspace-main details.er-models__details > summary');
    for (let i = 0; i < await summaries.count(); i++) assert((await summaries.nth(i).innerText()).trim().length > 0, 'Every collapsed gateway section must carry an accessible label.');
    await assertDisabledChoice(page, 'answers', browserModelRoutes);
    await assertDisabledChoice(page, 'understanding', browserModelRoutes);
    await activePicker(page, 'answers');
    await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(before.body.settings.answerModel);
    await activePicker(page, 'understanding');
    await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toHaveValue(before.body.settings.distillModel);
    await activePicker(page, 'answers');
    assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Display-only filters must not introduce a Find disclosure.');
    assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Display-only filters must not introduce pagination.');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Settings must fit the 390px Material layout.');
    await setAdvancedGateway(page, true);
    await saveModels.scrollIntoViewIfNeeded();
    await expect(saveModels).toBeVisible();
    await page.screenshot({ path: outDir + '/external-models-390.png', fullPage: true });
    await page.setViewportSize({ width: 389, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Settings must fit the 389px Material layout.');
    await page.setViewportSize({ width: 390, height: 844 });
    // The single Models Save must not write when the Gateway-only edit was rejected and reset.
    assert.strictEqual(settingsPuts, 0, 'Storage-only browser must not PUT /api/settings.');
    await expect(consent).not.toBeChecked();
    if (sourceId) {
      const modelsRead = page.waitForResponse((r) => r.url() === browserOrigin + '/api/models' && r.request().method() === 'GET', { timeout: 30000 });
      await page.goto(browserOrigin + '/p/' + projectId + '/source/' + sourceId);
      assert.equal((await modelsRead).status(), 200, 'Understanding model catalogue must load.');
      const understanding = page.getByRole('region', { name: 'Understanding', exact: true });
      await expect(understanding.locator('details.er-und__details')).toHaveCount(0);
      const select = understanding.getByRole('combobox', { name: 'Understanding model', exact: true });
      const sourceProvider = understanding.getByRole('combobox', { name: 'Understanding model: provider', exact: true });
      await expect(select).toBeVisible();
      await expect(sourceProvider).toBeEnabled({ timeout: 30000 });
      for (const route of browserModelRoutes) {
        const parts = /^gateway:([^/]+)\/.+/.exec(route);
        assert(parts, 'Understanding browser check requires a complete provider/native route.');
        await sourceProvider.selectOption(parts[1]);
        await expect(select).toBeEnabled();
        assert.equal(await select.locator('option').evaluateAll((options, value) => options.filter((option) => option.value === value).length, route), 1,
          'Understanding catalogue must attach the exact provider/native route (' + parts[1] + ').');
        await expect.poll(() => select.locator('option').evaluateAll((options, chosen) => options
          .filter((option) => option.getAttribute('value') === chosen).map((option) => option.hasAttribute('disabled')), route), { timeout: 30000 }).toEqual([true]);
      }
    }
    assert.strictEqual(settingsPuts, 0, 'The entire browser journey must attempt zero settings PUTs.');
    assert.deepEqual(mutations, [], 'The browser journey must make no model/provider/settings mutation beyond the explicitly consented Gateway roundtrip.');
    assert.deepEqual(gatewayConsentRequests, [
      { gatewayId: 'eliotr-reasoning', confirmCredentialAccess: true },
      { gatewayId: null },
    ], 'The Gateway roundtrip must persist the explicit consented ID, then restore blank.');
    assert.deepEqual(errors, [], 'Settings/understanding must not throw browser errors.');
    const evalProviderId = 'eval-provider-' + Date.now().toString(36);
    let providerPuts = 0;
    let providerGets = 0;
    let providerSettingsPuts = 0;
    let providerRefreshPosts = 0;
    let providerTurnPosts = 0;
    const providerBlocked = [];
    const providerErrors = [];
    const providerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    providerContext.setDefaultTimeout(30000);
    providerContext.setDefaultNavigationTimeout(30000);
    await providerContext.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const path = url.pathname;
      if (method === 'GET' && (path === '/api/models/providers' || path === '/api/settings' || path === '/api/models' || path === '/api/models/connection')) {
        if (path === '/api/models/providers') providerGets += 1;
        await route.continue();
        return;
      }
      if (method === 'PUT' && path === '/api/models/providers') {
        providerPuts += 1;
        await route.continue();
        return;
      }
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        if (path === '/api/settings' && method === 'PUT') providerSettingsPuts += 1;
        if (path === '/api/models/refresh' && method === 'POST') providerRefreshPosts += 1;
        providerBlocked.push({ method, path });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    let providerCrudInner = null;
    try {
      const ppage = await providerContext.newPage();
      ppage.on('pageerror', (error) => providerErrors.push(String(error && error.message ? error.message : error).slice(0, 500)));
      const providerReads = ['/api/settings', '/api/models/connection', '/api/models', '/api/models/providers'].map((path) => ppage.waitForResponse((r) => r.url() === browserOrigin + path && r.request().method() === 'GET', { timeout: 30000 }));
      await ppage.goto(browserOrigin + '/settings');
      for (const pending of providerReads) {
        const response = await pending;
        assert.equal(response.status(), 200, 'Provider Settings reader must load ' + response.url() + '.');
        await response.finished();
      }
      await expect(ppage.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
      const providerItems = ppage.locator('.er-providers__item');
      assert.equal(await providerItems.count(), providersBefore.body.providers.length, 'Provider editor must show every stored provider.');
      const displayedProviderConfigs = await providerItems.evaluateAll((items) => items.map((item) => ({
        id: item.querySelector('.er-providers__id span')?.textContent?.trim() ?? '',
        enabled: item.querySelector('.er-providers__check input')?.checked === true,
        type: item.querySelector('.er-providers__fields select')?.value ?? '',
      })));
      const expectedProviderConfigs = providersBefore.body.providers.map((provider) => ({
        id: provider.id,
        enabled: provider.enabled,
        type: provider.type,
      }));
      assert.deepEqual(displayedProviderConfigs, expectedProviderConfigs, 'Provider Settings browser must show the stored provider IDs, types, and enabled states.');
      await ppage.getByRole('button', { name: 'Add provider', exact: true }).click();
      assert.equal(await providerItems.count(), providersBefore.body.providers.length + 1, 'Add provider must append one draft row.');
      const draft = ppage.locator('.er-providers__item').last();
      assert.equal(await draft.locator('details.er-providers__details').evaluate((el) => el.open), true, 'New provider draft must open Connection details (isNew stable).');
      await expect(draft.locator('select')).toHaveValue('openai-compatible');
      await draft.locator('.er-providers__fields input').first().fill(evalProviderId);
      assert.equal(await draft.locator('details.er-providers__details').evaluate((el) => el.open), true, 'Editing the provider ID must keep Connection details open.');
      await draft.locator('input[placeholder="https://"]').fill('https://api.example.com/v1/');
      await draft.locator('input[placeholder="custom-command-code"]').fill('custom-eval-provider');
      await draft.locator('input[placeholder="v1"]').fill('v1');
      await draft.getByRole('checkbox', { name: 'Enabled' }).uncheck();
      await expect(draft.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked();
      const saveModels = ppage.getByRole('button', { name: 'Save', exact: true });
      await saveModels.scrollIntoViewIfNeeded();
      const putResponse = ppage.waitForResponse((r) => r.url() === browserOrigin + '/api/models/providers' && r.request().method() === 'PUT', { timeout: 30000 });
      await saveModels.click();
      assert.equal((await putResponse).status(), 200, 'Combined Models Save must persist the edited provider array.');
      assert.equal(providerPuts, 1, 'The single Models Save must send exactly one provider-array PUT.');
      await expect(ppage.getByText('Saved.', { exact: true })).toBeVisible();
      const saved = await apiJson('/api/models/providers');
      assert.equal(saved.status, 200);
      assert.equal(saved.body.providers.length, providersBefore.body.providers.length + 1, 'Saved providers must append only the eval row.');
      const savedProviderConfigs = assertProviderConfigs(saved.body.providers, 'Saved provider configuration');
      for (const provider of providersBefore.body.providers) {
        assert.deepEqual(savedProviderConfigs.get(provider.id), provider, 'Saving a new provider must preserve existing provider ' + provider.id + '.');
      }
      const evalRow = savedProviderConfigs.get(evalProviderId);
      assert(evalRow, 'Saved providers must contain the eval provider ID.');
      assert.equal(evalRow.type, 'openai-compatible');
      assert.equal(evalRow.baseUrl, 'https://api.example.com/v1', 'Base URL must normalize without a trailing slash.');
      assert.equal(evalRow.gatewaySlug, 'custom-eval-provider');
      assert.equal(evalRow.gatewayPath, 'v1');
      assert.equal(evalRow.enabled, false, 'Eval provider must stay disabled so no discovery or inference runs.');
      await ppage.reload();
      await expect(ppage.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
      await expect(ppage.locator('.er-providers__item', { hasText: evalProviderId })).toBeVisible();
      assert.equal(providerRefreshPosts, 0, 'Save/load/edit must not trigger an automatic catalogue refresh.');
      assert.equal(providerTurnPosts, 0, 'Provider editing must not start a model turn.');
      assert.equal(providerSettingsPuts, 0, 'Provider editing must not PUT global model settings.');
      assert.deepEqual(providerBlocked, [], 'Provider phase must attempt no blocked mutation besides the explicit provider PUT.');
      assert.deepEqual(providerErrors, [], 'Provider editing must not throw page errors.');
      providerCrudInner = { evalProviderId, puts: providerPuts, gets: providerGets, settingsPuts: providerSettingsPuts, refreshPosts: providerRefreshPosts, turnPosts: providerTurnPosts, blocked: providerBlocked, restored: false };
      providerCrud = providerCrudInner;
    } finally {
      const restore = await apiJson('/api/models/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: providersBefore.body.providers }) });
      assert.equal(restore.status, 200, 'Restoring the provider snapshot must PUT 200.');
      const reread = await apiJson('/api/models/providers');
      assert.equal(reread.status, 200);
      assert.equal(reread.body.providers.length, providersBefore.body.providers.length, 'Restored providers must return to the original row count.');
      assertProviderConfigs(reread.body.providers, 'Restored provider configuration', true);
      assert.deepEqual(reread.body.providers, providersBefore.body.providers, 'Restored providers must equal the pre-eval snapshot.');
      providerCrud.restored = true;
      await providerContext.close().catch(() => undefined);
    }
    const providerReloadContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const reloadPage = await providerReloadContext.newPage();
      await reloadPage.goto(browserOrigin + '/settings');
      await expect(reloadPage.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
      const restoredItems = reloadPage.locator('.er-providers__item');
      assert.equal(await restoredItems.count(), providersBefore.body.providers.length, 'Reload after restore must show the original provider row count.');
      const restoredProviderIds = await restoredItems.locator('.er-providers__id span').allTextContents();
      assert.deepEqual(restoredProviderIds.map((id) => id.trim()), providersBefore.body.providers.map((provider) => provider.id),
        'Reload after restore must show every original required provider ID in order.');
      await expect(reloadPage.locator('.er-providers__item', { hasText: evalProviderId })).toHaveCount(0);
    } finally {
      await providerReloadContext.close().catch(() => undefined);
    }
  } finally { await browser.close(); }
  const after = await apiJson('/api/settings');
  assert.equal(after.body.settings.answerModel, before.body.settings.answerModel, 'Answer default must be unchanged.');
  assert.equal(after.body.settings.distillModel, before.body.settings.distillModel, 'Understanding default must be unchanged.');
  assert.equal(after.body.settings.nativeUsageMode, originalMode, 'Native usage mode must be restored.');
  assert.deepEqual(Object.keys(after.body.settings).sort(), Object.keys(before.body.settings).sort(), 'Settings shape must be unchanged (answerModel/distillModel/updatedAt).');
  assert(Number.isSafeInteger(after.body.settings.updatedAt) && after.body.settings.updatedAt > 0
    && after.body.settings.updatedAt >= before.body.settings.updatedAt, 'Intentional provider saves/restores must record a valid nondecreasing update time.');
  assert.equal((await apiJson('/api/models/connection')).body.connection.gatewayId, null);
  const result = { scope: 'LOCAL_CONNECTION_AND_ADMISSION', projectId, chatId, fullK2Accepted: false, consentRejected: true, disconnectedTurnTokenLimit: turn.body.turn.tokenLimit ?? null,
    disconnectedTurnRows: { before: chatBeforeTurn.body.turns.length, after: chatAfterTurn.body.turns.length, persistedMatches: storedRejectedTurns.length },
    nativeUsageMode: { original: originalMode, restored: after.body.settings.nativeUsageMode },
    catalogue: { externalModels: externals.length, providers: [...new Set(nativePairs.map((pair) => pair[0]))],
      providerBrowserChecks: [...new Set(browserModelRoutes.map((route) => /^gateway:([^/]+)\/.+/.exec(route)?.[1]).filter(Boolean))],
      providerSettingsBrowserChecks: providersBefore.body.providers.map((provider) => provider.id),
      discoveryHasWarnings: warnings.length > 0, warnings },
    provider: 'skipped', streaming: 'skipped', distill, browser390: true, credentialAccessEnabled: false, gatewayConsentChecks };
  result.providerCrud = providerCrud;
  await writeFile(outDir + '/external-models-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
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
if (!proj) { console.log('K2 skipped: project ' + JSON.stringify(title) + ' not found; prep K1 corpus first, do not upload/convert again.'); process.exit(2); }
const settingsSnapshot = await apiJson('/api/settings');
assert.equal(settingsSnapshot.status, 200, 'GET /api/settings must be 200; benchmark model comes from the stored global default.');
const benchmarkModel = settingsSnapshot.body?.settings?.answerModel;
const projectModelOverride = typeof proj.answerModel === 'string' && proj.answerModel ? proj.answerModel : null;
if (runModel) assert(typeof benchmarkModel === 'string' && benchmarkModel.length > 0, 'The stored global answerModel is required; no catalogue refresh or model override is allowed.');
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
if (!nativeOnly && scoped.length < 10) { console.log('K2 skipped: found ' + scoped.length + '/10 arxiv readable; prep K1 first, do not upload/convert again.'); process.exit(2); }
const sourceIds = scoped.map((s) => s.id);
const revSet = new Set(scoped.map((s) => s.currentRevisionId));
let chatId = resumeChat;
if (!chatId) {
  const cj = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'k2-eval ' + Date.now() }) });
  assert(cj.status === 201 || cj.status === 200, 'POST chats must be 201/200; got ' + cj.status + ' (K2 product API not wired yet).');
  assert(cj.body && typeof cj.body.chat === 'object', 'POST chats must return {chat}.');
  assert(typeof cj.body.chat.id === 'string' && cj.body.chat.id.length > 0, 'chat.id required.');
  chatId = cj.body.chat.id;
}
const chatPath = '/api/projects/' + encodeURIComponent(proj.id) + '/chats/' + encodeURIComponent(chatId);
async function getChat(what, signal) {
  const h = await apiJson(chatPath, signal ? { signal } : undefined);
  assert.equal(h.status, 200, 'GET chat must be 200 and storage-only (' + what + ').');
  assert(h.body && typeof h.body.chat === 'object', 'GET chat must return {chat, turns}.');
  indexTurnRecords(h.body.turns, 'GET chat (' + what + ')');
  return h.body;
}
const h0 = await getChat(resumeChat ? 'resume' : 'before');
if (resumeChat) assert.equal(h0.chat.id, resumeChat, 'Resumed chat id must match ELIOT_EVAL_CHAT.');
const whole = new Map();
async function checkRange(rev, st, en) {
  let w = whole.get(rev);
  if (!w) { const t = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text'); assert.equal(t.status, 200, 'GET revision text 200.'); w = t.bytes; whole.set(rev, w); }
  const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + st + '&end=' + en);
  assert.equal(r.status, 200, 'Each cited range must open (GET range 200).');
  assert(r.bytes.equals(w.subarray(st, en)), 'Cited range must equal the whole-text slice.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.bytes);
}
function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((id) => actual.includes(id));
}
function indexTurnRecords(turns, source) {
  assert(Array.isArray(turns), source + ' must return stored turn rows.');
  const byId = new Map();
  for (const turn of turns) {
    assert(turn && typeof turn.turnId === 'string' && turn.turnId.length > 0, source + ' turn rows need an exact turnId.');
    assert(!byId.has(turn.turnId), source + ' must not duplicate turnId ' + turn.turnId + '.');
    byId.set(turn.turnId, turn);
  }
  return byId;
}
function assertTurnSnapshotDelta(beforeTurns, afterTurns, expectedAddedRows, source) {
  const before = indexTurnRecords(beforeTurns, source + ' before');
  const after = indexTurnRecords(afterTurns, source + ' after');
  for (const [turnId, record] of before) {
    assert(after.has(turnId), source + ' must preserve pre-existing turn row ' + turnId + '.');
    assert.deepEqual(after.get(turnId), record, source + ' must preserve the exact pre-existing turn record ' + turnId + '.');
  }
  const added = [...after.keys()].filter((turnId) => !before.has(turnId));
  assert.equal(added.length, expectedAddedRows, source + ' stored turn row count delta must match this run.');
  assert.equal(after.size, before.size + expectedAddedRows, source + ' stored turn row count must be exact.');
  return added.map((turnId) => after.get(turnId));
}
function exactStoredTurn(qid, turns, used) {
  const matches = turns.filter((turn) => turn && typeof turn.turnId === 'string' && !used.has(turn.turnId)
    && turn.question === Q.get(qid) && turn.scopeMode === 'explicit' && turn.contextMode === 'whole'
    && sameSet(turn.sourceIds, sourceIds) && sameSet(turn.revisionIds, scoped.map((source) => source.currentRevisionId)));
  return matches.length ? matches[matches.length - 1] : null;
}
async function inspectTurn(qid, turn, source, wall, defaultModel, storedDiagnostic = false) {
  const row = {
    qid,
    turnId: typeof turn?.turnId === 'string' ? turn.turnId : null,
    answer: typeof turn?.answer === 'string' ? turn.answer : null,
    model: typeof turn?.model === 'string' ? turn.model : null,
    turnState: typeof turn?.state === 'string' ? turn.state : 'unknown',
    routeStatus: turn?.model === defaultModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
    factChecks: [],
    citationRanges: [],
    citationSummary: 'skipped',
    timing: { firstTokenMs: turn?.firstTokenMs ?? null, totalMs: turn?.totalMs ?? null, wallMs: wall ?? null },
    usage: {
      inputTokens: turn?.inputTokens ?? null,
      cachedTokens: turn?.cachedTokens ?? null,
      outputTokens: turn?.outputTokens ?? null,
      tokenLimit: turn?.tokenLimit ?? null,
    },
    invalidLabelExamples: Array.isArray(turn?.invalidLabelExamples) ? turn.invalidLabelExamples.slice(0, 8) : [],
    failures: [],
  };
  const failures = row.failures;
  const answer = row.answer ?? '';
  if (!turn || typeof turn !== 'object') failures.push('stored turn payload is missing');
  if (typeof turn?.answer !== 'string') failures.push('turn has no answer text');
  if (turn?.state !== 'completed') failures.push('turn state is ' + String(turn?.state ?? 'UNKNOWN'));
  if (turn?.model !== defaultModel) failures.push('turn model differs from the frozen global default');
  if (!sameSet(turn?.sourceIds, sourceIds) || !sameSet(turn?.revisionIds, scoped.map((source) => source.currentRevisionId))) {
    failures.push('turn scope does not match the exact current arxiv-10 source/revision set');
  }
  if (!Array.isArray(turn?.citations) || turn.citations.length === 0) failures.push('turn has no citations');
  if (typeof turn?.invalidLabels !== 'number' || turn.invalidLabels !== 0) failures.push('invalidLabels is not zero');
  for (const field of ['inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'firstTokenMs', 'totalMs']) {
    if (typeof turn?.[field] !== 'number' || !Number.isFinite(turn[field])) failures.push('turn.' + field + ' is unknown');
  }
  if (typeof turn?.totalMs === 'number' && turn.totalMs > 90000) failures.push('completed turn exceeded the 90 second K2 ceiling');

  const citationQuotes = new Map();
  const citations = Array.isArray(turn?.citations) ? turn.citations : [];
  const revOwner = new Map(scoped.filter((source) => source && typeof source.currentRevisionId === 'string')
    .map((source) => [source.currentRevisionId, source.id]));
  for (const [index, citation] of citations.entries()) {
    const check = {
      label: typeof citation?.label === 'string' ? citation.label : 'citation-' + String(index + 1),
      revisionId: citation?.revisionId ?? 'UNKNOWN',
      sourceId: citation?.sourceId ?? 'UNKNOWN',
      block: citation?.block ?? 'UNKNOWN',
      start: citation?.start ?? 'UNKNOWN',
      end: citation?.end ?? 'UNKNOWN',
      passed: false,
      reason: null,
    };
    const validRange = citation && typeof citation.revisionId === 'string' && typeof citation.sourceId === 'string'
      && Number.isSafeInteger(citation.block) && Number.isSafeInteger(citation.start) && Number.isSafeInteger(citation.end)
      && citation.start >= 0 && citation.end > citation.start;
    if (!validRange) check.reason = 'citation identity/block/byte range is malformed';
    else if (!Array.isArray(turn.revisionIds) || !turn.revisionIds.includes(citation.revisionId)) check.reason = 'revision is outside the turn frozen scope';
    else if (revOwner.get(citation.revisionId) !== citation.sourceId) check.reason = 'sourceId does not own the cited revision';
    else {
      try {
        const quote = await checkRange(citation.revisionId, citation.start, citation.end);
        citationQuotes.set(citation.label, quote);
        check.quote = quote;
        check.passed = true;
      } catch (error) {
        check.reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (!check.passed) failures.push(check.label + ': ' + check.reason);
    row.citationRanges.push(check);
  }
  let uncited = null;
  let unsupportedNumeric = null;
  try {
    if (typeof turn?.answer === 'string' && Array.isArray(turn?.citations)) {
      uncited = uncitedStatements(answer, turn.citations);
      unsupportedNumeric = unsupportedNumericStatements(answer, turn.citations, citationQuotes);
    }
  } catch (error) {
    failures.push('citation/fact verifier threw: ' + (error instanceof Error ? error.message : String(error)));
  }
  row.uncitedStatements = uncited;
  row.unsupportedNumericStatements = unsupportedNumeric;
  if (uncited === null) failures.push('uncited-statement check skipped (answer/citations unavailable)');
  // MAP Behavioral contract + IMPLEMENTATION 8: missing-citation spans are advisory marks,
  // not stream-state transitions. A skipped verifier remains a hard check failure.
  if (unsupportedNumeric === null) failures.push('numeric grounding check skipped (answer/citations unavailable)');
  // MAP + IMPLEMENTATION 8: unsupported-number spans are advisory marks,
  // not stream-state transitions.
  if (citations.length) row.citationSummary = citations.length + ' citation(s); ' + row.citationRanges.filter((range) => range.passed).length + '/' + citations.length + ' ranges open';
  else row.citationSummary = '0 citations';
  const factChecks = checkAnswer(qid, answer);
  factChecks.push({ name: 'citation byte ranges', passed: row.citationRanges.length > 0 && row.citationRanges.every((range) => range.passed), hard: true, detail: row.citationSummary });
  factChecks.push({ name: 'uncited factual statements', passed: uncited === 0, ...(uncited === null ? { skipped: 'answer/citations unavailable' } : {}), advisory: uncited !== null, hard: uncited === null, detail: uncited === null ? 'skipped' : String(uncited) + ' found (advisory; MAP hard gate is >=1 citation, invalidLabels=0, ranges open).' });
  factChecks.push({ name: 'numeric citation support', passed: unsupportedNumeric === 0, ...(unsupportedNumeric === null ? { skipped: 'answer/citations unavailable' } : {}), advisory: unsupportedNumeric !== null, hard: unsupportedNumeric === null, detail: unsupportedNumeric === null ? 'skipped' : String(unsupportedNumeric) + ' unsupported (advisory; MAP hard gates are C1-C4 facts/conditions, O8 abstention, ranges open).' });
  for (const field of ['inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'firstTokenMs', 'totalMs']) {
    factChecks.push({ name: field, passed: typeof turn?.[field] === 'number' && Number.isFinite(turn[field]), hard: true, detail: String(turn?.[field] ?? 'UNKNOWN') });
  }
  row.factChecks = factChecks;
  for (const check of factChecks) if (check.hard && !check.passed && !check.skipped) failures.push(check.name + ' failed');
  row.hardFailures = [...failures];
  row.diagnosticOnly = storedDiagnostic && row.routeStatus !== 'GLOBAL_DEFAULT';
  row.ownerReviewRequired = ['O1', 'O2', 'O3', 'O8'].includes(qid) && !row.diagnosticOnly;
  row.source = source;
  row.passed = failures.length === 0 && !row.diagnosticOnly;
  return row;
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
  const doc = { chatId, qid, turnId: turn.turnId, reused: !!extra.reused, src: extra.src, question: extra.question || null, model: turn.model ?? null, answer: turn.answer ?? null, state: turn.state, error: turn.error ?? null, citations: turn.citations ?? null, invalidLabels: turn.invalidLabels ?? null, invalidLabelExamples: Array.isArray(turn.invalidLabelExamples) ? turn.invalidLabelExamples.slice(0, 8) : [], inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null, tokenLimit: turn.tokenLimit ?? null, firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: extra.wall ?? null };
  await writeFile(outDir + '/k2-' + qid + '-' + String(turn.turnId).slice(0, 8) + '.json', JSON.stringify(doc, null, 2));
}
function dispatchUnavailable(status, body, turn) {
  const error = body?.error ?? body?.turn?.error ?? turn?.error ?? null;
  const code = String(error?.code ?? body?.code ?? '').toLowerCase();
  const message = String(error?.message ?? error ?? body?.message ?? '');
  if ([401, 402, 403, 404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (['auth', 'unauthorized', 'forbidden', 'budget', 'unavailable', 'busy', 'rate_limited'].includes(code)) return true;
  if (/credential|unauthori[sz]ed|forbidden|budget|quota|rate.?limit|disconnected|\bprovider.{0,24}(?:unavailable|error|failed)|temporarily unavailable|\bgateway.{0,24}(?:unavailable|error|failed)/i.test(message)) return true;
  // Own 90 s deadline stays continuable: the next distinct question may dispatch.
  if (/exceeded the 90 s time bound|Time bound exceeded before dispatch/i.test(message)) return false;
  // Exact-turn timeout reconciliation stores provider failures as HTTP 200 with
  // the failure embedded in turn.error (model-transport.ts modelFailure shapes).
  // Stop on the same codes when embedded as HTTP; an explicit non-stop HTTP
  // code (e.g. 400 validation) keeps the prior continue behavior.
  if (/\bHTTP\s+(401|402|403|404|408|429|500|502|503|504)\b/i.test(message)) return true;
  if (/\bHTTP\s+\d{3}\b/i.test(message)) return false;
  // Per-question validation stays continuable in either existing failure
  // format: predispatch AI_Invalid* and in-band invalid_request_error.
  // Still stops 5xx/auth/rate/budget above and continues the own 90s deadline.
  if (/AI_InvalidPromptError|AI_InvalidArgumentError/i.test(message)) return false;
  if (/AI_StreamProviderError:invalid_request_error/i.test(message)) return false;
  // Validation-shaped stream failures stay per-question and do not stop the batch.
  if (/Model stream failed\s*\((?:AI_Invalid|Zod)/i.test(message)) return false;
  if (/External model request failed|Model stream failed/i.test(message)) return true;
  if (/authentication_error|permission_error|rate_limit_error|server_error|overloaded_error/i.test(message)) return true;
  return false;
}
if (!runModel && !storedOnly) {
  const h1 = await getChat('re-read');
  assert.equal(h1.turns.length, h0.turns.length, 'History re-read must not add turns.');
  assertTurnSnapshotDelta(h0.turns, h1.turns, 0, 'Storage-only history re-read');
  const md = ['# K2 native-only (storage, zero model calls)', '', '- project: ' + title, '- chat: ' + chatId + (resumeChat ? ' (resumed)' : ''), '- exact stored turn rows before/after: ' + h0.turns.length + '/' + h1.turns.length + ' (unchanged)', '- reader range self-check: 1 exact range', '- Paid answer turns: skipped (root signal required).', '- Stop/reconnect/Save: skipped (root browser journey).', '- fullK2Accepted: false', ''].join(EOL);
  await writeFile(outDir + '/k2-native-' + Date.now() + '.md', md);
  console.log(md);
  process.exit(0);
}
if (storedOnly) {
  const sUsed = new Set();
  let storedFailures = 0;
  let ownerRequired = false;
  let stopReason = null;
  for (const qid of order) {
    const turn = exactStoredTurn(qid, h0.turns, sUsed);
    if (!turn) {
      storedFailures++;
      markQuestionSkipped(qid, 'No stored turn has this exact question and exact frozen ten-source revision set.');
      continue;
    }
    sUsed.add(turn.turnId);
    let row;
    try { row = await inspectTurn(qid, turn, 'stored-only', null, benchmarkModel, true); }
    catch (error) {
      row = { qid, answer: typeof turn.answer === 'string' ? turn.answer : null, model: turn.model ?? null,
        turnState: turn.state ?? 'unknown', routeStatus: turn.model === benchmarkModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
        passed: false, ownerReviewRequired: false, reason: error instanceof Error ? error.message : String(error), factChecks: [], hardFailures: [], citationRanges: [],
        citationSummary: 'skipped', timing: { firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: null },
        usage: { inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null,
          tokenLimit: turn.tokenLimit ?? null } };
    }
    compareRows.set(qid, row);
    if (row.ownerReviewRequired) ownerRequired = true;
    if (!row.passed) storedFailures++;
  }
  let finalChat = null;
  let storedRecordsPreserved = false;
  try { finalChat = await getChat('stored-final'); }
  catch (error) { stopReason = 'Final storage-only chat read failed: ' + (error instanceof Error ? error.message : String(error)); }
  if (!finalChat) storedFailures++;
  else {
    try { assertTurnSnapshotDelta(h0.turns, finalChat.turns, 0, 'Stored-only revalidation'); storedRecordsPreserved = true; }
    catch (error) { storedFailures++; stopReason = error instanceof Error ? error.message : String(error); }
  }
  await writeCompare(compareRows, { mode: 'stored-only diagnostic; zero model calls/POSTs; recorded turn route shown per row',
    target: origin, defaultModel: benchmarkModel, projectModelOverride: projectModelOverride ?? 'none', chatId,
    hardChecksPassed: storedFailures === 0, ownerReviewRequired: ownerRequired, stopReason,
    turnCountBefore: h0.turns.length, turnCountAfter: finalChat?.turns.length ?? 'unknown',
    originalTurnRecordsPreserved: storedRecordsPreserved });
  if (storedFailures > 0) process.exit(1);
  if (ownerRequired) process.exit(2);
  process.exit(0);
}
const firstMs = [], totalMs = [];
let newTokenLimit = 0, reportedTokenLimit = 0, unknownTokenLimits = 0, unknownNewTokenLimits = 0;
let newCount = 0, hardFailures = 0, ownerRequired = false, manual = 0;
let dispatchStopped = false, stopReason = null;
const used = new Set();
const unknownDispatchIds = new Map();
function isTerminalReconciledTurn(stored) {
  const s = stored && typeof stored.state === 'string' ? stored.state : null;
  return s === 'completed' || s === 'partial' || s === 'failed' || s === 'cancelled';
}
async function observeDispatchedTurn(requestTurnId, qid) {
  // READ-ONLY reconciliation of an already-dispatched turn id after a POST
  // wait timed out. Bounded storage-only GET observation (at most two chat
  // snapshots, each GET with a finite AbortSignal deadline): never another
  // POST, never the same question again. Returns the stored turn only when
  // the submitted id is visible AND terminal (completed/partial/failed/
  // cancelled); a visible pending turn (started/streaming/running/unknown)
  // stays tracked as DISPATCH_UNKNOWN with reservation UNKNOWN, never
  // adopted and never zeroed. Only the matching submitted turnId is adopted.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let snap = null;
    try { snap = await getChat('reconcile-' + qid + '-attempt-' + attempt, AbortSignal.timeout(30000)); }
    catch (readError) { snap = null; }
    const found = snap && Array.isArray(snap.turns)
      ? snap.turns.find((t) => t && t.turnId === requestTurnId) : null;
    if (found && isTerminalReconciledTurn(found)) return found;
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}
async function adoptReconciledTurn(qid, stored, wall, via) {
  // Inspect an already-accepted stored turn found by read reconciliation and
  // fold its actual state/body/citations/reserved tokenLimit into the aggregates.
  // Unknown input/output stays UNKNOWN; nothing is re-dispatched.
  let persistenceError = null;
  try { await saveTurn(qid, stored, { src: via, wall, question: Q.get(qid) }); }
  catch (error) { persistenceError = error instanceof Error ? error.message : String(error); }
  let row;
  try { row = await inspectTurn(qid, stored, via, wall, benchmarkModel); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    row = { qid, answer: typeof stored?.answer === 'string' ? stored.answer : null, model: stored?.model ?? null,
      turnState: stored?.state ?? 'unknown', routeStatus: stored?.model === benchmarkModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
      passed: false, ownerReviewRequired: false, reason, factChecks: [], hardFailures: [reason], citationRanges: [], citationSummary: 'skipped',
      timing: { firstTokenMs: stored?.firstTokenMs ?? null, totalMs: stored?.totalMs ?? null, wallMs: wall },
      usage: { inputTokens: stored?.inputTokens ?? null, cachedTokens: stored?.cachedTokens ?? null, outputTokens: stored?.outputTokens ?? null,
        tokenLimit: stored?.tokenLimit ?? null } };
  }
  row.hardFailures = [...(row.hardFailures ?? []), 'Dispatch wait timed out; this accepted turn was reconciled by bounded storage-only read of the submitted turn id (' + via + '). No retry was sent and the question was not repeated.'];
  if (persistenceError) row.hardFailures = [...row.hardFailures, 'Could not preserve the new raw turn artifact: ' + persistenceError];
  compareRows.set(qid, row);
  unknownDispatchIds.delete(qid);
  newCount++;
  if (row.ownerReviewRequired) ownerRequired = true;
  if (!row.passed) hardFailures++;
  const reconciledLimit = stored.tokenLimit;
  if (typeof reconciledLimit === 'number' && Number.isSafeInteger(reconciledLimit) && reconciledLimit >= 0) {
    reportedTokenLimit += reconciledLimit;
    newTokenLimit += reconciledLimit;
  } else {
    unknownNewTokenLimits++;
  }
  if (typeof stored.firstTokenMs === 'number') firstMs.push(stored.firstTokenMs);
  if (typeof stored.totalMs === 'number') totalMs.push(stored.totalMs);
  return row;
}
for (const qid of order) {
  if (dispatchStopped) {
    hardFailures++;
    markQuestionSkipped(qid, 'Dispatch stopped after provider/auth/budget unavailability: ' + (stopReason || 'unknown cause'));
    continue;
  }
  let turn = null, src = 'new', wall = null, requestTurnId = null;
  if (resumeChat) {
    const candidate = exactStoredTurn(qid, h0.turns, used);
    if (candidate) { turn = candidate; src = 'reused'; used.add(candidate.turnId); }
    else if (h0.turns.some((existing) => existing && existing.question === Q.get(qid))) {
      hardFailures++; manual++;
        markQuestionSkipped(qid, 'A same-question turn already exists but does not match the exact source scope; no repeat was sent.');
      continue;
    }
  }
  if (!turn) {
    requestTurnId = randomUUID();
    const started = Date.now();
    let response = null, requestError = null;
    try {
      response = await apiJson(chatPath + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000), body: JSON.stringify({ turnId: requestTurnId, question: Q.get(qid),
          scopeMode: 'explicit', sourceIds, model: benchmarkModel }) });
    } catch (error) { requestError = error instanceof Error ? error.message : String(error); }
    wall = Date.now() - started;
    if (requestError) {
      // The POST wait timed out, but the turn may already be stored server-side
      // under requestTurnId. Reconcile that exact id with bounded storage-only
      // GET observation (each GET has a finite AbortSignal deadline): never
      // another POST, never the same question again. A matching terminal turn
      // (completed/partial/failed/cancelled, including its own 90s deadline or
      // cancel) is recorded and the explicit 12-question batch continues with
      // the next distinct question. Only an unknown outcome or provider/auth/
      // budget unavailability stops the rest. Partial/quality warnings never
      // stop the batch.
      let reconciled = null;
      try { reconciled = await observeDispatchedTurn(requestTurnId, qid); }
      catch (observeError) { reconciled = null; }
      if (reconciled) {
        turn = reconciled;
        await adoptReconciledTurn(qid, turn, wall, 'reconciled-timeout-read');
        if (dispatchUnavailable(200, null, turn)) {
          dispatchStopped = true;
          stopReason = 'Reconciled turn ' + qid + ' reports provider/auth/budget unavailability; no further questions were dispatched: ' + requestError;
        }
        continue;
      }
      const reason = 'Turn dispatch outcome unknown after bounded read reconciliation; no retry: ' + requestError;
      compareRows.set(qid, { qid, answer: null, model: benchmarkModel, turnState: 'unknown', routeStatus: 'GLOBAL_DEFAULT',
        passed: false, ownerReviewRequired: false, skipped: 'dispatch outcome unknown', reason, factChecks: [{ name: 'dispatch', passed: false, hard: true, detail: reason }], hardFailures: [reason],
        citationRanges: [], citationSummary: 'skipped', timing: { firstTokenMs: null, totalMs: null, wallMs: wall },
        usage: { inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: null } });
      unknownDispatchIds.set(qid, requestTurnId);
      hardFailures++; dispatchStopped = true; stopReason = reason;
      continue;
    }
    const responseTurn = response?.body?.turn;
    const responseTurnValid = !!responseTurn && typeof responseTurn === 'object' && !Array.isArray(responseTurn);
    if (!response || (response.status !== 200 && response.status !== 201) || !response.body || !responseTurnValid) {
      const status = response?.status ?? 'unread';
      const errorText = String(response?.body?.error?.message ?? response?.body?.message ?? 'response did not include the owning turn');
      const reason = 'POST turn failed with status ' + status + ': ' + errorText + '; no retry.';
      const stop = dispatchUnavailable(response?.status ?? 0, response?.body, null) || !response || !response.body || !responseTurnValid;
      compareRows.set(qid, { qid, answer: null, model: benchmarkModel, turnState: 'failed', routeStatus: 'GLOBAL_DEFAULT',
        passed: false, ownerReviewRequired: false, reason, factChecks: [{ name: 'dispatch', passed: false, hard: true, detail: reason }], hardFailures: [reason],
        citationRanges: [], citationSummary: 'skipped', timing: { firstTokenMs: null, totalMs: null, wallMs: wall },
        usage: { inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: null } });
      hardFailures++;
      if (stop) { dispatchStopped = true; stopReason = reason; }
      continue;
    }
    turn = responseTurn;
    newCount++;
  }
  let persistenceError = null;
  if (src === 'new') {
    try { await saveTurn(qid, turn, { src, wall, question: Q.get(qid) }); }
    catch (error) { persistenceError = error instanceof Error ? error.message : String(error); }
  }
  let row;
  try { row = await inspectTurn(qid, turn, src, wall, benchmarkModel); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    row = { qid, answer: typeof turn?.answer === 'string' ? turn.answer : null, model: turn?.model ?? null,
      turnState: turn?.state ?? 'unknown', routeStatus: turn?.model === benchmarkModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
      passed: false, ownerReviewRequired: false, reason, factChecks: [], hardFailures: [reason], citationRanges: [], citationSummary: 'skipped',
      timing: { firstTokenMs: turn?.firstTokenMs ?? null, totalMs: turn?.totalMs ?? null, wallMs: wall },
      usage: { inputTokens: turn?.inputTokens ?? null, cachedTokens: turn?.cachedTokens ?? null, outputTokens: turn?.outputTokens ?? null,
        tokenLimit: turn?.tokenLimit ?? null } };
  }
  if (src === 'new' && turn.turnId !== requestTurnId) {
    const reason = 'Returned turnId does not match the one submitted; no replacement request was sent.';
    row.hardFailures = [...(row.hardFailures ?? []), reason];
    row.passed = false;
    dispatchStopped = true; stopReason = reason;
  }
  if (persistenceError) {
    const reason = 'Could not preserve the new raw turn artifact: ' + persistenceError;
    row.hardFailures = [...(row.hardFailures ?? []), reason];
    row.passed = false;
  }
  compareRows.set(qid, row);
  if (row.ownerReviewRequired) ownerRequired = true;
  if (!row.passed) hardFailures++;
  const limit = turn.tokenLimit;
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0) {
    reportedTokenLimit += limit;
    if (src === 'new') newTokenLimit += limit;
  } else {
    unknownTokenLimits++;
    if (src === 'new') unknownNewTokenLimits++;
  }
  if (typeof turn.firstTokenMs === 'number') firstMs.push(turn.firstTokenMs);
  if (typeof turn.totalMs === 'number') totalMs.push(turn.totalMs);
  if (turn.state === 'running') {
    dispatchStopped = true;
    stopReason = 'The turn remained running after the synchronous wait; no additional turn was dispatched.';
  } else if (dispatchUnavailable(200, null, turn)) {
    dispatchStopped = true;
    stopReason = 'The stored turn reports provider/auth/budget unavailability; no further questions were dispatched.';
  }
}
for (const qid of order) if (!compareRows.has(qid)) { hardFailures++; markQuestionSkipped(qid, 'No diagnostic row was produced.'); }
let finalChat = null, finalReadError = null;
try {
  finalChat = await getChat('after turns');
  const reread = await getChat('final re-read');
  assert.deepEqual(reread.turns, finalChat.turns, 'Exact stored turn records must be stable across the final GET-only reread.');
} catch (error) { hardFailures++; finalReadError = error instanceof Error ? error.message : String(error); }
let originalTurnRecordsPreserved = false;
if (!finalChat) stopReason = 'Final storage re-read failed: ' + (finalReadError || 'unknown error');
else {
  // Final-read reconciliation: any still-unresolved dispatched id is looked up
  // once more in the final storage snapshot. Only an accepted matching terminal
  // turn (completed/partial/failed/cancelled) is adopted with its actual
  // state/body/citations/reserved tokenLimit (unknown input/output preserved);
  // a still-pending visible turn (started/streaming/running/unknown) or an
  // unresolvable id keeps DISPATCH_UNKNOWN with reservation UNKNOWN,
  // never zero. No POST anywhere.
  for (const pendingQid of unknownDispatchIds.keys()) {
    const pendingRow = compareRows.get(pendingQid);
    const pendingId = unknownDispatchIds.get(pendingQid);
    const stored = Array.isArray(finalChat.turns)
      ? finalChat.turns.find((t) => t && t.turnId === pendingId) : null;
    if (!stored) continue;
    if (!isTerminalReconciledTurn(stored)) continue;
    hardFailures--; // undo the DISPATCH_UNAVAILABLE increment; judge the reconciled row below.
    await adoptReconciledTurn(pendingQid, stored, pendingRow && pendingRow.timing ? pendingRow.timing.wallMs : null, 'reconciled-final-read');
  }
  const finalErrors = [];
  try {
    const addedTurns = assertTurnSnapshotDelta(h0.turns, finalChat.turns,
      finalChat.turns.length - h0.turns.length, 'Final chat snapshot');
    originalTurnRecordsPreserved = true;
    if (unknownDispatchIds.size === 0 && addedTurns.length !== newCount) finalErrors.push('Stored new turn row count does not match the dispatched request count.');
  } catch (error) {
    finalErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (unknownNewTokenLimits > 0) { hardFailures++; finalErrors.push('At least one new turn has unknown tokenLimit; UNKNOWN is not treated as free.'); }
  const unresolvedCount = unknownDispatchIds.size;
  if (unresolvedCount > 0) { hardFailures++; finalErrors.push(unresolvedCount + ' dispatched turn(s) remain unresolved after bounded read reconciliation; any held reservation is UNKNOWN, not zero.'); }
  if (finalErrors.length) { finalReadError = finalErrors.join(' '); stopReason = [stopReason, finalReadError].filter(Boolean).join(' '); }
}
await writeCompare(compareRows, { mode: 'default-model benchmark; frozen global route; one request per unanswered question; no retry',
  defaultModel: benchmarkModel, projectModelOverride: projectModelOverride ?? 'none', chatId,
  hardChecksPassed: hardFailures === 0, ownerReviewRequired: ownerRequired, stopReason,
  originalTurnRecordsPreserved,
  turnCountBefore: h0.turns.length, turnCountAfter: finalChat?.turns.length ?? 'UNKNOWN',
  newTokenLimit: newTokenLimit, reportedTokenLimit: reportedTokenLimit,
  firstTokenP50P95: [pct(firstMs, 0.5), pct(firstMs, 0.95)], totalP50P95: [pct(totalMs, 0.5), pct(totalMs, 0.95)] });
if (hardFailures > 0) process.exit(1);
if (ownerRequired) process.exit(2);
process.exit(0);
