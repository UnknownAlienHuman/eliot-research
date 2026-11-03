// Workerd/D1/R2 coverage for attaching a saved shared Library source.
// This fixture has no AI, Workflow, or external network binding.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

assert(process.env.ELIOT_K1_MODEL !== '1' && process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1',
  'K1 Library storage proof forbids model opt-in.');
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wr('miniflare');
const { unstable_splitSqlQuery } = wr('wrangler');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-k1-library-'));
const origin = 'http://127.0.0.1';
const entry = `
import app from ${JSON.stringify(path.join(root, 'src/index.ts'))};
const metrics={r2Gets:[],r2Writes:0,d1Writes:0};
const writeSql=/^\\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|ATTACH|DETACH|PRAGMA)\\b/i;
function instrumentStatement(statement,write){return new Proxy(statement,{get(target,key){
  if(key==='bind')return(...args)=>instrumentStatement(target.bind(...args),write);
  if(['first','all','run','raw'].includes(key))return(...args)=>{if(write)metrics.d1Writes++;return target[key](...args);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});}
function instrumentDb(db){return new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql)=>instrumentStatement(target.prepare(sql),writeSql.test(sql));
  if(key==='batch'||key==='exec')return(...args)=>{metrics.d1Writes++;return target[key](...args);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});}
function instrumentBucket(bucket){return new Proxy(bucket,{get(target,key){
  if(key==='get')return(...args)=>{metrics.r2Gets.push(String(args[0]));return target.get(...args);};
  if(key==='put'||key==='delete')return(...args)=>{metrics.r2Writes++;return target[key](...args);};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});}
export default {async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname==='/__library-metrics/reset'){metrics.r2Gets.length=0;metrics.r2Writes=0;metrics.d1Writes=0;return Response.json({ok:true});}
  if(url.pathname==='/__library-metrics')return Response.json(metrics);
  const wrapped=new Proxy(env,{get(target,key){
    if(key==='BUCKET')return instrumentBucket(Reflect.get(target,key,target));
    if(key==='DB')return instrumentDb(Reflect.get(target,key,target));
    return Reflect.get(target,key,target);
  }});
  return app.fetch(request,wrapped,ctx);
}};`;
const output = path.join(runtime, 'worker.mjs');
await build({
  stdin: { contents: entry, loader: 'ts', resolveDir: root, sourcefile: 'k1-library-fixture.ts' },
  outfile: output,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*', 'node:*'],
  logLevel: 'warning',
  plugins: [{ name: 'node-path', setup(b) {
    b.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'fixture-path' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture-path' }, () => ({ contents: "export * from 'node:path';", loader: 'js' }));
  } }],
});
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: 'library', rootPath: runtime, scriptPath: output, modules: true,
    compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'library-db' }, r2Buckets: { BUCKET: 'library-r2' },
    outboundService: { name: 'no-network' },
    bindings: {
      ELIOT_LOCAL_DEV: '1', ELIOT_ORIGIN: origin, ELIOT_ACCESS_TEAM_DOMAIN: '', ELIOT_ACCESS_AUD: '',
      ELIOT_OWNER_EMAIL: '', ELIOT_OWNER_SERVICE_TOKEN: '', ELIOT_MCP_ORIGIN: '', ELIOT_CF_ACCOUNT_ID: '',
    },
  }, {
    name: 'no-network', modules: true,
    script: "export default{async fetch(){throw new Error('External network forbidden in K1 Library proof');}};",
  }],
  resourcePersistencePath: path.join(runtime, 'state'),
}));

