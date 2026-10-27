// K6 project-knowledge eval harness (docs/MAP.md K6; docs/IMPLEMENTATION.md 12).
// Interface assumptions (backend contract under test):
//   GET  /api/projects -> 200 {projects:[...]}
//   GET  /api/projects/:projectId -> 200 {project}
//   GET  /api/projects/:projectId/sources -> 200 {sources:[...]} (K1 shape)
//   GET  /api/projects/:projectId/knowledge -> 200 KnowledgeView | 404 K6_NOT_WIRED
//   GET  /api/revisions/:rev/range?start=&end= -> exact canonical bytes (exact quote check)
//   POST /api/projects/:projectId/knowledge {mutationId} -> 202 {revisionId}|{accepted} (explicit ELIOT_K6_MODEL=1 only)
// Default: read stored map only, fail on missing work, zero model calls and zero POST.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildComparisons } from '../../src/comparisons.ts';
import type { ComparisonClaim, ComparisonGroup } from '../../src/comparisons.ts';
import type { KnowledgeView, KnowledgeData } from '../../src/knowledge.ts';
const EOL = String.fromCharCode(10);
const origin = new URL(process.env.ELIOT_URL || 'http://127.0.0.1:5173').origin;
const H = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
const runModel = process.env.ELIOT_K6_MODEL === '1';
const wantedTitle = process.env.ELIOT_EVAL_PROJECT || process.env.ELIOT_EVAL_TITLE || '';
const outDir = fileURLToPath(new URL('../../eval/out/k6/', import.meta.url));
await mkdir(outDir, { recursive: true });
function nowMs() { return Date.now(); }
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}
function summarizeTimings(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1] : null };
}
async function apiJson(path: string, init?: RequestInit): Promise<{ status: number; body: any; ms: number }> {
  const started = nowMs();
  const r = await fetch(origin + path, { ...init, signal: init?.signal ?? AbortSignal.timeout(30000), headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) } });
  const ms = nowMs() - started;
  const t = await r.text();
  let b: any = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: t.slice(0, 300) }; }
  return { status: r.status, body: b, ms };
}
async function apiBytes(path: string): Promise<{ status: number; bytes: Buffer; ms: number }> {
  const started = nowMs();
  const r = await fetch(origin + path, { headers: { ...H } });
  const ms = nowMs() - started;
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), ms };
}
const t0 = nowMs();
const timings: Record<string, number[]> = {};
const timeIt = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const s = nowMs();
  try { return await fn(); } finally { (timings[key] ?? (timings[key] = [])).push(nowMs() - s); }
};
const violations: string[] = [];
let knowledgeWired = false;
let paidPosted = false;
type StoredIds = { projectId: string; title: string };
async function resolveProject(): Promise<StoredIds> {
  const p = await timeIt('GET /api/projects', () => apiJson('/api/projects'));
  assert.equal(p.status, 200, 'GET /api/projects must be 200.');
  const projects = (p.body && p.body.projects) || [];
  assert(Array.isArray(projects) && projects.length > 0, 'At least one project must exist; K1 corpus setup is out of scope for this harness.');
  if (wantedTitle) {
    const found = projects.find((x: any) => x && (x.title === wantedTitle || x.id === wantedTitle));
    assert(found, 'ELIOT_EVAL_PROJECT/TITLE did not match any project: ' + wantedTitle);
    return { projectId: found.id, title: found.title ?? found.id };
  }
  const first = projects[0];
  return { projectId: first.id, title: first.title ?? first.id };
}
const { projectId, title } = await resolveProject();
async function monthlyUsage(): Promise<{ used: number; budget: number }> {
  const s = await apiJson('/api/settings');
  assert.equal(s.status, 200, 'GET /api/settings must be 200.');
  assert(typeof s.body.monthlyUsedMicrousd === 'number', 'GET /api/settings must return monthlyUsedMicrousd.');
  assert(typeof s.body.monthlyBudgetMicrousd === 'number', 'GET /api/settings must return monthlyBudgetMicrousd.');
  return { used: s.body.monthlyUsedMicrousd, budget: s.body.monthlyBudgetMicrousd };
}
const m0 = await monthlyUsage();
let knowledge = await timeIt('GET knowledge', () => apiJson('/api/projects/' + encodeURIComponent(projectId) + '/knowledge'));
if (knowledge.status === 404) {
  knowledgeWired = false;
} else {
  assert.equal(knowledge.status, 200, 'GET knowledge must be 200 when wired.');
  knowledgeWired = true;
}
const report: Record<string, unknown> = {
  project: { id: projectId, title },
  knowledgeWired,
  monthlyBefore: m0,
  paidPosted,
  timings: {},
  violations: [] as string[],
};
const finish = async (exitCode: number, extra: Record<string, unknown> = {}) => {
  const m1 = await monthlyUsage().catch(() => null);
  Object.assign(report, extra, {
    paidPosted,
    monthlyAfter: m1,
    usageDelta: m1 ? m1.used - m0.used : null,
    timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, summarizeTimings(v)])),
    violations,
    wallMs: nowMs() - t0,
  });
  await writeFile(outDir + '/k6-' + Date.now() + '.json', JSON.stringify(report, null, 2));
  const lines = ['# K6 project knowledge eval (' + (runModel ? 'explicit service run; at most one map request' : 'stored-only, zero paid calls') + ')', '', '- project: ' + title, '- knowledge route: ' + (knowledgeWired ? 'wired' : 'NOT_WIRED (404)'), '- monthly: ' + m0.used + '/' + m0.budget + ' -> ' + (m1 ? m1.used + '/' + m1.budget : 'unread'), '- violations: ' + violations.length, ''];
  for (const v of violations) lines.push('- ' + v);
  lines.push('');
  await writeFile(outDir + '/k6-' + Date.now() + '.md', lines.join(EOL));
  console.log(lines.join(EOL));
  if (violations.length > 0) console.error('K6 stored hard gates OPEN: ' + violations.length);
  process.exit(exitCode);
};
if (!knowledgeWired) {
  violations.push('knowledge route NOT_WIRED (404): worker KnowledgeView not implemented yet; no POST attempted');
  violations.push('owner O1-O5 NOT_RUN: no map to answer from');
  violations.push('source-replacement staleness NOT_RUN: no recorded operation or map revision observed');
  await finish(1);
}
if (runModel) {
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Model eval uses the isolated local Worker only.');
  const attemptPath = outDir + '/service-' + projectId + '.json';
  type Attempt = { projectId: string; origin: string; mutationId: string; model: string; dispatchStarted: boolean;
    revisionId: string | null; pageId: string | null; at: string; upperCostMicrousd: number; observationError?: string };
  let attempt: Attempt | null = null;
  try { attempt = JSON.parse(await readFile(attemptPath, 'utf8')) as Attempt; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = () => writeFile(attemptPath, JSON.stringify(attempt, null, 2));
  if (attempt) {
    assert.equal(attempt.origin, origin, 'Retain the original service attempt origin.');
    assert.equal(attempt.projectId, projectId);
    assert.equal(attempt.dispatchStarted, true, 'An existing incomplete record requires manual inspection; no auto-dispatch.');
    assert(attempt.revisionId, 'Dispatch outcome is unknown. Inspect the owning operation; never send a replacement.');
  } else {
    assert.equal(knowledge.body.state, 'none', 'Initial service eval requires no earlier operation; no automatic retry.');
    const settings = await apiJson('/api/settings');
    const route: unknown = settings.body.settings?.answerModel;
    assert(typeof route === 'string' && route.length > 0, 'Use the existing configured default.');
    const catalog = await apiJson('/api/models?selected=' + encodeURIComponent(route));
    assert.equal(catalog.status, 200);
    const model = catalog.body.models.find((item: any) => item.route === route);
    assert(model?.enabled && Number.isSafeInteger(model.contextTokens) && model.contextTokens > 0);
    for (const key of ['inputMicrousdPerMillion', 'outputMicrousdPerMillion'])
      assert(typeof model[key] === 'number' && Number.isFinite(model[key]) && model[key] >= 0, 'Unknown prices cannot admit an effect.');
    const reserve = model.outputReserveTokens ?? model.maxOutputTokens ?? 0;
    const output = Math.min(reserve, model.maxOutputTokens ?? reserve);
    assert(Number.isSafeInteger(output) && output > 0);
    const bound = 2 * Math.ceil((model.contextTokens * model.inputMicrousdPerMillion + output * model.outputMicrousdPerMillion) / 1_000_000);
    assert(Number.isSafeInteger(bound) && bound + m0.used <= m0.budget, 'Existing monthly budget must cover the two-call upper bound.');
    attempt = { projectId, origin, mutationId: randomUUID(), model: route, dispatchStarted: true, revisionId: null, pageId: null,
      at: new Date().toISOString(), upperCostMicrousd: bound };
    await save(); // Persist before the sole dispatch, including an unknown HTTP outcome.
    paidPosted = true;
    try {
      const response = await apiJson('/api/projects/' + projectId + '/knowledge', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mutationId: attempt.mutationId, model: route }),
        signal: AbortSignal.timeout(30_000) });
      assert.equal(response.status, 202, 'The one request must return its owning page revision.');
      assert(typeof response.body.revisionId === 'string' && typeof response.body.pageId === 'string');
      attempt.revisionId = response.body.revisionId; attempt.pageId = response.body.pageId; await save();
    } catch (error) {
      attempt.observationError = error instanceof Error ? error.message : String(error); await save();
      violations.push('Service dispatch outcome was not confirmed; no repeat: ' + attempt.observationError);
      await finish(1, { serviceAttempt: attempt });
    }
  }
  assert(attempt?.revisionId);
  const deadline = Date.now() + 16 * 60_000;
  while (true) {
    knowledge = await timeIt('GET operation', () => apiJson('/api/projects/' + projectId + '/knowledge?operationId=' + encodeURIComponent(attempt.revisionId), { signal: AbortSignal.timeout(20_000) }));
    assert.equal(knowledge.status, 200);
    const current = knowledge.body as KnowledgeView;
    assert.equal(current.operation?.revisionId, attempt.revisionId, 'Observe the same owning operation, never a replacement.');
    assert.equal(current.operation?.pageId, attempt.pageId);
    assert.equal(current.operation?.kind, 'map');
    assert((current.usage?.calls ?? 0) <= 2, 'Map dispatch cannot exceed two model calls.');
    if (current.state !== 'running' && current.state !== 'none') break;
    if (Date.now() > deadline) {
      violations.push('Operation observation timed out; retain the same revision and never redispatch.');
      await finish(1, { serviceAttempt: attempt, operation: current.operation });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  report.serviceAttempt = attempt;
  report.operation = knowledge.body.operation;
  if (knowledge.body.state !== 'done') {
    violations.push('Real service operation ended ' + knowledge.body.state + ': ' + String(knowledge.body.error ?? 'no error detail'));
    await finish(1, { usage: knowledge.body.usage });
  }
  assert.equal(knowledge.body.page?.headRevisionId, attempt.revisionId, 'The real map must reach its accepted page reader.');
}
if (!runModel && knowledge.body.page?.headRevisionId && knowledge.body.operation?.revisionId !== knowledge.body.page.headRevisionId) {
  const head = knowledge.body.page.headRevisionId;
  knowledge = await timeIt('GET accepted map operation', () => apiJson('/api/projects/' + projectId + '/knowledge?operationId=' + encodeURIComponent(head)));
  assert.equal(knowledge.status, 200);
  assert.equal(knowledge.body.operation?.revisionId, head, 'Read the map owning row rather than later Wiki usage.');
  assert.equal(knowledge.body.page?.headRevisionId, head, 'The accepted map changed during stored validation.');
}
const kv: any = knowledge.body;
assert(kv && typeof kv === 'object', 'KnowledgeView must be an object.');
assert(kv !== null && typeof kv === 'object', 'KnowledgeView must be an object when wired.');
const view = kv as KnowledgeView;
if (view.state === 'none' && view.data === null) {
  violations.push('stored map missing (state=none, data=null): no map revision stored yet; run an explicit refresh before re-running');
  await finish(1, { mapState: 'missing' });
}
if (view.data === null || view.data === undefined) {
  violations.push('stored map missing: KnowledgeView.data is null; explicit refresh required before validation');
  await finish(1, { mapState: String(view.state) });
}
const data = view.data as KnowledgeData;
const topics = data.topics;
const storedGroups: ComparisonGroup[] = data.comparisons;
const gaps = data.gaps;
const routes = data.routes;
if (topics.length === 0 && storedGroups.length === 0) {
  violations.push('Stored KnowledgeView carries no topics or comparisons to validate.');
  await finish(1, { mapState: String(view.state) });
}
if (topics.length > 12) violations.push('topics exceed 12 (' + topics.length + ')');
const sources = await timeIt('GET sources', () => apiJson('/api/projects/' + encodeURIComponent(projectId) + '/sources'));
assert.equal(sources.status, 200, 'GET sources must be 200.');
const listed: any[] = sources.body.sources || [];
const readable = listed.filter((s) => s && s.currentRevisionId && (s.readableState === 'readable' || s.readableState === 'readable_with_warnings'));
const revToSource = new Map<string, any>();
for (const s of readable) revToSource.set(s.currentRevisionId, s);
const sourceRows = data.sources;
const sourceById = new Map(sourceRows.map((s) => [s.sourceId, s]));
for (const gap of gaps) {
  if (!gap || typeof gap.question !== 'string' || !Array.isArray(gap.sourceIds)) { violations.push('gap entry malformed; refusing to guess'); continue; }
  for (const sid of gap.sourceIds) if (!sourceById.has(String(sid))) violations.push('gap references unknown stored source: ' + String(sid).slice(0, 8));
}
for (const route of routes) {
  if (!route || typeof route.title !== 'string' || !Array.isArray(route.sourceIds)) { violations.push('route entry malformed; refusing to guess'); continue; }
  for (const sid of route.sourceIds) if (!sourceById.has(String(sid))) violations.push('route references unknown stored source: ' + String(sid).slice(0, 8));
}
for (const row of sourceRows) {
  if (typeof row.sourceId !== 'string' || typeof row.revisionId !== 'string' || typeof row.title !== 'string') {
    violations.push('stored data.sources entry is malformed; refusing to guess scope');
  }
}
const liveRevBySource = new Map<string, string>();
for (const s of readable) liveRevBySource.set(s.id, s.currentRevisionId);
for (const row of sourceRows) {
  const live = liveRevBySource.get(row.sourceId);
  if (live === undefined) { violations.push('stored map source not attached to project: ' + row.sourceId.slice(0, 8)); continue; }
  if (live !== row.revisionId) { violations.push('stored map revision is stale for source ' + row.sourceId.slice(0, 8) + ' (stored ' + String(row.revisionId).slice(0, 8) + ' vs current ' + String(live).slice(0, 8) + '); explicit refresh required'); continue; }
  const rs = revToSource.get(row.revisionId);
  if (!rs) { violations.push('stored map revision is not a current readable revision: ' + String(row.revisionId).slice(0, 8)); continue; }
  revToSource.set(row.revisionId, rs);
}
const assigned = new Map<string, number>();
for (const t of topics) {
  if (!Array.isArray(t.sourceIds)) { violations.push('topic without sourceIds: ' + String(t.id ?? '?')); continue; }
  for (const sid of t.sourceIds) {
    const key = String(sid);
    assigned.set(key, (assigned.get(key) ?? 0) + 1);
    if (!sourceById.has(key)) violations.push('topic member not in stored data.sources: ' + key.slice(0, 8));
  }
}
for (const [sid, count] of assigned) {
  if (count !== 1) violations.push('source assigned ' + count + 'x across topics (must be exactly once): ' + sid.slice(0, 8));
}
for (const row of sourceRows) {
  if (!assigned.has(row.sourceId)) violations.push('readable source missing from topics: ' + (row.title || row.sourceId));
}
const claimByKey = new Map<string, ComparisonClaim>();
for (const g of storedGroups) {
  if (!g || !Array.isArray((g as ComparisonGroup).rows)) { violations.push('stored comparison group without rows'); continue; }
  for (const c of (g as ComparisonGroup).rows) {
    if (!c || typeof (c as ComparisonClaim).revisionId !== 'string' || typeof (c as ComparisonClaim).sourceId !== 'string') { violations.push('comparison row without revisionId/sourceId'); continue; }
    claimByKey.set(c.revisionId + '|' + c.block + '|' + c.start + '|' + c.end, c as ComparisonClaim);
  }
}
const aliases = data.aliases ?? {};
const derivedGroups = buildComparisons([...claimByKey.values()], aliases);
if (derivedGroups.filter((g) => g.rows.length >= 2).length < 3) violations.push('fewer than 3 genuinely compatible multi-source groups re-derived with production buildComparisons (found ' + derivedGroups.filter((g) => g.rows.length >= 2).length + ')');
const readPool = new Map<string, Buffer>();
async function wholeText(rev: string): Promise<Buffer> {
  let whole = readPool.get(rev);
  if (!whole) {
    const t = await timeIt('GET revision text', () => apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text'));
    assert.equal(t.status, 200, 'GET revision text 200 for ' + rev.slice(0, 8));
    whole = t.bytes;
    readPool.set(rev, whole);
  }
  return whole;
}
let rangeChecks = 0;
for (const [key, c] of claimByKey) {
  if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || !(c.end > c.start)) { violations.push('non-integer citation range: ' + key); continue; }
  const r = await timeIt('GET revision range', () => apiBytes('/api/revisions/' + encodeURIComponent(c.revisionId) + '/range?start=' + c.start + '&end=' + c.end));
  if (r.status !== 200) { violations.push('range did not open (status ' + r.status + '): ' + key); continue; }
  const whole = await wholeText(c.revisionId);
  if (c.end > whole.length || !r.bytes.equals(whole.subarray(c.start, c.end))) { violations.push('range bytes differ from whole-text slice: ' + key); continue; }
  try { if (Buffer.from(r.bytes.toString('utf8'), 'utf8').length !== r.bytes.length) throw new Error('bad utf8'); } catch { violations.push('range is not valid UTF-8: ' + key); continue; }
  rangeChecks += 1;
  if (typeof c.quote === 'string' && c.quote.length > 0 && r.bytes.toString('utf8') !== c.quote) violations.push('stored quote differs from exact range bytes: ' + key);
  const owner = readable.find((s) => s.currentRevisionId === c.revisionId);
  if (!owner) violations.push('citation revision outside current project scope (leak): ' + key);
}
report['topics'] = topics.length;
  report['comparisons'] = storedGroups.length;
report['derivedGroups'] = derivedGroups.length;
report['rangeChecks'] = rangeChecks;
report['unknownFields'] = Object.keys(kv).filter((k) => !['state', 'error', 'operation', 'page', 'data', 'usage'].includes(k));
report['operation'] = view.operation;
report['dataKeys'] = data && typeof data === 'object' ? Object.keys(data as Record<string, unknown>) : [];
report['viewState'] = view.state;
report['viewError'] = view.error;
report['usage'] = view.usage ?? null;
report['page'] = view.page ? { id: view.page.id, title: view.page.title, headRevisionId: view.page.headRevisionId } : null;
violations.push('owner O1-O5 NOT_RUN: answering from the map is owner-judged; no recorded O1-O5 turns observed');
violations.push('source-replacement staleness NOT_RUN: no replacement operation or stale-map record observed in this stored run');
const m1 = await monthlyUsage();
if (!runModel && m1.used !== m0.used) violations.push('monthly usage moved without paid calls');
if (m1.used > m1.budget) violations.push('recorded monthly usage exceeds the unchanged configured budget');
if (m1.budget !== m0.budget) violations.push('monthly budget moved during a read-only stored run');
await finish(violations.length > 0 ? 1 : 0, { usageDelta: m1.used - m0.used });
