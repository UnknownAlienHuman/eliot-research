// Real Workflows/D1/R2 and production browser controls; inference callbacks and external network are forbidden.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
assert(process.env.ELIOT_K3_MODEL !== '1' && process.env.ELIOT_K2_MODEL !== '1', 'Retry proof forbids model opt-in.');
const root = process.cwd(), require = createRequire(path.join(root, 'package.json')), wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild'), { Miniflare, convertV4MiniflareOptions } = wr('miniflare'), { unstable_splitSqlQuery } = wr('wrangler');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-retry-')), origin = 'http://127.0.0.1';
const model = { route: 'workers-ai:retry-fixture', id: 'retry-fixture', label: 'Retry fixture', enabled: true, contextTokens: 262144, maxOutputTokens: 1024, checkedOn: '2026-11-04' };
const entry = `
import app from ${JSON.stringify(path.join(root, 'src/index.ts'))};
import {DistillWorkflow as Base} from ${JSON.stringify(path.join(root, 'src/workflows/distill.ts'))};
export class RetryWorkflow extends Base {
 run(event,step){return super.run(event,{do:(name,options,callback)=>step.do(name,options,
  name==='extract source'||name==='review and synthesize'?async()=>{
    if(!event.payload.attemptId) throw new Error('Fixture stops original attempt before paid dispatch');
    const ordinal=name==='extract source'?1:2;
    await this.env.DB.prepare('UPDATE source_revision SET distill_calls=? WHERE id=? AND distill_attempt_id=? AND distill_calls=?').bind(ordinal,event.payload.revisionId,event.payload.attemptId,ordinal-1).run();
  }:callback)});}
}
export default {async fetch(request,env,ctx){const u=new URL(request.url),id=u.searchParams.get('revisionId');
 if(u.pathname==='/__start')return Response.json({id:(await env.DISTILL.create({id:'distill-'+id,params:{revisionId:id,model:${JSON.stringify(model)}}})).id});
 if(u.pathname==='/__status')return Response.json(await(await env.DISTILL.get(u.searchParams.get('workflowId'))).status());
 return app.fetch(request,env,ctx);}};`;
await build({ stdin: { contents: entry, loader: 'ts', resolveDir: root }, outfile: path.join(runtime, 'worker.mjs'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], logLevel: 'warning',
  plugins: [{ name: 'node-path', setup(b) { b.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'fixture-path' })); b.onLoad({ filter: /.*/, namespace: 'fixture-path' }, () => ({ contents: "export * from 'node:path';", loader: 'js' })); } }] });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'retry', rootPath: runtime, scriptPath: path.join(runtime, 'worker.mjs'), modules: true,
  compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'retry-db' }, r2Buckets: { BUCKET: 'retry-r2' }, workflows: { DISTILL: { name: 'retry', className: 'RetryWorkflow' } }, outboundService: { name: 'no-network' },
  bindings: { ELIOT_LOCAL_DEV: '1', ELIOT_ORIGIN: origin, ELIOT_ACCESS_TEAM_DOMAIN: '', ELIOT_ACCESS_AUD: '', ELIOT_OWNER_EMAIL: '', ELIOT_OWNER_SERVICE_TOKEN: '', ELIOT_MCP_ORIGIN: '', ELIOT_CF_ACCOUNT_ID: '' } },
  { name: 'no-network', modules: true, script: "export default{fetch(){throw new Error('External network forbidden in retry proof');}};" }], resourcePersistencePath: path.join(runtime, 'state') }));