async function rawRequest(pathname, method = 'GET', body?) {
  return mf.dispatchFetch(origin + pathname, { method, headers: {
    Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function requestJson(pathname, method = 'GET', body?) {
  const response = await rawRequest(pathname, method, body);
  const text = await response.text();
  assert(response.ok, JSON.stringify({ pathname, status: response.status, body: text.slice(0, 500) }));
  return JSON.parse(text);
}
async function resetMetrics() { await requestJson('/__library-metrics/reset'); }
async function readMetrics() { return requestJson('/__library-metrics'); }
function uuid(n) { return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`; }
function availablePath(projectId, cursor = null) {
  const base = '/api/projects/' + encodeURIComponent(projectId) + '/sources/available';
  return cursor === null ? base : base + '?cursor=' + encodeURIComponent(cursor);
}
function assertCursor(cursor, projectId, createdAt, sourceId) {
  assert.equal(typeof cursor, 'string');
  assert.deepEqual(JSON.parse(cursor), [projectId, createdAt, sourceId]);
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0) * 10) / 10;
}
function assertNoObjectIO(metrics) {
  assert.deepEqual(metrics.r2Gets, [], 'Available-source listing and attachment must not read canonical objects.');
  assert.equal(metrics.r2Writes, 0);
}
let sourceSeq = 100_000;
async function availablePage(projectId, cursor = null) {
  await resetMetrics();
  const started = performance.now();
  const data = await requestJson(availablePath(projectId, cursor));
  const wallMs = performance.now() - started;
  const metrics = await readMetrics();
  assert(Array.isArray(data.sources));
  assert(Object.hasOwn(data, 'nextCursor'));
  assert(data.nextCursor === null || typeof data.nextCursor === 'string');
  assertNoObjectIO(metrics);
  assert.equal(metrics.d1Writes, 0);
  return { data, metrics, wallMs };
}
async function createProject(db, projectId, name) {
  await db.prepare('INSERT INTO project(id,title,created_at,updated_at) VALUES(?,?,?,?)')
    .bind(projectId, name, 1, 1).run();
}
async function attachExistingEligible(db, projectId) {
  await db.prepare(`INSERT INTO project_source(project_id,source_id,enabled,added_by,added_at)
    SELECT ?,s.id,1,'owner',? FROM source s WHERE s.state='active'
      AND EXISTS(SELECT 1 FROM source_revision r WHERE r.source_id=s.id AND r.deleted_at IS NULL)
    ON CONFLICT(project_id,source_id) DO NOTHING`).bind(projectId, Date.now()).run();
}
async function seedSource(db, bucket, options = {}) {
  const id = options.id ?? uuid(200_000 + sourceSeq++);
  const title = options.title ?? 'Library source ' + id.slice(-4);
  const createdAt = options.createdAt ?? 10;
  const state = options.state ?? 'active';
  await db.prepare(`INSERT INTO source(id,title,kind,state,created_by,created_at,updated_at)
    VALUES(?,?,'text',?,'owner',?,?)`).bind(id, title, state, createdAt, createdAt).run();
  const revisions = [];
  const specs = options.noRevision ? [] : (options.revisions ?? [{ readableState: 'readable' }]);
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    const revisionId = uuid(3_000_000 + sourceSeq * 10 + index);
    const revisionNo = index + 1;
    const revisionAt = spec.createdAt ?? createdAt + index;
    const originalKey = `source/${revisionId}/original`;
    await db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,original_key,original_sha256,original_size,
      original_filename,original_mime,readable_state,converter,readable_size,block_count,conversion_calls,conversion_tokens,
      conversion_ms,distill_state,distill_calls,guide_summary,claim_count,created_by,created_at)
      VALUES(?,?,?,?,?,?,'${title}.txt','text/plain',?,?,?, ?,?,?,? ,?,?,?,?,'owner',?)`)
      .bind(revisionId, id, revisionNo, originalKey, spec.originalSha ?? null, spec.originalSize ?? null,
        spec.readableState ?? 'readable', spec.converter ?? 'local_text', spec.readableSize ?? null, spec.blockCount ?? null,
        spec.conversionCalls ?? 0, spec.conversionTokens ?? null, spec.conversionMs ?? null,
        spec.distillState ?? 'none', spec.distillCalls ?? 0, spec.guideSummary ?? null, spec.claimCount ?? 0, revisionAt).run();
    revisions.push({ id: revisionId, revisionNo, readableState: spec.readableState ?? 'readable', createdAt: revisionAt, ...spec });
  }
  const current = options.currentRevision === false ? null : revisions.at(-1)?.id ?? null;
  if (current) await db.prepare('UPDATE source SET current_revision_id=? WHERE id=?').bind(current, id).run();
  if (options.deletedRevision && revisions.length) {
    await db.prepare('UPDATE source_revision SET deleted_at=? WHERE id=?').bind(createdAt + 500, revisions.at(-1).id).run();
  }
  if (options.projectId) {
    await db.prepare(`INSERT INTO project_source(project_id,source_id,enabled,added_by,added_at) VALUES(?,?,?,?,?)`)
      .bind(options.projectId, id, options.enabled === false ? 0 : 1, 'owner', createdAt).run();
  }
  if (options.reader) await seedReaderArtifacts(db, bucket, id, revisions, title, options.reader);
  return { id, title, createdAt, state, currentRevisionId: current, revisionId: revisions.at(-1)?.id ?? null, revisions };
}
async function seedReaderArtifacts(db, bucket, sourceId, revisions, title, reader) {
  assert.equal(revisions.length, 2, 'Reader reuse fixture needs a retained old and current revision.');
  const oldRevision = revisions[0], current = revisions[1];
  const rows = [];
  for (const [index, revision] of revisions.entries()) {
    const text = index === 0 ? reader.oldText : reader.currentText;
    const bytes = new TextEncoder().encode(text);
    const block = { id: 0, type: 'paragraph', start: 0, end: bytes.byteLength };
    const prefix = `source/${revision.id}/`;
    const report = {
      questions: [`Saved question ${index + 1}`],
      usage: { calls: 2, inputTokens: 101 + index, cachedTokens: index, outputTokens: 31 + index, tokenLimit: 2048, wallMs: 700 + index },
      kept: index === 0 ? 0 : 1, dropped: [], clearedNumbers: 0,
      raw: { first: `retained-call1-${index}`, second: `retained-call2-${index}` }, error: null,
    };
    await bucket.put(prefix + 'original', new TextEncoder().encode(`original ${index}: ${text}`));
    await bucket.put(prefix + 'text.md', bytes, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
    await bucket.put(prefix + 'blocks.json', JSON.stringify([block]), { httpMetadata: { contentType: 'application/json' } });
    await bucket.put(prefix + 'distill.json', JSON.stringify(report), { httpMetadata: { contentType: 'application/json' } });
    await bucket.put(prefix + 'guide.md', `Saved guide for ${index}: ${text}`, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
    await bucket.put(prefix + 'digest.md', `Saved digest for ${index}: ${text}`, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
    await bucket.put(prefix + 'glossary.json', JSON.stringify([{ en: `Term ${index}`, ru: `Термин ${index}`, definition: `Saved definition ${index}`, labels: [] }]), { httpMetadata: { contentType: 'application/json' } });
    if (index === 1) {
      const start = bytes.indexOf(new TextEncoder().encode('Current'));
      const end = Math.min(bytes.byteLength, start + new TextEncoder().encode('Current canonical fact').byteLength);
      await db.prepare(`INSERT INTO claim(id,source_revision_id,ordinal,kind,statement,task,metric,dataset,value_text,value_number,unit,
        conditions,quote,block_index,start_byte,end_byte,ambiguous,created_at)
        VALUES(?,?,0,'result','Retained canonical fact',NULL,'retained-metric','fixture','7',7,'items',NULL,?,0,?,?,0,?)`)
        .bind(uuid(9_000_000 + sourceSeq), revision.id, new TextDecoder().decode(bytes.slice(start, end)), start, end, 1000 + index).run();
    }
    rows.push({ revisionId: revision.id, text, report, usage: report.usage, guide: `Saved guide for ${index}: ${text}` });
  }
  assert.equal(current.id, (await db.prepare('SELECT current_revision_id AS id FROM source WHERE id=?').bind(sourceId).first()).id);
  return { oldRevision, current, rows, title };
}

try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'library');
  const bucket = await mf.getR2Bucket('BUCKET', 'library');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    const sql = await readFile(path.join(root, 'migrations', file), 'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
  }
  let projectSeq = 10_000;
  const nextProject = async (name = 'K1 Library fixture') => {
    const id = uuid(projectSeq++);
    await createProject(db, id, name);
    return id;
  };

  const emptyProject = await nextProject('Empty target');
  const empty = await availablePage(emptyProject);
  assert.deepEqual(empty.data, { sources: [], nextCursor: null });

  const singleProject = await nextProject('One source target');
  const single = await seedSource(db, bucket, { title: 'One shared source', createdAt: 20 });
  const singlePage = await availablePage(singleProject);
  assert.deepEqual(singlePage.data.sources.map((row) => row.id), [single.id]);
  assert.equal(singlePage.data.sources[0].title, single.title);
  assert.equal(singlePage.data.sources[0].revisionId, single.revisionId);
  assert.equal(singlePage.data.nextCursor, null);

  const manyProject = await nextProject('Pagination target');
  await attachExistingEligible(db, manyProject);
  const manyRows = [];
  for (let i = 0; i < 103; i++) manyRows.push(await seedSource(db, bucket, { createdAt: 123, title: 'Tied source ' + i }));
  const orderedMany = [...manyRows].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const seen = [];
  const pageSizes = [];
  let cursor = null;
  let pageNo = 0;
  while (true) {
    const page = await availablePage(manyProject, cursor);
    const expected = orderedMany.slice(pageNo * 50, pageNo * 50 + 50);
    assert.deepEqual(page.data.sources.map((row) => row.id), expected.map((row) => row.id));
    assert.equal(page.data.sources.length, expected.length);
    pageSizes.push(page.data.sources.length);
    seen.push(...page.data.sources.map((row) => row.id));
    pageNo++;
    if (pageNo === 1) assertCursor(page.data.nextCursor, manyProject, expected.at(-1).createdAt, expected.at(-1).id);
    cursor = page.data.nextCursor;
    if (cursor === null) break;
  }
  assert.deepEqual(seen, orderedMany.map((row) => row.id));
  assert.equal(new Set(seen).size, 103);
  assert.equal(pageNo, 3);
  assert.deepEqual(pageSizes, [50, 50, 3]);
  const fiftyRowSamples = [];
  for (let i = 0; i < 13; i++) {
    const sample = await availablePage(manyProject);
    assert.equal(sample.data.sources.length, 50);
    fiftyRowSamples.push(sample.wallMs);
  }

  const filterProject = await nextProject('Eligibility target');
  const otherProject = await nextProject('Other membership');
  await attachExistingEligible(db, filterProject);
  const filterRows = [];
  filterRows.push(await seedSource(db, bucket, { title: 'Unattached active', projectId: undefined, createdAt: 11 }));
  filterRows.push(await seedSource(db, bucket, { title: 'Attached elsewhere', projectId: otherProject, createdAt: 12 }));
  await seedSource(db, bucket, { title: 'Attached enabled', projectId: filterProject, enabled: true, createdAt: 13 });
  await seedSource(db, bucket, { title: 'Attached but disabled', projectId: filterProject, enabled: false, createdAt: 14 });
  await seedSource(db, bucket, { title: 'Archived source', state: 'archived', createdAt: 15 });
  await seedSource(db, bucket, { title: 'Deleted source', state: 'deleted', createdAt: 16 });
  await seedSource(db, bucket, { title: 'Only deleted revision', deletedRevision: true, createdAt: 17 });
  await seedSource(db, bucket, { title: 'No revision', noRevision: true, createdAt: 18 });
  filterRows.push(await seedSource(db, bucket, { title: 'Pending active revision', revisions: [{ readableState: 'pending' }], currentRevision: false, createdAt: 19 }));
  const filtered = await availablePage(filterProject);
  assert.deepEqual(filtered.data.sources.map((row) => row.id), [...filterRows].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).map((row) => row.id));
  assert.deepEqual(filtered.data.sources.map((row) => row.title), ['Pending active revision', 'Attached elsewhere', 'Unattached active']);

  const badCursorProject = await nextProject('Cursor validation target');
  await attachExistingEligible(db, badCursorProject);
  const cursorSource = await seedSource(db, bucket, { createdAt: 40 });
  for (const bad of [
    '{bad', JSON.stringify([uuid(999_999), 40, cursorSource.id]),
    JSON.stringify([badCursorProject, -1, cursorSource.id]),
    JSON.stringify([badCursorProject, 40.5, cursorSource.id]),
    JSON.stringify([badCursorProject, Number.MAX_SAFE_INTEGER + 1, cursorSource.id]),
    JSON.stringify([badCursorProject, 40, 'not-a-uuid']),
  ]) {
    await resetMetrics();
    const response = await rawRequest(availablePath(badCursorProject, bad));
    const text = await response.text();
    assert.equal(response.status, 400, JSON.stringify({ status: response.status, body: text }));
    const stats = await readMetrics();
    assertNoObjectIO(stats);
    assert.equal(stats.d1Writes, 0);
  }
  await resetMetrics();
  const unknownProject = await rawRequest(availablePath(uuid(999_998)));
  assert.equal(unknownProject.status, 404);
  assertNoObjectIO(await readMetrics());

  const changeProject = await nextProject('Changing Library target');
  await attachExistingEligible(db, changeProject);
  const changingRows = [];
  for (let i = 0; i < 103; i++) changingRows.push(await seedSource(db, bucket, { createdAt: 500, title: 'Changing source ' + i }));
  const orderedChanging = [...changingRows].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const firstChanging = await availablePage(changeProject);
  const firstExpected = orderedChanging.slice(0, 50);
  assert.deepEqual(firstChanging.data.sources.map((row) => row.id), firstExpected.map((row) => row.id));
  const attachedDuringPage = orderedChanging[55];
  await resetMetrics();
  const attachResponse = await rawRequest(`/api/projects/${changeProject}/sources/attach`, 'POST', { sourceId: attachedDuringPage.id });
  assert.equal(attachResponse.status, 200, await attachResponse.text());
  const attachStats = await readMetrics();
  assertNoObjectIO(attachStats);
  assert.equal(attachStats.d1Writes, 1);
  const nextChanging = await availablePage(changeProject, firstChanging.data.nextCursor);
  const expectedAfterConcurrentAttach = orderedChanging.slice(50).filter((row) => row.id !== attachedDuringPage.id).slice(0, 50);
  assert.deepEqual(nextChanging.data.sources.map((row) => row.id), expectedAfterConcurrentAttach.map((row) => row.id));
  assert(!nextChanging.data.sources.some((row) => row.id === attachedDuringPage.id));

  const refreshProject = await nextProject('Refresh-after-upload target');
  await attachExistingEligible(db, refreshProject);
  const beforeUpload = [];
  for (let i = 0; i < 51; i++) beforeUpload.push(await seedSource(db, bucket, { createdAt: 700, title: 'Before upload ' + i }));
  const orderedBefore = [...beforeUpload].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const firstBefore = await availablePage(refreshProject);
  assert.deepEqual(firstBefore.data.sources.map((row) => row.id), orderedBefore.slice(0, 50).map((row) => row.id));
  const newlyUploaded = await seedSource(db, bucket, { createdAt: 900, title: 'New upload after paging began' });
  const continued = await availablePage(refreshProject, firstBefore.data.nextCursor);
  assert.deepEqual(continued.data.sources.map((row) => row.id), [orderedBefore[50].id]);
  assert(!continued.data.sources.some((row) => row.id === newlyUploaded.id));
  const refreshed = await availablePage(refreshProject);
  assert.equal(refreshed.data.sources[0].id, newlyUploaded.id);
  assert.deepEqual(refreshed.data.sources.slice(1).map((row) => row.id), orderedBefore.slice(0, 49).map((row) => row.id));

  const attachProject = await nextProject('Attach and reuse target');
  await attachExistingEligible(db, attachProject);
  const oldText = 'Older canonical bytes — сохранённая версия 🌍\n';
  const currentText = 'Current canonical fact — действующая версия 🌐\n';
  const reusable = await seedSource(db, bucket, {
    title: 'Reusable shared source', createdAt: 1000,
    revisions: [
      { readableState: 'readable', originalSize: new TextEncoder().encode(`original 0: ${oldText}`).byteLength, readableSize: new TextEncoder().encode(oldText).byteLength, blockCount: 1, conversionCalls: 1, conversionTokens: 41, conversionMs: 12, distillState: 'partial', distillCalls: 2 },
      { readableState: 'readable', originalSize: new TextEncoder().encode(`original 1: ${currentText}`).byteLength, readableSize: new TextEncoder().encode(currentText).byteLength, blockCount: 1, conversionCalls: 2, conversionTokens: 83, conversionMs: 18, distillState: 'done', distillCalls: 2, claimCount: 1 },
    ],
    reader: { oldText, currentText },
  });
  const listBeforeAttach = await availablePage(attachProject);
  assert(listBeforeAttach.data.sources.some((row) => row.id === reusable.id));
  const beforeRows = await db.prepare(`SELECT id,revision_no,readable_state,conversion_calls,conversion_tokens,conversion_ms,distill_state,distill_calls,claim_count
    FROM source_revision WHERE source_id=? ORDER BY revision_no`).bind(reusable.id).all();
  const beforeHead = await db.prepare('SELECT current_revision_id FROM source WHERE id=?').bind(reusable.id).first();
  await resetMetrics();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await rawRequest(`/api/projects/${attachProject}/sources/attach`, 'POST', { sourceId: reusable.id });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.deepEqual(JSON.parse(text), { sourceId: reusable.id });
    const stats = await readMetrics();
    assertNoObjectIO(stats);
    assert.equal(stats.d1Writes, attempt + 1);
  }
  const membership = await db.prepare('SELECT count(*) AS count FROM project_source WHERE project_id=? AND source_id=?')
    .bind(attachProject, reusable.id).first();
  assert.equal(membership.count, 1);
  const afterRows = await db.prepare(`SELECT id,revision_no,readable_state,conversion_calls,conversion_tokens,conversion_ms,distill_state,distill_calls,claim_count
    FROM source_revision WHERE source_id=? ORDER BY revision_no`).bind(reusable.id).all();
  const afterHead = await db.prepare('SELECT current_revision_id FROM source WHERE id=?').bind(reusable.id).first();
  assert.deepEqual(afterRows.results, beforeRows.results);
  assert.deepEqual(afterHead, beforeHead);

  const currentBytes = new TextEncoder().encode(currentText);
  const oldBytes = new TextEncoder().encode(oldText);
  for (const [revisionId, expectedBytes] of [[reusable.revisions[0].id, oldBytes], [reusable.revisions[1].id, currentBytes]]) {
    const response = await rawRequest(`/api/revisions/${revisionId}/text`);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expectedBytes);
  }
  const understandingResponse = await rawRequest(`/api/sources/${reusable.id}/understanding?revisionId=${reusable.revisions[1].id}`);
  assert.equal(understandingResponse.status, 200);
  const understanding = await understandingResponse.json();
  assert.equal(understanding.sourceId, reusable.id);
  assert.equal(understanding.revisionId, reusable.revisions[1].id);
  assert.equal(understanding.state, 'done');
  assert.equal(understanding.guide, `Saved guide for 1: ${currentText}`);
  assert.equal(understanding.digest, `Saved digest for 1: ${currentText}`);
  assert.equal(understanding.report.usage.calls, 2);
  assert.equal(understanding.report.usage.inputTokens, 102);
  assert.equal(understanding.report.usage.outputTokens, 32);
  assert.equal(understanding.claims.length, 1);
  assert.equal(understanding.claims[0].statement, 'Retained canonical fact');
  assert.equal(understanding.progress.attempts, 2);
  assert.deepEqual(await db.prepare('SELECT current_revision_id FROM source WHERE id=?').bind(reusable.id).first(), beforeHead);
  assert.deepEqual((await db.prepare(`SELECT id,revision_no,readable_state,conversion_calls,conversion_tokens,conversion_ms,distill_state,distill_calls,claim_count
    FROM source_revision WHERE source_id=? ORDER BY revision_no`).bind(reusable.id).all()).results, beforeRows.results);
  const readStats = await readMetrics();
  assert.equal(readStats.r2Writes, 0);

  const postAttachList = await availablePage(attachProject);
  assert(!postAttachList.data.sources.some((row) => row.id === reusable.id));
  const finalMetrics = await readMetrics();
  assert.equal(finalMetrics.r2Writes, 0);
  assert.equal(finalMetrics.d1Writes, 0);
  console.log(JSON.stringify({
    scope: 'K1_LIBRARY_STORAGE', runtime: 'pinned Workerd/D1/R2',
    availablePages: { empty: 0, single: 1, tiedTimestampTotal: 103, pageSizes: [50, 50, 3] },
    localFirstPageWallMs: { samples: fiftyRowSamples.length, p50: percentile(fiftyRowSamples, 0.5), p95: percentile(fiftyRowSamples, 0.95),
      includes: 'local Workerd request and JSON body read; excludes metric/reset calls' },
    projectScopedDescendingCursor: true, malformedAndWrongProjectCursorsRejected: true,
    filters: { attachedEnabledAndDisabled: true, otherProjectMembershipRemainsAvailable: true, archivedDeletedMissingAndDeletedRevision: true },
    attachmentDuringPaging: true, newUploadRequiresRefresh: true,
    attachPostIdempotent: true, retainedOldAndCurrentCanonicalBytes: true, existingUnderstandingAndUsageReused: true,
    availableListR2Gets: 0, attachmentR2Gets: 0, attachmentR2Writes: 0,
    modelCalls: 0, workflowBinding: 'ABSENT', externalNetwork: 'FORBIDDEN',
  }));
} finally {
  await mf.dispose();
}
