// K6 project-knowledge eval harness (docs/MAP.md K6; docs/IMPLEMENTATION.md 12).
// Interface assumptions (backend contract under test):
//   GET  /api/projects -> 200 {projects:[...]}
//   GET  /api/projects/:projectId -> 200 {project}
//   GET  /api/projects/:projectId/sources -> 200 {sources:[...]} (K1 shape)
//   GET  /api/projects/:projectId/knowledge -> 200 KnowledgeView | 404 K6_NOT_WIRED
//   GET  /api/revisions/:rev/range?start=&end= -> exact canonical bytes (exact quote check)
//   POST /api/projects/:projectId/knowledge {mutationId} -> 202 {revisionId}|{accepted} (explicit ELIOT_K6_MODEL=1 only)
// Opt-in --wiki-recheck uses only /knowledge/wiki/recheck, never generation.
// Exact inputs: ELIOT_K6_PROJECT_ID, ELIOT_K6_WIKI_REVISION_ID. Optional negative
// controls: ELIOT_K6_FOREIGN_PROJECT_ID, ELIOT_K6_WIKI_INCOMPATIBLE_REVISION_ID.
// ELIOT_K6_D1_PATH names the live local SQLite file, opened read-only for the
// original-row snapshot; Local Explorer GETs hash its retained R2 objects.
// Default: read stored map only, fail on missing work, zero model calls and zero POST.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildComparisons } from '../../src/comparisons.ts';
import type { ComparisonClaim, ComparisonGroup } from '../../src/comparisons.ts';
import type { KnowledgeView, KnowledgeData } from '../../src/knowledge.ts';
import type { SavedPage, PageSummary } from '../../src/pages.ts';
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
async function runWikiRecheck(): Promise<number> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function explicitId(name: string, required = true): string | undefined {
    const value = process.env[name]?.trim();
    assert(!required || value, name + ' must identify the exact retained object; no automatic selection.');
    if (value) assert(uuid.test(value), name + ' must be a full UUID.');
    return value || undefined;
  }
  assert(!runModel, '--wiki-recheck cannot be combined with ELIOT_K6_MODEL=1.');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Wiki recheck uses a local Worker only.');
  const pid = explicitId('ELIOT_K6_PROJECT_ID') as string;
  const originalId = explicitId('ELIOT_K6_WIKI_REVISION_ID') as string;
  const foreignId = explicitId('ELIOT_K6_FOREIGN_PROJECT_ID', false);
  const incompatibleId = explicitId('ELIOT_K6_WIKI_INCOMPATIBLE_REVISION_ID', false);
  const d1Path = process.env.ELIOT_K6_D1_PATH?.trim();
  assert(d1Path, 'ELIOT_K6_D1_PATH must name the live local D1 SQLite file for immutable-original checks.');
  assert(foreignId !== pid, 'The foreign control must name a different existing project.');
  assert(incompatibleId !== originalId, 'The incompatible control must name a different retained attempt.');
  const base = '/api/projects/' + encodeURIComponent(pid);
  const requests: { path: string; revisionId: string; mutationId: string; status?: number; result?: unknown }[] = [];
  const checks: Record<string, unknown> = {};
  const result: Record<string, unknown> = { scope: 'WIKI_RECHECK_STORAGE_ONLY', projectId: pid, originalRevisionId: originalId,
    modelCalls: 0, paidPosted: false, requests, checks, fullK6Acceptance: 'NOT_RUN: existing K6 hard gates are unchanged.' };
  let before: { used: number; budget: number } | undefined;
  let settingsBefore: unknown;
  let failed: unknown;
  const notRun: string[] = [];
  let retainedBefore: Awaited<ReturnType<typeof retainedSnapshot>> | undefined;
  async function retainedSnapshot() {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(d1Path as string, { readOnly: true });
    let row: Record<string, unknown>;
    try {
      const found = db.prepare(`SELECT r.* FROM page_revision r JOIN page p ON p.id=r.page_id
        WHERE r.id=? AND p.project_id=? AND p.kind='wiki'`).get(originalId, pid);
      assert(found, 'The exact original Wiki must exist in the explicitly named D1 store.');
      row = { ...found };
    } finally { db.close(); }
    assert(typeof row.generation_payload_key === 'string', 'Original Wiki must retain its frozen-input key.');
    const objects = [];
    for (const [kind, key] of [['inputs', row.generation_payload_key], ['raw', 'page/' + originalId + '/call-1.json']]) {
      assert(typeof key === 'string');
      const read = await apiBytes('/cdn-cgi/local/explorer/api/r2/buckets/eliot-research-library/objects/' + encodeURIComponent(key));
      assert.equal(read.status, 200, 'Retain the original R2 ' + kind + ' object.');
      objects.push({ kind, key, bytes: read.bytes.length, sha256: createHash('sha256').update(read.bytes).digest('hex') });
    }
    return { row, rowSha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'), objects };
  }
  async function storedOperation(project: string, revision: string): Promise<KnowledgeView> {
    const read = await apiJson('/api/projects/' + encodeURIComponent(project) + '/knowledge?operationId=' + encodeURIComponent(revision));
    assert.equal(read.status, 200, 'Read the exact owning operation.');
    const view = read.body as KnowledgeView;
    assert(view.operation, 'The retained Wiki operation must exist.');
    assert.equal(view.operation.revisionId, revision);
    assert.equal(view.operation.kind, 'wiki');
    return view;
  }
  async function inventory(project: string): Promise<PageSummary[]> {
    const pages: PageSummary[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const read = await apiJson('/api/projects/' + encodeURIComponent(project) + '/pages' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      assert.equal(read.status, 200, 'Read all accepted page heads.');
      assert(Array.isArray(read.body.pages));
      pages.push(...read.body.pages);
      cursor = read.body.nextCursor ?? null;
      if (cursor) { assert(!seen.has(cursor), 'Page inventory cursor repeated.'); seen.add(cursor); }
    } while (cursor);
    return pages.sort((a, b) => a.id.localeCompare(b.id));
  }
  async function workflowJobs(): Promise<string[]> {
    // Local Explorer GET, verified against its OpenAPI instance-list contract.
    const ids: string[] = [];
    let page = 1, totalPages = 1;
    do {
      const read = await apiJson('/cdn-cgi/local/explorer/api/workflows/eliot-research-project-knowledge/instances?per_page=100&page=' + page);
      assert.equal(read.status, 200, 'Read local Workflow instances to prove no new job.');
      assert.equal(read.body.success, true); assert(Array.isArray(read.body.result));
      for (const row of read.body.result) { assert(typeof row.id === 'string'); ids.push(row.id); }
      totalPages = read.body.result_info.total_pages;
      assert(Number.isSafeInteger(totalPages) && totalPages >= 0);
      page++;
    } while (page <= totalPages);
    assert.equal(new Set(ids).size, ids.length, 'Workflow inventory changed while paging.');
    return ids.sort();
  }
  async function recheck(project: string, revision: string, mutationId: string) {
    const path = '/api/projects/' + encodeURIComponent(project) + '/knowledge/wiki/recheck';
    const request: (typeof requests)[number] = { path, revisionId: revision, mutationId };
    requests.push(request);
    const response = await apiJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revisionId: revision, mutationId }) });
    request.status = response.status; request.result = response.body;
    if (response.status === 500) {
      console.error('HTTP 500: Wiki recheck stopped immediately; no repeat follows.', JSON.stringify(request));
      throw new Error('HTTP 500 from ' + path + '; inspect the retained request, never retry variations.');
    }
    return response;
  }
  try {
    const project = await apiJson(base);
    assert.equal(project.status, 200, 'The explicit project must exist.');
    before = await monthlyUsage(); result.monthlyBefore = before;
    const settings = await apiJson('/api/settings');
    assert.equal(settings.status, 200); settingsBefore = settings.body;
    const original = await storedOperation(pid, originalId);
    assert(['done', 'failed'].includes(original.state), 'Recheck a retained terminal Wiki, never generate another.');
    assert.equal(original.canRecheckWiki, true, 'The exact original must have compatible frozen output.');
    assert(original.operation, 'The retained Wiki must identify its original page.');
    const pageId = original.operation.pageId;
    result.original = original;
    retainedBefore = await retainedSnapshot(); result.retainedBefore = retainedBefore;
    const activeBefore = await apiJson(base + '/knowledge');
    assert.equal(activeBefore.status, 200);
    result.activeOperationBefore = activeBefore.body.operation;
    const pagesBefore = await inventory(pid);
    const jobsBefore = await workflowJobs();
    result.workflowJobsBefore = jobsBefore;
    if (foreignId) assert.equal((await apiJson('/api/projects/' + encodeURIComponent(foreignId))).status, 200, 'Foreign control must be an existing project.');
    if (incompatibleId) {
      const old = await storedOperation(pid, incompatibleId);
      const oldActive = await apiJson(base + '/knowledge');
      const response = await recheck(pid, incompatibleId, randomUUID());
      assert.equal(response.status, 409, 'An old Wiki without frozen passages is incompatible.');
      assert.deepEqual(await storedOperation(pid, incompatibleId), old, 'Incompatible attempts remain immutable.');
      assert.deepEqual((await apiJson(base + '/knowledge')).body, oldActive.body, 'Incompatible input must not start an operation.');
      assert.deepEqual(await inventory(pid), pagesBefore, 'Incompatible input must not mutate page heads.');
      assert.deepEqual(await workflowJobs(), jobsBefore, 'Incompatible input must not create a Workflow.');
      checks.incompatible = { revisionId: incompatibleId, status: response.status, unchanged: true };
    } else notRun.push('Incompatible frozen-passage control: set ELIOT_K6_WIKI_INCOMPATIBLE_REVISION_ID.');
    if (foreignId) {
      const foreignBase = '/api/projects/' + encodeURIComponent(foreignId);
      const foreignBefore = await apiJson(foreignBase + '/knowledge');
      assert.equal(foreignBefore.status, 200);
      const foreignPages = await inventory(foreignId);
      const response = await recheck(foreignId, originalId, randomUUID());
      assert([404, 409].includes(response.status), 'A foreign project must reject this Wiki.');
      assert.deepEqual((await apiJson(foreignBase + '/knowledge')).body, foreignBefore.body);
      assert.deepEqual(await inventory(foreignId), foreignPages);
      assert.deepEqual(await inventory(pid), pagesBefore);
      assert.deepEqual(await workflowJobs(), jobsBefore, 'Foreign input must not create a Workflow.');
      checks.foreignProject = { projectId: foreignId, status: response.status, unchanged: true };
    } else notRun.push('Foreign existing-project control: set ELIOT_K6_FOREIGN_PROJECT_ID.');
    const mutationId = randomUUID();
    const first = await recheck(pid, originalId, mutationId);
    assert([200, 201, 202].includes(first.status), 'Storage-only recheck must return its committed derived revision synchronously.');
    assert.equal(first.body.state, 'done', 'A successful recheck must already be committed, never queued.');
    assert(typeof first.body.revisionId === 'string' && uuid.test(first.body.revisionId), 'Return the derived revisionId.');
    assert.equal(first.body.pageId, pageId, 'Publish on the original Wiki page.');
    const derivedId: string = first.body.revisionId;
    assert.notEqual(derivedId, originalId, 'Keep the retained original immutable.');
    async function derivedPage(): Promise<SavedPage> {
      const derived = await storedOperation(pid, derivedId);
      assert.equal(derived.state, 'done'); assert.equal(derived.operation?.pageId, pageId);
      assert.deepEqual(derived.usage, { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicrousd: 0 });
      const read = await apiJson(base + '/pages/' + encodeURIComponent(pageId));
      assert.equal(read.status, 200);
      const page = read.body.page as SavedPage;
      assert.equal(page.id, pageId); assert.equal(page.kind, 'wiki'); assert.equal(page.headRevisionId, derivedId);
      assert(/partial\s*wiki/i.test(page.body), 'The saved body must visibly warn Partial Wiki.');
      assert(!/times\s+10\s*\^\s*6/i.test(page.body), 'The unsupported exponent section must be dropped.');
      assert(page.citations.length > 0, 'The partial Wiki must retain cited passages.');
      return page;
    }
    const page = await derivedPage();
    const pagesAfter = await inventory(pid);
    assert.deepEqual(pagesAfter.filter(p => p.id !== pageId), pagesBefore.filter(p => p.id !== pageId), 'Only the original Wiki page may advance.');
    const activeAfter = await apiJson(base + '/knowledge');
    assert.equal(activeAfter.status, 200);
    assert.deepEqual(activeAfter.body.operation, { revisionId: derivedId, pageId, kind: 'wiki' }, 'The active row must identify the zero-usage derived Wiki.');
    assert.equal(activeAfter.body.state, 'done', 'Recheck must leave no queued or running operation.');
    assert.deepEqual(await workflowJobs(), jobsBefore, 'Recheck must not create a Workflow instance.');
    for (const repeatId of [mutationId, randomUUID()]) {
      const repeat = await recheck(pid, originalId, repeatId);
      assert([200, 201, 202].includes(repeat.status));
      assert.equal(repeat.body.state, 'done');
      assert.equal(repeat.body.revisionId, derivedId); assert.equal(repeat.body.pageId, pageId);
      assert.deepEqual(await derivedPage(), page, 'Same and new mutation IDs must retain the identical accepted head.');
      assert.deepEqual(await inventory(pid), pagesAfter, 'Repeat recheck must not create another page or head.');
      assert.deepEqual((await apiJson(base + '/knowledge')).body, activeAfter.body, 'Repeat recheck must not start another operation.');
      assert.deepEqual(await workflowJobs(), jobsBefore, 'Neither repeat may create a Workflow instance.');
    }
    const originalAfter = await storedOperation(pid, originalId);
    assert.equal(originalAfter.state, original.state); assert.equal(originalAfter.error, original.error);
    assert.deepEqual(originalAfter.operation, original.operation); assert.deepEqual(originalAfter.usage, original.usage);
    const texts = new Map<string, Buffer>();
    for (const citation of page.citations) {
      assert(Number.isSafeInteger(citation.start) && Number.isSafeInteger(citation.end) && citation.start >= 0 && citation.end > citation.start);
      const revision = '/api/revisions/' + encodeURIComponent(citation.revisionId);
      let text = texts.get(citation.revisionId);
      if (!text) { const whole = await apiBytes(revision + '/text'); assert.equal(whole.status, 200); text = whole.bytes; texts.set(citation.revisionId, text); }
      const range = await apiBytes(revision + '/range?start=' + citation.start + '&end=' + citation.end);
      assert.equal(range.status, 200); assert(citation.end <= text.length);
      assert(range.bytes.equals(text.subarray(citation.start, citation.end)), 'Citation HTTP bytes must equal the original UTF-8 slice.');
      new TextDecoder('utf-8', { fatal: true }).decode(range.bytes);
      assert(page.body.includes(citation.label), 'Each retained citation must be present in the partial Wiki.');
    }
    Object.assign(checks, { samePage: true, derivedZeroUsage: true, partialWikiWarning: true, unsupportedExponentDropped: true,
      sameMutationSameHead: true, newMutationSameHead: true, noNewRunningOperation: true, noNewWorkflowJob: true,
      originalUsageRetained: true, citationByteChecks: page.citations.length });
    result.workflowJobsAfter = await workflowJobs();
    result.derived = { revisionId: derivedId, pageId, body: page.body, citations: page.citations };
  } catch (error) { failed = error; result.error = error instanceof Error ? error.message : String(error); }
  finally {
    if (retainedBefore) {
      try {
        const after = await retainedSnapshot(); result.retainedAfter = after;
        assert.deepEqual(after, retainedBefore, 'Original D1 row and R2 raw/input hashes must remain exactly unchanged.');
        checks.originalD1AndR2Unchanged = true;
      } catch (error) { if (!failed) { failed = error; result.error = error instanceof Error ? error.message : String(error); } }
    }
    try {
      const after = await monthlyUsage(); result.monthlyAfter = after;
      assert(before); assert.deepEqual(after, before, 'Recheck must leave monthly spend and budget unchanged.');
      const settings = await apiJson('/api/settings'); assert.equal(settings.status, 200);
      assert.deepEqual(settings.body, settingsBefore, 'Recheck must preserve settings and monthly accounting.');
      checks.settingsAndMonthlyUnchanged = true;
    } catch (error) { if (!failed) { failed = error; result.error = error instanceof Error ? error.message : String(error); } }
    result.status = failed ? 'FAIL' : notRun.length ? 'INCOMPLETE' : 'VERIFIED'; result.notRun = notRun;
    result.wallMs = nowMs() - t0;
    const path = outDir + '/wiki-recheck-' + Date.now() + '.json';
    await writeFile(path, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, artifact: path }, null, 2));
  }
  return failed || notRun.length ? 1 : 0;
}
if (process.argv.includes('--wiki-recheck')) process.exit(await runWikiRecheck());
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
