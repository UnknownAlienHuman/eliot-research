import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { OCR_LIMITS } from '../../src/shared/api.ts';
import type { OcrJobView, Revision, Source } from '../../src/shared/api.ts';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

// Manager-prepared derivative QA PDFs only. Never creates projects/sources or changes settings.
// Required: ELIOT_URL, ELIOT_ORIGIN, ELIOT_OCR_PROJECT_ID, ELIOT_OCR_SOURCE_ID,
// ELIOT_OCR_REVISION_ID, ELIOT_OCR_MODEL, ELIOT_OCR_PAGES (full original page count).
// Paid Run requires ELIOT_K1_OCR_MODEL=1; optional two-page cancellation fixture:
// ELIOT_OCR_CANCEL_SOURCE_ID + ELIOT_OCR_CANCEL_REVISION_ID. No automatic retries.
// --resume-job=<UUID> / ELIOT_OCR_RESUME_JOB never creates/starts the apply job.
// Resume requires ELIOT_OCR_PRIOR_RESULT, ELIOT_OCR_PRIOR_EVIDENCE (the retained
// dependency-result.json range baseline), and ELIOT_OCR_ORIGINAL_SHA256 from the fixture.
type Meta = { source: Source; revisions: Revision[] };
type Action = { status: 'PASS' | 'NOT_RUN' | 'FAIL'; detail?: unknown };
type Upload = { jobId: string; page: number; bytes: number; sha256: string; width: number; height: number; png: boolean };
type PriorRanges = { origin: string; projectId: string; sourceId: string; baseRevisionId: string; beforeCurrent: string;
  rangeBaselineCapturedBeforeChange: boolean; baseline: { ranges: { citation: { sourceId: string; revisionId: string; start: number; end: number }; bytes: number; sha256: string }[] }[] };
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export async function runK1OcrEval() {
  const actions: Record<string, Action> = Object.fromEntries(['preflight', 'read_reopen', 'page_uploads', 'start_idempotent',
    'ready_preview', 'apply_storage_only', 'repeat_apply', 'old_evidence', 'cancel_after_first_call']
    .map(name => [name, { status: 'NOT_RUN' as const }]));
  const report = { status: 'NOT_RUN', scope: 'Manager-prepared derivative scan fixtures; not the unchanged arxiv baseline.',
    mode: 'fresh', priorProof: null as { path: string; sha256: string; evidencePath: string; evidenceSha256: string } | null,
    actions, jobs: [] as OcrJobView[], requests: [] as { method: string; path: string; status?: number }[], uploads: [] as Upload[], failure: '' };
  const out = fileURLToPath(new URL('../../eval/out/k1-ocr/' + new Date().toISOString().replaceAll(/[:.]/g, '-') + '/', import.meta.url));
  await mkdir(out, { recursive: true });
  const save = () => writeFile(out + 'result.json', JSON.stringify(report, null, 2) + '\n');
  const pass = async (name: string, detail?: unknown) => { actions[name] = { status: 'PASS', detail }; await save(); };
  let browser: Browser | undefined;
  let currentAction = 'preflight';
  try {
    const required = (key: string) => { const value = process.env[key]?.trim(); assert(value, 'Missing ' + key); return value; };
    const origin = assertEvalBrowserOrigin(required('ELIOT_URL'), required('ELIOT_ORIGIN'));
    assert.equal(origin, new URL(required('ELIOT_ORIGIN')).origin, 'Use the exact QA runtime origin.');
    const projectId = required('ELIOT_OCR_PROJECT_ID'), sourceId = required('ELIOT_OCR_SOURCE_ID');
    const revisionId = required('ELIOT_OCR_REVISION_ID'), model = required('ELIOT_OCR_MODEL');
    const pages = Number(required('ELIOT_OCR_PAGES')), paid = process.env.ELIOT_K1_OCR_MODEL === '1';
    const resumeFlag = process.argv.find(arg => arg.startsWith('--resume-job='))?.slice('--resume-job='.length);
    const resumeJob = resumeFlag ?? process.env.ELIOT_OCR_RESUME_JOB?.trim();
    if (resumeFlag !== undefined && process.env.ELIOT_OCR_RESUME_JOB) assert.equal(resumeFlag, process.env.ELIOT_OCR_RESUME_JOB.trim());
    if (resumeJob !== undefined) { assert(uuid.test(resumeJob), 'Resume requires an exact job UUID.'); report.mode = 'storage-only-resume'; }
    const cancelSource = process.env.ELIOT_OCR_CANCEL_SOURCE_ID?.trim(), cancelRevision = process.env.ELIOT_OCR_CANCEL_REVISION_ID?.trim();
    assert([projectId, sourceId, revisionId].every(id => uuid.test(id)), 'Fixture identities must be UUIDs.');
    assert(Number.isInteger(pages) && pages >= 1 && pages <= OCR_LIMITS.maxPages, 'Use the full fixture page count.');
    assert(Boolean(cancelSource) === Boolean(cancelRevision), 'Provide both cancellation fixture identities.');
    if (cancelSource && cancelRevision) assert(uuid.test(cancelSource) && uuid.test(cancelRevision) && cancelSource !== sourceId);
    const base = (id: string) => '/api/projects/' + projectId + '/sources/' + id + '/ocr';
    const allowed = [base(sourceId), ...(cancelSource ? [base(cancelSource)] : [])];
    const headers: Record<string, string> = { Origin: origin, Accept: 'application/json' };
    if (process.env.ELIOT_OWNER_JWT) headers['cf-access-jwt-assertion'] = process.env.ELIOT_OWNER_JWT.trim();
    const response = async (url: string, body?: object) => {
      if (body !== undefined) assert((resumeJob && url === base(sourceId) + '/' + resumeJob + '/apply')
        || (paid && allowed.some(b => url.startsWith(b + '/') && (!resumeJob || b !== base(sourceId)))), 'Mutation outside the explicit OCR fixture.');
      const result = await fetchEval(origin + url, { headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }, origin, process.env.ELIOT_ORIGIN);
      report.requests.push({ method: body === undefined ? 'GET' : 'POST', path: url, status: result.status });
      assert(result.ok, 'HTTP ' + result.status + ' for ' + url); return result;
    };
    const json = async <T>(url: string, body?: object): Promise<T> => (await response(url, body)).json() as Promise<T>;
    const bytes = async (url: string) => Buffer.from(await (await response(url)).arrayBuffer());
    const meta = (id: string) => json<Meta>('/api/sources/' + id);
    const job = async (id: string, jobId: string) => {
      const value = (await json<{ job: OcrJobView }>(base(id) + '/' + jobId)).job;
      assert.equal(value.projectId, projectId); assert.equal(value.sourceId, id);
      const previous = report.jobs.at(-1);
      if (!previous || previous.id !== value.id || previous.updatedAt !== value.updatedAt || previous.state !== value.state) report.jobs.push(value);
      return value;
    };
    const bound = (value: OcrJobView, count: number) => {
      assert.equal(value.modelRoute, model); assert.equal(value.pageCount, count); assert(value.calls <= count); assert.equal(value.baseRevisionId, value.sourceId === sourceId ? revisionId : cancelRevision);
    };
    const before = await meta(sourceId), old = before.revisions.find(r => r.id === revisionId);
    assert(old && old.originalMime === 'application/pdf', 'The pinned fixture must be an original PDF revision.');
    assert.equal(before.source.revisionId, revisionId, 'Use the latest original fixture revision.');
    const attached = await json<{ sources: Source[] }>('/api/projects/' + projectId + '/sources');
    assert(attached.sources.some(s => s.id === sourceId), 'Fixture source is outside the QA project.');
    if (cancelSource) assert(attached.sources.some(s => s.id === cancelSource), 'Cancellation source is outside the QA project.');
    const catalog = await json<{ models: { route: string; enabled: boolean; supportsImages?: boolean }[] }>('/api/models');
    const matches = catalog.models.filter(m => m.route === model);
    if (!resumeJob || (paid && cancelSource)) {
      assert.equal(matches.length, 1, 'Requested OCR route must have one real catalogue entry.');
      assert(matches[0]?.enabled && matches[0].supportsImages !== false, 'Requested image model is unavailable.');
    }
    const settings = await json<{ settings: { nativeUsageMode: string } }>('/api/settings');
    if (paid && model.startsWith('workers-ai:')) assert.equal(settings.settings.nativeUsageMode, 'standard', 'Owner must enable Standard on this QA runtime before the paid run; eval never changes defaults/settings.');
    const original = await bytes('/api/revisions/' + revisionId + '/original');
    assert.equal(sha(original), old.originalSha256, 'Original PDF hash differs from revision metadata.');
    const readable = ['readable', 'readable_with_warnings'].includes(old.readableState);
    const oldText = readable ? await bytes('/api/revisions/' + revisionId + '/text') : null;
    const oldOutline = readable ? await json<{ blocks: { id: number; type: string; start: number; end: number }[] }>('/api/revisions/' + revisionId + '/outline') : null;
    const oldBlock = oldOutline?.blocks.find(b => b.type === 'paragraph' && b.end > b.start);
    const oldRange = oldBlock ? await bytes('/api/revisions/' + revisionId + '/range?start=' + oldBlock.start + '&end=' + oldBlock.end) : null;
    if (oldRange && oldText && oldBlock) assert(oldRange.equals(oldText.subarray(oldBlock.start, oldBlock.end)));
    let retained: OcrJobView | undefined;
    if (resumeJob) {
      currentAction = 'resume_validation';
      const priorPath = path.resolve(required('ELIOT_OCR_PRIOR_RESULT')), priorRaw = await readFile(priorPath, 'utf8');
      const prior = JSON.parse(priorRaw) as { actions: Record<string, Action>; jobs: OcrJobView[] };
      assert.equal(prior.actions.preflight?.status, 'PASS');
      const inputs = prior.actions.preflight.detail as { origin: string; projectId: string; sourceId: string; revisionId: string; model: string; pages: number };
      assert.deepEqual([inputs.origin, inputs.projectId, inputs.sourceId, inputs.revisionId, inputs.model, inputs.pages], [origin, projectId, sourceId, revisionId, model, pages]);
      for (const name of ['page_uploads', 'start_idempotent']) {
        assert.equal(prior.actions[name]?.status, 'PASS', 'Retained prefix is missing ' + name);
        actions[name] = { status: 'NOT_RUN', detail: { retainedPrefixStatus: 'PASS', priorProof: priorPath, observedThisRun: false } };
      }
      const previous = prior.jobs.findLast(j => j.id === resumeJob); assert(previous); bound(previous, pages);
      assert.equal(previous.state, 'ready'); assert.equal(previous.calls, pages); assert.equal(previous.completedPages, pages);
      retained = await job(sourceId, resumeJob); bound(retained, pages);
      assert.equal(retained.state, 'ready'); assert.equal(retained.calls, previous.calls); assert.equal(retained.completedPages, previous.completedPages);
      assert.deepEqual([retained.inputTokens, retained.cachedTokens, retained.outputTokens], [previous.inputTokens, previous.cachedTokens, previous.outputTokens]);
      assert.equal(sha(original), required('ELIOT_OCR_ORIGINAL_SHA256').toLowerCase(), 'Original differs from the retained fixture hash.');
      const evidencePath = path.resolve(required('ELIOT_OCR_PRIOR_EVIDENCE')), evidenceRaw = await readFile(evidencePath, 'utf8');
      const evidence = JSON.parse(evidenceRaw) as PriorRanges;
      assert.deepEqual([evidence.origin, evidence.projectId, evidence.sourceId, evidence.baseRevisionId, evidence.beforeCurrent], [origin, projectId, sourceId, revisionId, before.source.currentRevisionId]);
      assert.equal(evidence.rangeBaselineCapturedBeforeChange, true);
      const ranges = evidence.baseline.flatMap(b => b.ranges).filter(r => r.citation.sourceId === sourceId && r.citation.revisionId === revisionId);
      assert(ranges.length > 0 && oldText, 'Resume needs retained old-source citation evidence.');
      for (const range of ranges) {
        assert.equal(range.bytes, range.citation.end - range.citation.start);
        assert.equal(sha(oldText.subarray(range.citation.start, range.citation.end)), range.sha256);
      }
      report.priorProof = { path: priorPath, sha256: sha(priorRaw), evidencePath, evidenceSha256: sha(evidenceRaw) };
      await pass('resume_validation', { jobId: resumeJob, calls: retained.calls, priorProof: report.priorProof, originalSha256: sha(original), savedRangesChecked: ranges.length,
        boundary: 'Prior range hashes verified; full old text/outline are captured anew before storage-only Apply, not claimed as a retained pre-call whole-text hash.' });
    }
    const list = (id: string) => json<{ jobs: OcrJobView[] }>(base(id));
    const initialJobs = (await list(sourceId)).jobs;
    assert(!initialJobs.some(j => ['preparing', 'queued', 'running'].includes(j.state)), 'Do not reuse an active OCR fixture.');
    const cancelBefore = cancelSource ? await meta(cancelSource) : null;
    if (cancelBefore && cancelSource) {
      assert.equal(cancelBefore.source.revisionId, cancelRevision);
      assert.equal(cancelBefore.revisions.find(r => r.id === cancelRevision)?.originalMime, 'application/pdf');
      assert(!(await list(cancelSource)).jobs.some(j => ['preparing', 'queued', 'running'].includes(j.state)), 'Cancellation fixture is already active.');
    }
    await pass('preflight', { origin, projectId, sourceId, revisionId, model, pages, paidOptIn: paid, nativeUsageMode: settings.settings.nativeUsageMode });
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    const page = await context.newPage(), blocked: string[] = [], browserMutations = new Set<string>();
    page.setDefaultTimeout(30_000);
    let phase = 'read', activeBase = base(sourceId);
    await context.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url()), method = request.method(), p = url.pathname;
      const mayRun = paid && (!resumeJob || activeBase !== base(sourceId));
      const permitted = url.origin === origin && (method === 'GET' || (
        (mayRun && phase === 'run' && ((method === 'POST' && (p === activeBase || p.startsWith(activeBase + '/') && p.endsWith('/start')))
          || (method === 'PUT' && p.startsWith(activeBase + '/') && /\/pages\/\d+$/u.test(p))))
        || (method === 'POST' && phase === 'apply' && (resumeJob ? p === base(sourceId) + '/' + resumeJob + '/apply' : paid && p.startsWith(activeBase + '/') && p.endsWith('/apply')))
        || (paid && method === 'POST' && phase === 'cancel' && p.startsWith(activeBase + '/') && p.endsWith('/cancel'))));
      const key = method + ' ' + p;
      if (!permitted || (method !== 'GET' && browserMutations.has(key))) { blocked.push(key); return route.abort('blockedbyclient'); }
      if (method !== 'GET') browserMutations.add(key);
      return route.continue(); // Scope guard only: no provider or service response is mocked.
    });
    page.on('request', request => {
      const p = new URL(request.url()).pathname;
      if (!p.includes('/ocr')) return;
      report.requests.push({ method: request.method(), path: p });
      const match = /\/ocr\/([^/]+)\/pages\/(\d+)$/u.exec(p), data = request.postDataBuffer();
      if (request.method() === 'PUT' && match && data) report.uploads.push({ jobId: match[1] ?? '', page: Number(match[2]), bytes: data.length,
        sha256: sha(data), width: data.length >= 24 ? data.readUInt32BE(16) : 0, height: data.length >= 24 ? data.readUInt32BE(20) : 0,
        png: data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) });
    });
    page.on('response', result => {
      const request = result.request(), p = new URL(result.url()).pathname;
      const entry = report.requests.findLast(r => r.path === p && r.method === request.method() && r.status === undefined);
      if (entry) entry.status = result.status();
    });
    const open = async (id: string, rev: string) => {
      await page.goto(origin + '/p/' + projectId + '/source/' + id + '?revisionId=' + rev);
      await page.getByRole('button', { name: 'OCR original PDF', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Read scanned PDF with OCR', exact: true });
      await expect(dialog).toBeVisible();
      if (resumeJob && id === sourceId) await dialog.locator('select[id$="-runs"]').selectOption(resumeJob);
      else await expect(dialog.locator('.er-ocr__bound')).toBeVisible({ timeout: 30_000 });
      return dialog; // Opening may read PDF metadata; only Run invokes renderPage/raster uploads.
    };
    currentAction = 'read_reopen'; let dialog = await open(sourceId, revisionId);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await open(sourceId, revisionId);
    await dialog.getByRole('button', { name: 'Check run status', exact: true }).click();
    await expect.poll(async () => (await list(sourceId)).jobs).toEqual(initialJobs);
    assert.deepEqual(await meta(sourceId), before); assert.deepEqual(blocked, []);
    assert(!report.requests.some(r => r.method !== 'GET'), 'Read/reopen attempted an OCR mutation.');
    await page.screenshot({ path: out + 'read-reopen.png', fullPage: true });
    await pass('read_reopen', { jobsUnchanged: true, callsUnchanged: true, mutations: 0 });
    if (!paid && !resumeJob) return report;
    const start = async (id: string, rev: string, count: number) => {
      activeBase = base(id); const current = id === sourceId ? dialog : await open(id, rev);
      await current.getByLabel('OCR model: provider', { exact: true }).selectOption(model.startsWith('gateway:') ? model.slice(8).split('/')[0] ?? '' : model.split(':')[0] ?? '');
      await current.getByLabel('OCR model', { exact: true }).selectOption(model);
      await expect(current.locator('.er-ocr__bound')).toContainText(new RegExp('\\b' + count + '\\s+pages?\\b', 'u'));
      const created = page.waitForResponse(r => r.url() === origin + activeBase && r.request().method() === 'POST');
      phase = 'run'; await current.getByRole('button', { name: 'Run OCR', exact: true }).click();
      const createdResponse = await created; assert(createdResponse.ok(), 'Create OCR job failed.');
      const value = ((await createdResponse.json()) as { job: OcrJobView }).job;
      const deadline = Date.now() + count * OCR_LIMITS.pageTimeoutMs + 60_000;
      let latest = await job(id, value.id);
      while (latest.state === 'preparing' && Date.now() < deadline) { await pause(100); latest = await job(id, value.id); }
      phase = 'read'; bound(latest, count); assert(['queued', 'running', 'ready'].includes(latest.state), latest.error ?? 'OCR did not start.');
      assert.deepEqual(latest.uploadedPages, Array.from({ length: count }, (_, i) => i + 1));
      const uploaded = report.uploads.filter(p => p.jobId === latest.id);
      assert.deepEqual(uploaded.map(p => p.page).sort((a, b) => a - b), latest.uploadedPages);
      assert(uploaded.every(p => p.png && p.bytes > 0 && p.bytes <= OCR_LIMITS.pageBytes && p.width > 0 && p.height > 0
        && p.width * p.height <= OCR_LIMITS.pagePixels && Math.max(p.width, p.height) <= OCR_LIMITS.renderLongEdge));
      return { value: latest, dialog: current, deadline };
    };
    let ready: OcrJobView;
    if (retained) ready = retained;
    else {
    currentAction = 'page_uploads'; const started = await start(sourceId, revisionId, pages); ready = started.value;
    await pass('page_uploads', { pages, uploads: report.uploads, scope: 'All expected numbered PNGs observed; pixel/crop fidelity is not independently image-compared.' });
    currentAction = 'start_idempotent'; const repeatedStart = (await json<{ job: OcrJobView }>(base(sourceId) + '/' + ready.id + '/start', {})).job;
    assert.equal(repeatedStart.id, ready.id); assert.equal(repeatedStart.deadlineAt, ready.deadlineAt); bound(repeatedStart, pages);
    while (['queued', 'running'].includes(ready.state) && Date.now() < started.deadline) { await pause(1000); ready = await job(sourceId, ready.id); bound(ready, pages); }
    assert.equal(ready.state, 'ready', ready.error ?? 'OCR did not finish within its bounded deadline.');
    assert.equal(ready.calls, pages); assert.equal(ready.completedPages, pages);
    await pass('start_idempotent', { jobId: ready.id, startPosts: 2, calls: ready.calls, inputTokens: ready.inputTokens, outputTokens: ready.outputTokens });
    }
    currentAction = 'ready_preview'; const preview = (await json<{ text: string }>(base(sourceId) + '/' + ready.id + '/preview')).text;
    assert(preview.trim()); await expect(dialog.getByLabel('Review and edit OCR text', { exact: true })).toHaveValue(preview);
    assert.deepEqual(await meta(sourceId), before);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click(); dialog = await open(sourceId, revisionId);
    await expect(dialog.getByLabel('Review and edit OCR text', { exact: true })).toHaveValue(preview);
    assert.equal((await job(sourceId, ready.id)).calls, pages); assert.deepEqual(await meta(sourceId), before);
    await writeFile(out + 'preview.md', preview); await page.screenshot({ path: out + 'ready-preview.png', fullPage: true });
    await pass('ready_preview', { revisionUnchanged: true, previewSha256: sha(preview), calls: pages });
    currentAction = 'apply_storage_only';
    if (oldText) assert.notEqual(sha(preview), sha(oldText), 'Fixture OCR output must differ from its old readable caption.');
    phase = 'apply'; const appliedResponse = page.waitForResponse(r => r.url() === origin + base(sourceId) + '/' + ready.id + '/apply' && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Apply as new readable revision', exact: true }).click();
    const appliedHttp = await appliedResponse; assert(appliedHttp.ok(), 'Apply failed.');
    const applied = (await appliedHttp.json()) as { revisionId: string }; phase = 'read';
    assert(uuid.test(applied.revisionId) && applied.revisionId !== revisionId);
    const after = await meta(sourceId); assert.equal(after.source.currentRevisionId, applied.revisionId);
    assert.deepEqual(after.revisions.map(r => r.id).sort(), [...before.revisions.map(r => r.id), applied.revisionId].sort());
    assert.equal(sha(await bytes('/api/revisions/' + applied.revisionId + '/text')), sha(preview));
    assert.equal(sha(await bytes('/api/revisions/' + applied.revisionId + '/original')), sha(original));
    assert.equal((await job(sourceId, ready.id)).calls, pages);
    await pass('apply_storage_only', { revisionId: applied.revisionId, previewSha256: sha(preview), calls: pages });
    currentAction = 'repeat_apply'; assert.deepEqual(await json(base(sourceId) + '/' + ready.id + '/apply', {}), applied);
    assert.deepEqual(await meta(sourceId), after); assert.equal((await job(sourceId, ready.id)).calls, pages);
    await pass('repeat_apply', { revisionId: applied.revisionId, extraRevisions: 0, extraCalls: 0 });
    currentAction = 'old_evidence'; assert.equal(sha(await bytes('/api/revisions/' + revisionId + '/original')), sha(original));
    assert.deepEqual(after.revisions.find(r => r.id === revisionId), old);
    if (oldText && oldOutline && oldBlock) {
      assert.equal(sha(await bytes('/api/revisions/' + revisionId + '/text')), sha(oldText));
      assert.deepEqual(await json('/api/revisions/' + revisionId + '/outline'), oldOutline);
      const range = await bytes('/api/revisions/' + revisionId + '/range?start=' + oldBlock.start + '&end=' + oldBlock.end);
      assert(oldRange && range.equals(oldRange));
      await page.goto(origin + '/p/' + projectId + '/source/' + sourceId + '?revisionId=' + revisionId + '&start=' + oldBlock.start + '&end=' + oldBlock.end);
      await expect(page.locator('.er-lib__excerpt pre')).toHaveText(new TextDecoder('utf-8', { ignoreBOM: true }).decode(range));
      await pass('old_evidence', { label: '[R' + revisionId + ':' + oldBlock.id + ']', start: oldBlock.start, end: oldBlock.end, textSha256: sha(oldText) });
    } else actions.old_evidence = { status: 'NOT_RUN', detail: 'Original PDF/revision preserved; this scan has no prior readable text/citable paragraph. A readable PDF fixture is needed for the old-text/citation gate.' };
    if (paid && cancelSource && cancelRevision) {
      currentAction = 'cancel_after_first_call'; const cancellation = await start(cancelSource, cancelRevision, 2); let state = cancellation.value;
      const firstCallDeadline = Math.min(cancellation.deadline, Date.now() + 30_000);
      while (state.calls === 0 && Date.now() < firstCallDeadline) { assert(['queued', 'running'].includes(state.state), state.error ?? state.state); await pause(100); state = await job(cancelSource, state.id); }
      assert.equal(state.calls, 1, 'Cancellation fixture must be stopped during its first actual call.');
      phase = 'cancel'; const stopped = page.waitForResponse(r => r.url() === origin + base(cancelSource) + '/' + state.id + '/cancel' && r.request().method() === 'POST');
      await cancellation.dialog.getByRole('button', { name: 'Stop OCR', exact: true }).click(); assert((await stopped).ok()); phase = 'read';
      const settle = Date.now() + OCR_LIMITS.pageTimeoutMs + 10_000;
      do { await pause(500); state = await job(cancelSource, state.id); assert.equal(state.calls, 1); assert.equal(state.state, 'cancelled'); }
      while (state.completedPages < 1 && Date.now() < settle);
      assert.equal(state.completedPages, 1, 'Cancelled in-flight usage/output did not settle; do not claim a completed cancellation proof.');
      assert.deepEqual(await meta(cancelSource), cancelBefore);
      await pass('cancel_after_first_call', { jobId: state.id, state: state.state, calls: state.calls, completedPages: state.completedPages, inputTokens: state.inputTokens, outputTokens: state.outputTokens });
    }
    assert.deepEqual(blocked, []);
    const complete = Object.entries(actions).every(([name, action]) => action.status === 'PASS'
      || (resumeJob && ['page_uploads', 'start_idempotent'].includes(name) && report.priorProof !== null));
    report.status = complete ? (resumeJob ? 'PASS_RESUMED' : 'PASS') : 'PARTIAL';
  } catch (error) {
    report.status = 'FAIL'; report.failure = error instanceof Error ? error.message : 'Unknown OCR eval failure.';
    const token = process.env.ELIOT_OWNER_JWT?.trim(); if (token) report.failure = report.failure.replaceAll(token, '[redacted]');
    actions[currentAction] = { status: 'FAIL', detail: report.failure };
  } finally {
    await browser?.close(); await save();
    const text = ['# K1 OCR service/browser journey', '', report.scope, '', 'Mode: ' + report.mode, 'Status: ' + report.status,
      ...(report.priorProof ? ['Prior prefix proof (not observed again): ' + report.priorProof.path] : []),
      ...Object.entries(actions).map(([name, action]) => '- ' + name + ': ' + action.status + (action.detail === undefined ? '' : ' — ' + JSON.stringify(action.detail))),
      '', report.failure, '', 'No mocked service/provider responses. No project/source creation or settings writes. Provider token counts remain unknown when the service returns null.', ''].join('\n');
    await writeFile(out + 'summary.md', text); console.log(text);
    if (report.status === 'FAIL' || report.status === 'PARTIAL') process.exitCode = 1;
  }
  return report;
}

if (process.argv.includes('--ocr') || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) await runK1OcrEval();
