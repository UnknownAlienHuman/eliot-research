// Read-only Workerd/D1/R2 coverage for the deterministic K3 project overview.
// No model bindings or external network are available in this fixture.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

assert(process.env.ELIOT_K3_MODEL !== '1', 'Overview storage proof forbids model opt-in.');
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild');
const { Miniflare, convertV4MiniflareOptions } = wr('miniflare');
const { unstable_splitSqlQuery } = wr('wrangler');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-overview-'));
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
  if(url.pathname==='/__overview-metrics/reset'){metrics.r2Gets.length=0;metrics.r2Writes=0;metrics.d1Writes=0;return Response.json({ok:true});}
  if(url.pathname==='/__overview-metrics')return Response.json(metrics);
  const wrapped=new Proxy(env,{get(target,key){
    if(key==='BUCKET')return instrumentBucket(Reflect.get(target,key,target));
    if(key==='DB')return instrumentDb(Reflect.get(target,key,target));
    return Reflect.get(target,key,target);
  }});
  return app.fetch(request,wrapped,ctx);
}};`;
const output = path.join(runtime, 'worker.mjs');
await build({
  stdin: { contents: entry, loader: 'ts', resolveDir: root, sourcefile: 'overview-fixture.ts' },
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
    name: 'overview', rootPath: runtime, scriptPath: output, modules: true,
    compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'overview-db' }, r2Buckets: { BUCKET: 'overview-r2' },
    outboundService: { name: 'no-network' },
    bindings: {
      ELIOT_LOCAL_DEV: '1', ELIOT_ORIGIN: origin, ELIOT_ACCESS_TEAM_DOMAIN: '', ELIOT_ACCESS_AUD: '',
      ELIOT_OWNER_EMAIL: '', ELIOT_OWNER_SERVICE_TOKEN: '', ELIOT_MCP_ORIGIN: '', ELIOT_CF_ACCOUNT_ID: '',
    },
  }, {
    name: 'no-network', modules: true,
    script: "export default{async fetch(){throw new Error('External network forbidden in overview proof');}};",
  }],
  resourcePersistencePath: path.join(runtime, 'state'),
}));

async function rawRequest(pathname) {
  return mf.dispatchFetch(origin + pathname, { headers: { Origin: origin } });
}
async function request(pathname) {
  const response = await rawRequest(pathname);
  const text = await response.text();
  assert(response.ok, JSON.stringify({ pathname, status: response.status, body: text.slice(0, 500) }));
  return JSON.parse(text);
}
async function resetMetrics() { await request('/__overview-metrics/reset'); }
async function metrics() { return request('/__overview-metrics'); }
function uuid(n) { return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`; }
function overviewPath(projectId, cursor = null) {
  const path = '/api/projects/' + encodeURIComponent(projectId) + '/overview';
  return cursor === null ? path : path + '?cursor=' + encodeURIComponent(cursor);
}
function assertCursor(cursor, projectId, createdAt, sourceId) {
  assert.equal(typeof cursor, 'string');
  assert.deepEqual(JSON.parse(cursor), [projectId, createdAt, sourceId]);
}
function assertReadOnly(stats, expectedKeys) {
  assert.deepEqual(stats.r2Gets, expectedKeys);
  assert.equal(stats.r2Writes, 0);
  assert.equal(stats.d1Writes, 0);
}
const overviewWallSamples = [];
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return Math.round((sorted[Math.ceil(fraction * sorted.length) - 1] ?? 0) * 10) / 10;
}
async function overviewPage(projectId, cursor = null) {
  await resetMetrics();
  const started = performance.now();
  const data = await request(overviewPath(projectId, cursor));
  const wallMs = performance.now() - started;
  overviewWallSamples.push({ pageSize: data.sources.length, wallMs });
  assert(Array.isArray(data.sources));
  assert(Object.hasOwn(data, 'nextCursor'));
  assert(data.nextCursor === null || typeof data.nextCursor === 'string');
  return { data, metrics: await metrics(), wallMs };
}
async function createProject(db, projectId) {
  await db.prepare('INSERT INTO project(id,title,created_at,updated_at) VALUES(?,?,?,?)')
    .bind(projectId, 'Overview fixture ' + projectId.slice(-4), 1, 1).run();
}
async function seedSource(db, bucket, projectId, sourceId, options = {}) {
  const revisionId = uuid(3_000_000 + Number.parseInt(sourceId.slice(-12), 16));
  const createdAt = options.createdAt ?? 10;
  const title = options.title ?? 'Source ' + sourceId.slice(-4);
  const state = options.sourceState ?? 'active';
  const readableState = options.readableState ?? 'readable';
  const distillState = options.distillState ?? 'done';
  const summary = options.summary ?? 'Guide summary for ' + sourceId.slice(-4);
  const reportKey = options.reportKey ?? null;
  const effectiveKey = reportKey ?? `source/${revisionId}/distill.json`;
  await db.batch([
    db.prepare(`INSERT INTO source(id,title,kind,state,created_by,created_at,updated_at)
      VALUES(?,?,'text',?,'owner',?,?)`).bind(sourceId, title, state, createdAt, createdAt),
    db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at,
      distill_state,guide_summary,distill_report_key) VALUES(?,?,1,?,'owner',?,?,?,?)`)
      .bind(revisionId, sourceId, readableState, createdAt, distillState, summary, reportKey),
    ...(options.setCurrent === false ? [] : [db.prepare('UPDATE source SET current_revision_id=? WHERE id=?').bind(revisionId, sourceId)]),
    ...(options.attach === false ? [] : [db.prepare(`INSERT INTO project_source(project_id,source_id,enabled,added_by,added_at)
      VALUES(?,?,?,?,?)`).bind(projectId, sourceId, options.enabled === false ? 0 : 1, 'owner', createdAt)]),
  ]);
  if (options.report !== false) {
    const body = options.invalidReport ? '{' : JSON.stringify({
      state: distillState,
      questions: options.questions ?? ['Question for ' + sourceId.slice(-4)],
      usage: { calls: 2, inputTokens: 1, outputTokens: 1 },
    });
    await bucket.put(effectiveKey, body, { httpMetadata: { contentType: 'application/json' } });
  }
  if (options.deletedRevision) await db.prepare('UPDATE source_revision SET deleted_at=? WHERE id=?').bind(createdAt + 1, revisionId).run();
  return { sourceId, revisionId, createdAt, title, state, readableState, distillState, summary,
    reportKey: effectiveKey, questions: options.report === false || options.invalidReport ? [] : (options.questions ?? ['Question for ' + sourceId.slice(-4)]) };
}
async function assertPageReads(page, expectedRows) {
  assertReadOnly(page.metrics, expectedRows.map((row) => row.reportKey));
  assert.deepEqual(page.data.sources.map((row) => row.sourceId), expectedRows.map((row) => row.sourceId));
  assert.deepEqual(page.data.sources.map((row) => row.revisionId), expectedRows.map((row) => row.revisionId));
  assert.deepEqual(page.data.sources.map((row) => row.title), expectedRows.map((row) => row.title));
  assert.deepEqual(page.data.sources.map((row) => row.summary), expectedRows.map((row) => row.summary));
  assert.deepEqual(page.data.sources.map((row) => row.questions), expectedRows.map((row) => row.questions));
}

try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'overview');
  const bucket = await mf.getR2Bucket('BUCKET', 'overview');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    const sql = await readFile(path.join(root, 'migrations', file), 'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
  }

  let projectSeq = 10_000;
  let sourceSeq = 100_000;
  const nextProject = async () => {
    const id = uuid(projectSeq++);
    await createProject(db, id);
    return id;
  };
  const seedMany = async (projectId, count, createdAt = 10) => {
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push(await seedSource(db, bucket, projectId, uuid(sourceSeq++), { createdAt: createdAt + 0, questions: ['Question ' + i] }));
    }
    return rows;
  };

  const emptyProject = await nextProject();
  const empty = await overviewPage(emptyProject);
  assert.deepEqual(empty.data, { sources: [], nextCursor: null });
  assertReadOnly(empty.metrics, []);

  const oneProject = await nextProject();
  const oneSourceId = uuid(sourceSeq++);
  const oneRevisionId = uuid(3_000_000 + Number.parseInt(oneSourceId.slice(-12), 16));
  const customReportKey = `source/${oneRevisionId}/checked/distill.json`;
  const oneRows = [await seedSource(db, bucket, oneProject, oneSourceId, {
    createdAt: 20, reportKey: customReportKey, questions: ['Custom report question'],
  })];
  // The overview must follow the stored report key, not guess the default R2 path.
  const one = await overviewPage(oneProject);
  await assertPageReads(one, oneRows);
  assert.equal(one.data.nextCursor, null);

  const fiftyProject = await nextProject();
  const fiftyRows = await seedMany(fiftyProject, 50);
  const fifty = await overviewPage(fiftyProject);
  await assertPageReads(fifty, fiftyRows);
  assert.equal(fifty.data.nextCursor, null);

  const fiftyOneProject = await nextProject();
  const fiftyOneRows = await seedMany(fiftyOneProject, 51);
  const first51 = await overviewPage(fiftyOneProject);
  const page1Rows = fiftyOneRows.slice(0, 50);
  await assertPageReads(first51, page1Rows);
  assert.equal(first51.data.sources.length, 50);
  assertCursor(first51.data.nextCursor, fiftyOneProject, page1Rows[49].createdAt, page1Rows[49].sourceId);
  const second51 = await overviewPage(fiftyOneProject, first51.data.nextCursor);
  await assertPageReads(second51, fiftyOneRows.slice(50));
  assert.equal(second51.data.nextCursor, null);

  const manyProject = await nextProject();
  const manyRows = await seedMany(manyProject, 103, 123);
  const manySeen = [];
  let cursor = null;
  let pageNumber = 0;
  while (true) {
    const page = await overviewPage(manyProject, cursor);
    const expected = manyRows.slice(pageNumber * 50, pageNumber * 50 + 50);
    await assertPageReads(page, expected);
    manySeen.push(...page.data.sources.map((row) => row.sourceId));
    pageNumber++;
    if (pageNumber === 1) {
      const anchor = manyRows[49];
      const nextRevision = uuid(8_000_001);
      const nextReportKey = `source/${nextRevision}/distill.json`;
      await db.batch([
        db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at,
          distill_state,guide_summary,distill_report_key) VALUES(?,?,2,'readable','owner',?,?,?,?)`)
          .bind(nextRevision, anchor.sourceId, 999, 'done', 'Updated guide summary', null),
        db.prepare('UPDATE source SET title=?,current_revision_id=? WHERE id=?')
          .bind('Updated title', nextRevision, anchor.sourceId),
      ]);
      await bucket.put(nextReportKey, JSON.stringify({ questions: ['Question for updated head'] }));
      assert.equal(page.data.sources[49].title, anchor.title);
      assert.equal(page.data.sources[49].revisionId, anchor.revisionId);
      await db.prepare("UPDATE source SET state='deleted' WHERE id=?").bind(anchor.sourceId).run();
    }
    cursor = page.data.nextCursor;
    if (cursor === null) break;
  }
  assert.equal(pageNumber, 3);
  assert.deepEqual(manySeen, manyRows.map((row) => row.sourceId));
  assert.equal(new Set(manySeen).size, manySeen.length);

  const filtersProject = await nextProject();
  const filterRows = [];
  filterRows.push(await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 1, questions: ['Default question'] }));
  filterRows.push(await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), {
    createdAt: 2, enabled: false, readableState: 'readable_with_warnings',
    reportKey: `source/${uuid(9_000_002)}/checked/distill.json`, questions: ['Disabled member question'],
  }));
  await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 3, sourceState: 'archived' });
  await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 4, sourceState: 'deleted' });
  await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 5, attach: false });
  await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 6, deletedRevision: true });
  await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 7, setCurrent: false, readableState: 'pending' });
  filterRows.push(await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 8, report: false }));
  filterRows.push(await seedSource(db, bucket, filtersProject, uuid(sourceSeq++), { createdAt: 9, invalidReport: true }));
  const filtered = await overviewPage(filtersProject);
  await assertPageReads(filtered, filterRows);
  assert.equal(filtered.data.sources.length, 4);

  const cursorProject = await nextProject();
  const cursorRows = await seedMany(cursorProject, 51, 44);
  const cursorPage = await overviewPage(cursorProject);
  assertCursor(cursorPage.data.nextCursor, cursorProject, cursorRows[49].createdAt, cursorRows[49].sourceId);
  for (const badCursor of ['{bad', JSON.stringify([cursorProject, 'not-an-integer', cursorRows[49].sourceId]),
    JSON.stringify([cursorProject, cursorRows[49].createdAt, 'm']),
    JSON.stringify([uuid(999_999), cursorRows[49].createdAt, cursorRows[49].sourceId])]) {
    await resetMetrics();
    const response = await rawRequest(overviewPath(cursorProject, badCursor));
    const body = await response.text();
    assert.equal(response.status, 400, JSON.stringify({ status: response.status, body }));
    assertReadOnly(await metrics(), []);
  }

  const refreshProject = await nextProject();
  const refreshRows = await seedMany(refreshProject, 51, 700);
  const detached = await seedSource(db, bucket, refreshProject, uuid(1), { createdAt: 1, attach: false });
  const refreshPage1 = await overviewPage(refreshProject);
  await assertPageReads(refreshPage1, refreshRows.slice(0, 50));
  const oldCursor = refreshPage1.data.nextCursor;
  assertCursor(oldCursor, refreshProject, refreshRows[49].createdAt, refreshRows[49].sourceId);
  await db.prepare(`INSERT INTO project_source(project_id,source_id,enabled,added_by,added_at) VALUES(?,?,1,'owner',?)`)
    .bind(refreshProject, detached.sourceId, detached.createdAt).run();
  const continued = await overviewPage(refreshProject, oldCursor);
  await assertPageReads(continued, refreshRows.slice(50));
  assert(!continued.data.sources.some((row) => row.sourceId === detached.sourceId));
  const refreshed = await overviewPage(refreshProject);
  await assertPageReads(refreshed, [detached, ...refreshRows.slice(0, 49)]);

  const counts = await request('/__overview-metrics');
  assert.equal(counts.r2Writes, 0);
  assert.equal(counts.d1Writes, 0);
  const wallValues = overviewWallSamples.map((sample) => sample.wallMs);
  console.log(JSON.stringify({
    scope: 'K3_OVERVIEW_STORAGE', runtime: 'pinned Workerd/D1/R2',
    counts: { empty: 0, one: 1, exactPage: 50, lookahead: 51, multipage: 103 },
    localOverviewReads: { unit: 'ms', samples: overviewWallSamples.map((sample) => ({ pageSize: sample.pageSize, wallMs: Math.round(sample.wallMs * 10) / 10 })),
      p50: percentile(wallValues, 0.5), p95: percentile(wallValues, 0.95), includes: 'Workerd overview request and JSON body read; excludes metric/reset requests' },
    stableEqualTimestampCursor: true, titleHeadDeletedAnchor: true, refreshFindsEarlierAttachment: true,
    projectAndMalformedCursorRejected: true, activeMembershipReadableFilters: true,
    storedQuestionsAndCustomReportKeys: true, r2ReadsLimitedToReturnedRows: true,
    d1AndR2Writes: 0, externalNetwork: 'FORBIDDEN', modelCalls: 0,
  }));
} finally {
  await mf.dispose();
}