const request = async (p: string, body?: unknown) => {
  const r = await mf.dispatchFetch(origin + p, { headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await r.json() as any; assert(r.ok, JSON.stringify({ p, status: r.status, data })); return data;
};
const wait = async (id: string) => {
  const deadline = Date.now() + 30000; let status;
  do { status = await request('/__status?workflowId=' + id); if (['complete', 'errored', 'terminated'].includes(status.status)) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
  assert.equal(status.status, 'complete', JSON.stringify(status));
};
let server, browser;
try {
  await mf.ready; const db = await mf.getD1Database('DB', 'retry'), bucket = await mf.getR2Bucket('BUCKET', 'retry');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) await db.batch(unstable_splitSqlQuery(await readFile(path.join(root, 'migrations', file), 'utf8')).map(sql => db.prepare(sql)));
  await db.prepare("UPDATE settings SET native_usage_mode='standard',distill_model=? WHERE id=1").bind(model.route).run();
  await bucket.put('catalog/models.json', JSON.stringify({ updatedAt: '2026-11-04', warnings: [], models: [model] }));
  const source = crypto.randomUUID(), revision = crypto.randomUUID(), retryId = crypto.randomUUID(), prefix = 'source/' + revision + '/';
  const text = 'The method retains canonical evidence. The source describes normalization.';
  await db.batch([db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES(?,'Fixture','text','owner',1,1)").bind(source),
    db.prepare("INSERT INTO source_revision(id,source_id,revision_no,readable_state,readable_size,created_by,created_at,distill_state,distill_started_at,distill_model) VALUES(?,?,1,'readable',?,'owner',1,'running',?,?)").bind(revision, source, text.length, Date.now(), model.route),
    db.prepare('UPDATE source SET current_revision_id=? WHERE id=?').bind(revision, source)]);
  await bucket.put(prefix + 'text.md', text); await bucket.put(prefix + 'blocks.json', JSON.stringify([{ id: 1, type: 'paragraph', start: 0, end: text.length, heading: null }]));
  await request('/__start?revisionId=' + revision); await wait('distill-' + revision);
  const old = await db.prepare('SELECT * FROM source_revision WHERE id=?').bind(revision).first();
  const oldReport = await bucket.get(prefix + 'distill.json'), oldBody = await oldReport.text(), oldEtag = oldReport.etag;
  const guide = ['The method retains evidence.', 'The source describes normalization.', 'The method is described in the source.'].map(text => ({ labels: ['[S1:1]'], text }));
  const usage = { inputTokens: 17, cachedTokens: 0, outputTokens: 8, tokenLimit: 263168 };
  const attempted = prefix + 'understanding/' + retryId + '/';
  await bucket.put(attempted + 'distill-call1.json', JSON.stringify({ output: { guide, questions: ['Which method?', 'Which evidence?', 'What source?'], claims: [{ quoteBlock: '[S1:1]', kind: 'method', statement: 'The method retains canonical evidence.', task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }] }, usage }));
  await bucket.put(attempted + 'distill-call2.json', JSON.stringify({ output: { supportedClaims: [], additionalClaims: [], guide, digest: [guide[0]], glossary: [] }, usage }));
  const p = '/api/sources/' + source + '/understanding', input = { revisionId: revision, model: model.route, retry: { attemptId: retryId, previousAttemptId: revision } };
  assert.equal((await request(p, input)).attemptId, retryId); await wait('distill-attempt-' + retryId);
  assert.equal((await request(p, input)).attemptId, retryId);
  const current = await request(p + '?revisionId=' + revision); assert.equal(current.state, 'partial'); assert.equal(current.progress.attempts, 2); assert.equal(current.claims.length, 0);
  await request(p, { revisionId: revision, saveAvailable: true });
  assert.equal((await request(p + '?revisionId=' + revision)).report.artifacts.guide, attempted + 'checked/guide.md');
  const history = await request(p + '/history?revisionId=' + revision); assert.equal(history.attempts.length, 1);
  const snapshot = await (await bucket.get(prefix + 'history/' + retryId + '.json')).json(); assert.deepEqual(snapshot.revision, old);
  const prior = await request(p + '?revisionId=' + revision + '&attemptId=' + revision); assert.equal(prior.state, 'failed'); assert.equal(prior.canRecover, false);
  assert.equal(await (await bucket.get(prefix + 'distill.json')).text(), oldBody); assert.equal((await bucket.get(prefix + 'distill.json')).etag, oldEtag);
  assert.equal(await (await bucket.get(prefix + 'text.md')).text(), text);

  const rejectedId = crypto.randomUUID();
  const rejectedInput = { revisionId: revision, model: 'workers-ai:missing-fixture', retry: { attemptId: rejectedId, previousAttemptId: retryId } };
  const rejected = await request(p, rejectedInput); assert(rejected.rejected);
  assert.equal((await request(p, rejectedInput)).rejected, rejected.rejected);
  const rejectedRead = await request(p + '?revisionId=' + revision + '&requestId=' + rejectedId);
  assert.equal(rejectedRead.knownRequestId, rejectedId); assert.equal(rejectedRead.requestRejection, rejected.rejected);
  assert.equal((await request(p + '/history?revisionId=' + revision)).attempts.length, 1);
  const partialBefore = await db.prepare('SELECT * FROM source_revision WHERE id=?').bind(revision).first();
  const thirdId = crypto.randomUUID(), third = prefix + 'understanding/' + thirdId + '/';
  await bucket.put(third + 'distill-call1.json', await (await bucket.get(attempted + 'distill-call1.json')).text());
  const thirdOutput = JSON.parse(await (await bucket.get(attempted + 'distill-call2.json')).text()); thirdOutput.output.supportedClaims = ['C0'];
  await bucket.put(third + 'distill-call2.json', JSON.stringify(thirdOutput));
  await request(p, { revisionId: revision, model: model.route, retry: { attemptId: thirdId, previousAttemptId: retryId } }); await wait('distill-attempt-' + thirdId);
  assert.equal((await request(p + '?revisionId=' + revision)).state, 'done');
  const partialHistory = await request(p + '?revisionId=' + revision + '&attemptId=' + retryId); assert.equal(partialHistory.state, 'partial'); assert(partialHistory.guide);
  assert.deepEqual((await (await bucket.get(attempted + 'history/' + thirdId + '.json')).json()).revision, partialBefore);
  assert.equal((await request(p + '/history?revisionId=' + revision)).attempts.length, 2);

  // Mount the real production control with local, deterministic API faults.
  await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{MemoryRouter}from'react-router';import{SourceUnderstanding}from ${JSON.stringify(path.join(root, 'src/web/Understanding.tsx'))};createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><SourceUnderstanding projectId="project" sourceId="${source}" revisionId="${revision}" sourceTitle="Fixture"/></MemoryRouter></QueryClientProvider>);`, loader: 'tsx', resolveDir: root }, outfile: path.join(runtime, 'app.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'warning' });
  server = createServer(async (req, res) => { const file = req.url === '/app.js' ? 'app.js' : req.url === '/app.css' ? 'app.css' : null;
    res.setHeader('Content-Type', file?.endsWith('.js') ? 'text/javascript' : file ? 'text/css' : 'text/html'); res.end(file ? await readFile(path.join(runtime, file)) : '<div id="root"></div><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object'); const browserOrigin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage(), posts: any[] = [], errors: string[] = [];
    let known = false, acceptedId = revision, malformed = false, uiState = 'partial', rejectedRequest: string | null = null;
    const alternate = { ...model, route: 'workers-ai:alternate-fixture', id: 'alternate-fixture', label: 'Alternate fixture' };
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => new URL(route.request().url()).origin === browserOrigin ? route.fallback() : route.abort());
    await context.route('**/api/**', async route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/history')) return route.fulfill({ json: { attempts: [{ attemptId: revision, archivedAt: 1 }], nextCursor: null } });
      if (u.pathname === '/api/models') return route.fulfill({ json: { models: [model, alternate] } });
      if (route.request().method() === 'POST') { const input = route.request().postDataJSON(); posts.push(input);
        return malformed ? route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }) : route.abort('connectionclosed'); }
      return route.fulfill({ json: { ...current, state: u.searchParams.has('attemptId') ? 'partial' : uiState, attemptId: u.searchParams.get('attemptId') ?? acceptedId, currentAttemptId: acceptedId, canRecover: !u.searchParams.has('attemptId'), error: u.searchParams.has('attemptId') ? 'Archived failure' : 'Stored failure', knownRequestId: rejectedRequest ?? (known ? acceptedId : null), requestRejection: rejectedRequest ? 'The selected model became unavailable. No retry was started.' : null, progress: { ...current.progress, configuredModel: model.route } } });
    });
    await page.goto(browserOrigin); const region = page.getByRole('region', { name: 'Understanding', exact: true });
    await region.getByRole('button', { name: 'Retry understanding', exact: true }).click(); await expect(region).toContainText('Request outcome is unknown.');
    const pending = posts[0]; assert(pending.retry.attemptId && pending.retry.previousAttemptId === revision);
    await region.getByRole('button', { name: 'Reload understanding', exact: true }).click();
    await expect(region.getByRole('button', { name: 'Send same request', exact: true })).toBeVisible();
    await expect(region.getByRole('button', { name: 'Retry understanding', exact: true })).toHaveCount(0);
    await expect(region.getByRole('button', { name: 'Save available output', exact: true })).toHaveCount(0);
    await page.reload(); await expect(region.getByRole('button', { name: 'Send same request', exact: true })).toBeVisible(); assert.equal(posts.length, 1);
    malformed = true; await region.getByRole('button', { name: 'Send same request', exact: true }).click(); await expect(region).toContainText('Request outcome is unknown.'); assert.deepEqual(posts[1], pending);
    // Delayed original acceptance can finish after a GET of its old predecessor.
    known = true; acceptedId = pending.retry.attemptId; uiState = 'failed';
    await region.getByRole('button', { name: 'Reload understanding', exact: true }).click();
    await expect(region.getByRole('button', { name: 'Retry understanding', exact: true })).toBeVisible(); assert.equal(posts.length, 2);
    await region.getByRole('button', { name: 'Previous attempts', exact: true }).click();
    await region.getByRole('button', { name: 'View previous attempt 1', exact: true }).click();
    await expect(region).toContainText('Archived failure');
    await expect(region.getByRole('button', { name: 'Retry understanding', exact: true })).toHaveCount(0);
    await expect(region.getByRole('button', { name: 'Save available output', exact: true })).toHaveCount(0);
    await region.getByRole('button', { name: 'Current attempt', exact: true }).click();
    await expect(region.getByRole('button', { name: 'Retry understanding', exact: true })).toBeVisible();
    await region.getByRole('button', { name: 'Retry understanding', exact: true }).click(); await expect.poll(() => posts.length).toBe(3);
    assert.notEqual(posts[2].retry.attemptId, pending.retry.attemptId); assert.equal(posts[2].retry.previousAttemptId, pending.retry.attemptId);
    await expect(region).toContainText('Request outcome is unknown.');
    const pendingB = posts[2];
    // A's cached acknowledgement must never clear a newly pending B.
    await page.reload(); await expect(region.getByRole('button', { name: 'Send same request', exact: true })).toBeVisible();
    await region.getByRole('button', { name: 'Send same request', exact: true }).click(); await expect.poll(() => posts.length).toBe(4);
    assert.deepEqual(posts[3], pendingB);
    await expect(region).toContainText('Request outcome is unknown.');
    rejectedRequest = pendingB.retry.attemptId;
    await region.getByRole('button', { name: 'Reload understanding', exact: true }).click();
    await expect(region.getByRole('button', { name: 'Retry understanding', exact: true })).toBeVisible();
    await expect(region).toContainText('No retry was started.');
    await region.getByRole('combobox', { name: 'Understanding model: provider', exact: true }).selectOption('workers-ai');
    await region.getByRole('combobox', { name: 'Understanding model', exact: true }).selectOption(alternate.route);
    await region.getByRole('button', { name: 'Retry understanding', exact: true }).click(); await expect.poll(() => posts.length).toBe(5);
    assert.equal(posts[4].model, alternate.route); assert.notEqual(posts[4].retry.attemptId, pendingB.retry.attemptId);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ scope: 'K3_EXPLICIT_RETRY', nativeWorkflow: true, strictMigrations: true, archivedReceiptExact: true, oldBytesEtagsPreserved: true, attemptScopedSaveGet: true, browserWidths: [1440, 390], lostMalformedReplyRemountReplay: true, delayedAcceptance: true, partialRetry: true, durableRejectionAndNewModel: true, modelCalls: 0, paidProducerCallbacks: 'SKIPPED_WITH_RETAINED_SYNTHETIC_OUTPUT' }));
} finally { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await mf.dispose(); }
