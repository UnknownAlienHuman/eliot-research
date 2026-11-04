// Workerd/D1/R2 coverage for attaching a saved shared Library source.
// No AI or external network; the Workflow only counts dispatches.
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
import {addSource,updateProject} from ${JSON.stringify(path.join(root, 'src/library.ts'))};
import {WorkflowEntrypoint} from 'cloudflare:workers';
export class FixtureIngest extends WorkflowEntrypoint {
  run(event,step){return step.do('count storage-only dispatch',()=>this.env.DB.prepare(
    'UPDATE fixture_ingest_dispatch SET completed=completed+1 WHERE id=?').bind(event.instanceId).run());}
}
const metrics={r2Gets:[],r2Writes:0,d1Writes:0};
const writeSql=/^\\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|ATTACH|DETACH|PRAGMA)\\b/i;
function instrumentStatement(statement,write,fault){return new Proxy(statement,{get(target,key){
  if(key==='bind')return(...args)=>instrumentStatement(target.bind(...args),write,fault);
  if(['first','all','run','raw'].includes(key))return async(...args)=>{
    if(write)metrics.d1Writes++;
    if(fault==='before')throw new Error('Synthetic chat INSERT before commit');
    const result=await target[key](...args);
    if(fault==='after')throw new Error('Synthetic chat INSERT lost commit acknowledgement');
    return result;
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});}
function instrumentDb(db,fault){return new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql)=>instrumentStatement(target.prepare(sql),writeSql.test(sql),sql.startsWith('INSERT INTO chat(')?fault:null);
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
  if(url.pathname==='/__source-pair'){
    const {projectId,inputs,first=0,fault}=await request.json();
    let arrivals=0,releaseReady,rejectReady,releaseFirst;
    const ready=new Promise((resolve,reject)=>{releaseReady=resolve;rejectReady=reject;}),firstDone=new Promise(resolve=>releaseFirst=resolve),keys=[];
    const timer=setTimeout(()=>rejectReady(new Error('Source preflights did not overlap')),3000);
    let outcomes;
    try{outcomes=await Promise.all(inputs.map(async(input,index)=>{
      const DB=new Proxy(env.DB,{get(target,key){
        if(key==='batch')return async statements=>{
          if(index!==first)await firstDone;
          if(fault==='before')throw new Error('Synthetic revision batch unavailable');
          const saved=await target.batch(statements);
          if(fault==='after')throw new Error('Synthetic revision batch committed, reply lost');
          return saved;
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      const BUCKET={async put(key,...args){keys[index]=key;const stored=await env.BUCKET.put(key,...args);
        if(++arrivals===inputs.length)releaseReady();await ready;return stored;},delete:key=>env.BUCKET.delete(key)};
      const INGEST={async create(options){await env.DB.prepare('INSERT INTO fixture_ingest_dispatch(id,revision_id,starts,completed) VALUES(?,?,1,0) '+
        'ON CONFLICT(id) DO UPDATE SET starts=starts+1').bind(options.id,options.params.revisionId).run();return env.INGEST.create(options);},
        get:id=>env.INGEST.get(id)};
      try{return {ok:true,value:await addSource({...env,DB,BUCKET,INGEST},{type:'owner'},projectId,
        {title:'Duplicate boundary',kind:'text',bytes:new TextEncoder().encode(input.text).buffer,filename:'fixture.md',mimeType:'text/markdown',
          ...(input.sourceId?{sourceId:input.sourceId}:{})})};}
      catch(error){return {ok:false,status:error.status,code:error.code,duplicate:error.duplicate,message:error.message};}
      finally{if(index===first)releaseFirst();}
    }));}finally{clearTimeout(timer);}
    return Response.json({outcomes,arrivals,keys});
  }
  if(url.pathname==='/__project-pair'){
    const {id,title}=await request.json();
    let reads=0,release,reject;
    const gate=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
    const timer=setTimeout(()=>reject(new Error('Two project reads did not overlap')),3000);
    const db=new Proxy(env.DB,{get(target,key){
      if(key==='prepare')return sql=>{
        const statement=target.prepare(sql);
        if(!sql.includes('FROM project WHERE id=?'))return statement;
        return {bind(...args){const bound=statement.bind(...args);return {async first(){
          const row=await bound.first();if(++reads===2)release();await gate;return row;
        }};}};
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
    try{await Promise.all([
      updateProject({...env,DB:db},{type:'owner'},id,{title}),
      updateProject({...env,DB:db},{type:'owner'},id,{archived:false}),
    ]);}finally{clearTimeout(timer);}
    return Response.json({reads});
  }
  if(url.pathname==='/__library-metrics/reset'){metrics.r2Gets.length=0;metrics.r2Writes=0;metrics.d1Writes=0;return Response.json({ok:true});}
  if(url.pathname==='/__library-metrics')return Response.json(metrics);
  const wrapped=new Proxy(env,{get(target,key){
    if(key==='BUCKET')return instrumentBucket(Reflect.get(target,key,target));
    if(key==='DB')return instrumentDb(Reflect.get(target,key,target),request.headers.get('x-test-chat-create-fault'));
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
    workflows: { INGEST: { name: 'library-storage-counter', className: 'FixtureIngest' } },
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

async function rawRequest(pathname, method = 'GET', body?, headers = {}) {
  return mf.dispatchFetch(origin + pathname, { method, headers: {
    Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
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

async function replacementDuplicateChecks(db, bucket) {
  await db.exec('CREATE TABLE fixture_ingest_dispatch(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,starts INTEGER NOT NULL,completed INTEGER NOT NULL)');
  const projectId = uuid(99_999_001), retained = [], dispatched = [];
  await createProject(db, projectId, 'Concurrent replacements');
  async function target() {
    const source = await seedSource(db, bucket, { projectId });
    const key = `source/${source.revisionId}/original`, text = 'Retained original ' + source.id;
    await bucket.put(key, text); retained.push({ source, key, text });
    return source.id;
  }
  async function submit(inputs, first = 0, fault?) {
    const result = await requestJson('/__source-pair', 'POST', { projectId, inputs, first, ...(fault ? { fault } : {}) });
    for (const [index, outcome] of result.outcomes.entries()) {
      const key = result.keys[index];
      if (!key) { assert.equal(outcome.ok, false); continue; } // Rejected during preflight, before R2.
      const revisionId = key.split('/')[1];
      const row = await db.prepare('SELECT id,source_id FROM source_revision WHERE id=?').bind(revisionId).first();
      const dispatch = await db.prepare('SELECT starts FROM fixture_ingest_dispatch WHERE revision_id=?').bind(revisionId).first();
      if (outcome.ok) {
        assert.equal(row?.source_id, outcome.value.sourceId); assert.equal(dispatch?.starts, 1);
        assert.equal(await (await bucket.get(key)).text(), inputs[index].text); dispatched.push(revisionId);
      } else {
        assert.equal(row, null); assert.equal(dispatch, null); assert.equal(await bucket.get(key), null);
      }
    }
    return result;
  }
  // Both requests pass the hash lookup and replacement membership read before
  // either actual D1 transaction. Control both commit orders without paid work.
  for (const mixed of [false, true]) for (const first of [0, 1]) {
    const a = await target(), b = mixed ? undefined : await target(), text = `race-${mixed}-${first}`;
    const beforeSources = (await db.prepare('SELECT count(*) AS n FROM source').first()).n;
    const result = await submit([{ sourceId: a, text }, { ...(b ? { sourceId: b } : {}), text }], first);
    assert.equal(result.arrivals, 2);
    assert.equal(result.outcomes[first].ok, true); assert.equal(result.outcomes[1 - first].status, 409);
    assert.equal(result.outcomes[1 - first].duplicate.sourceId, result.outcomes[first].value.sourceId);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
    assert.equal((await db.prepare('SELECT count(*) AS n FROM source_revision WHERE original_sha256=?').bind(hash).first()).n, 1);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM source').first()).n, beforeSources + (mixed && first === 1 ? 1 : 0));
  }
  const same = await target(), sameText = 'Deliberate same-source reconversion';
  for (let n = 0; n < 2; n++) assert.equal((await submit([{ sourceId: same, text: sameText }])).outcomes[0].ok, true);
  assert.deepEqual((await db.prepare('SELECT revision_no FROM source_revision WHERE source_id=? ORDER BY revision_no').bind(same).all()).results.map(r => r.revision_no), [1, 2, 3]);
  const cas = await target();
  const casPair = await submit([{ sourceId: cas, text: 'same-source CAS' }, { sourceId: cas, text: 'same-source CAS' }]);
  assert.equal(casPair.outcomes.filter(o => o.ok).length, 1); assert.equal(casPair.outcomes[1].status, 409);
  const newPair = await submit([{ text: 'ordinary new duplicate' }, { text: 'ordinary new duplicate' }]);
  assert.equal(newPair.outcomes[0].ok, true); assert.equal(newPair.outcomes[1].status, 409);
  for (const fault of ['before', 'after']) {
    const sourceId = await target(), result = await submit([{ sourceId, text: 'ambiguous batch ' + fault }], 0, fault);
    assert.equal(result.outcomes[0].ok, fault === 'after');
    if (fault === 'before') assert.equal(result.outcomes[0].status, 409);
  }
  for (const state of ['active', 'archived', 'deleted', 'revision-deleted']) {
    const a = await target(), b = await target(), text = 'duplicate policy ' + state;
    const first = (await submit([{ sourceId: a, text }])).outcomes[0].value;
    if (state === 'revision-deleted') await db.prepare('UPDATE source_revision SET deleted_at=2 WHERE id=?').bind(first.revisionId).run();
    else await db.prepare('UPDATE source SET state=? WHERE id=?').bind(state, a).run();
    const next = (await submit([{ sourceId: b, text }])).outcomes[0];
    assert.equal(next.ok, state === 'deleted' || state === 'revision-deleted');
    if (!next.ok) { assert.equal(next.status, 409); assert.equal(next.duplicate.sourceId, a); }
  }
  const detached = await target();
  await db.prepare('DELETE FROM project_source WHERE project_id=? AND source_id=?').bind(projectId, detached).run();
  assert.equal((await submit([{ sourceId: detached, text: 'Must attach before replacing' }])).outcomes[0].status, 404);
  for (const { source, key, text } of retained) {
    assert.equal((await db.prepare('SELECT current_revision_id AS id FROM source WHERE id=?').bind(source.id).first()).id, source.revisionId);
    assert.equal(await (await bucket.get(key)).text(), text);
  }
  // The native Workflow is only a durable dispatch counter. It performs no conversion.
  const deadline = Date.now() + 5000;
  while ((await db.prepare('SELECT count(*) AS n FROM fixture_ingest_dispatch WHERE completed!=1').first()).n && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  const rows = (await db.prepare('SELECT revision_id,starts,completed FROM fixture_ingest_dispatch').all()).results;
  assert.equal(rows.length, dispatched.length); assert(rows.every(row => row.starts === 1 && row.completed === 1));
  console.log(JSON.stringify({ scope: 'K1_REPLACEMENT_DUPLICATES', runtime: 'pinned Workerd/D1/R2',
    postPreflightRaces: 4, bothCommitOrders: true, oneOwningRevisionAndOriginal: true, loserNoDispatchAndOwnKeyRemoved: true,
    sameSourceReconversionAndUniqueRevisionCas: true, ordinaryNewDuplicateRollback: true, beforeAndLostBatchReplies: true,
    liveArchivedDeletedRevisionPolicy: true, missingMembershipRejected: true, oldHeadsAndOriginalsRetained: true,
    workflowBinding: 'SYNTHETIC_DURABLE_DISPATCH_COUNTER', workflowStarts: rows.length, conversionAndModelCalls: 0 }));
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
  assert.deepEqual(await requestJson('/api/projects?archived=true'),{projects:[],nextCursor:null});
  const nextProject = async (name = 'K1 Library fixture') => {
    const id = uuid(projectSeq++);
    await createProject(db, id, name);
    return id;
  };

  const emptyProject = await nextProject('Empty target');
  const empty = await availablePage(emptyProject);
  assert.deepEqual(empty.data, { sources: [], nextCursor: null });

  // Chat inventory uses the same strict migrated D1/HTTP fixture without a model binding.
  const chatPath = '/api/projects/' + emptyProject + '/chats';
  const chatInput = { id: uuid(95_000), title: 'Чат 😀 e\u0301' };
  const simultaneous = await Promise.all([rawRequest(chatPath, 'POST', chatInput), rawRequest(chatPath, 'POST', chatInput)]);
  assert.deepEqual(simultaneous.map(response => response.status).sort(), [200, 201]);
  const winner = await simultaneous[0].json();
  assert.deepEqual(await simultaneous[1].json(), winner);
  const snapshot = () => db.prepare('SELECT * FROM chat WHERE id=?').bind(chatInput.id).first();
  const originalChat = await snapshot();
  assert.equal(originalChat.title, chatInput.title);
  assert.equal(originalChat.project_id, emptyProject);
  assert.deepEqual(await requestJson(chatPath, 'POST', chatInput), winner);
  assert.deepEqual(await snapshot(), originalChat);
  assert.equal((await rawRequest(chatPath, 'POST', { ...chatInput, title: 'Different title' })).status, 409);
  const foreignProject = await nextProject('Chat collision target');
  assert.equal((await rawRequest('/api/projects/' + foreignProject + '/chats', 'POST', chatInput)).status, 409);
  assert.deepEqual(await snapshot(), originalChat);
  assert.equal((await rawRequest(chatPath, 'POST', { id: 'invalid', title: 'No row' })).status, 400);
  assert.equal((await rawRequest(chatPath, 'POST', { id: uuid(95_001), title: '\uD800' })).status, 400);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM chat WHERE project_id=?').bind(emptyProject).first('n'), 1);
  await db.prepare('UPDATE chat SET archived_at=123 WHERE id=?').bind(chatInput.id).run();
  const archivedChat = await snapshot();
  assert.equal((await rawRequest(chatPath, 'POST', chatInput)).status, 409);
  assert.deepEqual(await snapshot(), archivedChat);
  for (const fault of ['before', 'after']) {
    const input = { id: uuid(fault === 'before' ? 95_002 : 95_003), title: 'Recover ' + fault };
    assert.equal((await rawRequest(chatPath, 'POST', input, { 'x-test-chat-create-fault': fault })).status, 503);
    const committed = await db.prepare('SELECT * FROM chat WHERE id=?').bind(input.id).first();
    assert.equal(committed !== null, fault === 'after');
    const retry = await rawRequest(chatPath, 'POST', input);
    assert.equal(retry.status, fault === 'before' ? 201 : 200);
    assert.equal((await retry.json()).chat.id, input.id);
    if (committed) assert.deepEqual(await db.prepare('SELECT * FROM chat WHERE id=?').bind(input.id).first(), committed);
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM chat WHERE id=?').bind(input.id).first('n'), 1);
  }
  const legacy = await rawRequest(chatPath, 'POST', {});
  assert.equal(legacy.status, 201);
  assert.equal((await legacy.json()).chat.title, 'New chat');
  const competingId = uuid(95_004);
  const competing = await Promise.all(['First title', 'Second title'].map(title => rawRequest(chatPath, 'POST', { id: competingId, title })));
  assert.deepEqual(competing.map(response => response.status).sort(), [201, 409]);
  const accepted = await competing.find(response => response.status === 201).json();
  const competingRow = await db.prepare('SELECT * FROM chat WHERE id=?').bind(competingId).first();
  assert.equal(competingRow.project_id, emptyProject);
  assert.equal(competingRow.title, accepted.chat.title);
  assert.equal(competingRow.created_at, competingRow.updated_at);
  assert.deepEqual(await requestJson(chatPath, 'POST', { id: competingId, title: accepted.chat.title }), accepted);
  console.log(JSON.stringify({ scope: 'K2_CHAT_CREATE_STORAGE', runtime: 'pinned Workerd/D1', concurrentReplayOneWinner: true,
    mismatchForeignArchivedAndInvalidRejected: true, originalRowsUnchanged: true, beforeAndAfterCommitFaults: true,
    legacyCreate: true, modelCalls: 0, workflowBinding: 'SYNTHETIC_DURABLE_DISPATCH_COUNTER', externalNetwork: 'FORBIDDEN' }));

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
  const archivedProjects=[];
  for(let i=0;i<105;i++){
    const id=uuid(80_000+i);archivedProjects.push(id);
    await db.prepare('INSERT INTO project(id,title,archived_at,created_at,updated_at) VALUES(?,?,1,700,700)')
      .bind(id,'Archived project '+i).run();
  }
  const activeList=await requestJson('/api/projects');
  assert(activeList.projects.every(project=>project.archivedAt===null));
  const archivedSeen=[],archivedPageSizes=[];
  let archivedCursor=null;
  do{
    const result=await requestJson('/api/projects?archived=true'+(archivedCursor?'&cursor='+archivedCursor:''));
    assert(result.projects.every(project=>project.archivedAt!==null));
    archivedPageSizes.push(result.projects.length);archivedSeen.push(...result.projects.map(project=>project.id));
    if(archivedCursor===null){
      await requestJson('/api/projects/'+result.nextCursor,'PATCH',{archived:false});
      assert((await requestJson('/api/projects')).projects.some(project=>project.id===result.nextCursor));
    }
    archivedCursor=result.nextCursor;
  }while(archivedCursor);
  assert.deepEqual(archivedPageSizes,[50,50,5]);
  assert.deepEqual(archivedSeen,[...archivedProjects].reverse());
  assert.equal(new Set(archivedSeen).size,105);
  assert.equal((await rawRequest('/api/projects?archived=yes')).status,400);
  const concurrentId=archivedProjects[0];
  assert.equal((await requestJson('/__project-pair','POST',{id:concurrentId,title:'Renamed during restore'})).reads,4);
  const concurrent=await requestJson('/api/projects/'+concurrentId);
  assert.equal(concurrent.project.title,'Renamed during restore');
  assert.equal(concurrent.project.archivedAt,null);
  const historyChat=uuid(90_000),historyTurn=uuid(90_001),historyPage=uuid(90_002),historyRevision=uuid(90_003);
  const pageBody='page/'+historyRevision+'/body.md',pageCites='page/'+historyRevision+'/citations.json';
  await bucket.put(pageBody,'Saved synthetic answer [S1:1]');
  await bucket.put(pageCites,JSON.stringify([{label:'[S1:1]',revisionId:reusable.revisions[1].id,block:0,start:0,
    end:new TextEncoder().encode(currentText).byteLength,sourceId:reusable.id,sourceTitle:reusable.title}]));
  await db.batch([
    db.prepare("INSERT INTO chat(id,project_id,title,created_by,created_at,updated_at) VALUES(?,?,'Retained chat','owner',1,1)").bind(historyChat,attachProject),
    db.prepare("INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,created_at) VALUES(?,?,'','empty','[]','none','failed',1)")
      .bind(historyChat,historyTurn),
    db.prepare("INSERT INTO page(id,project_id,kind,title,created_at,updated_at) VALUES(?,?,'answer','Retained page',1,1)").bind(historyPage,attachProject),
    db.prepare("INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,citations_key,inputs_json,mutation_id,created_at) VALUES(?,?,1,'accepted','chat','owner',?,?,?,?,1)")
      .bind(historyRevision,historyPage,pageBody,pageCites,JSON.stringify([reusable.revisions[1].id]),uuid(90_004)),
    db.prepare('UPDATE page SET head_revision_id=? WHERE id=?').bind(historyRevision,historyPage),
  ]);
  const evidenceSql=[
    'SELECT * FROM project_source ORDER BY project_id,source_id',
    'SELECT * FROM source ORDER BY id','SELECT * FROM source_revision ORDER BY id','SELECT * FROM claim ORDER BY id',
    'SELECT * FROM chat ORDER BY id','SELECT * FROM chat_turn ORDER BY chat_id,turn_id',
    'SELECT * FROM page ORDER BY id','SELECT * FROM page_revision ORDER BY id',
  ];
  const readEvidence=()=>Promise.all(evidenceSql.map(async sql=>(await db.prepare(sql).all()).results));
  const evidenceBefore=await readEvidence();
  const storedObjects=async()=>{
    const result=await bucket.list();assert.equal(result.truncated,false);
    assert(result.objects.every(object=>typeof object.key==='string'&&typeof object.etag==='string'&&typeof object.version==='string'));
    return result.objects.map(object=>[object.key,object.size,object.etag,object.version]);
  };
  const objectsBefore=await storedObjects();
  const bodyBefore=await (await bucket.get(pageBody)).text(),citesBefore=await (await bucket.get(pageCites)).text();
  await resetMetrics();
  await requestJson('/api/projects/'+attachProject,'PATCH',{archived:true});
  await requestJson('/api/projects/'+attachProject,'PATCH',{title:'Renamed while archived'});
  assert.notEqual((await requestJson('/api/projects/'+attachProject)).project.archivedAt,null);
  await requestJson('/api/projects/'+attachProject,'PATCH',{archived:false});
  assert.equal((await requestJson('/api/projects/'+attachProject)).project.title,'Renamed while archived');
  assert.deepEqual(await readEvidence(),evidenceBefore);
  assert.deepEqual(await storedObjects(),objectsBefore);
  assert.equal(await (await bucket.get(pageBody)).text(),bodyBefore);
  assert.equal(await (await bucket.get(pageCites)).text(),citesBefore);
  assert.equal((await readMetrics()).r2Writes,0);
  console.log(JSON.stringify({
    scope: 'K1_LIBRARY_STORAGE', runtime: 'pinned Workerd/D1/R2',
    projectArchive:{pages:archivedPageSizes,restoredCursorStillPages:true,concurrentRenameAndRestore:true,evidenceUnchanged:true},
    availablePages: { empty: 0, single: 1, tiedTimestampTotal: 103, pageSizes: [50, 50, 3] },
    localFirstPageWallMs: { samples: fiftyRowSamples.length, p50: percentile(fiftyRowSamples, 0.5), p95: percentile(fiftyRowSamples, 0.95),
      includes: 'local Workerd request and JSON body read; excludes metric/reset calls' },
    projectScopedDescendingCursor: true, malformedAndWrongProjectCursorsRejected: true,
    filters: { attachedEnabledAndDisabled: true, otherProjectMembershipRemainsAvailable: true, archivedDeletedMissingAndDeletedRevision: true },
    attachmentDuringPaging: true, newUploadRequiresRefresh: true,
    attachPostIdempotent: true, retainedOldAndCurrentCanonicalBytes: true, existingUnderstandingAndUsageReused: true,
    availableListR2Gets: 0, attachmentR2Gets: 0, attachmentR2Writes: 0,
    modelCalls: 0, workflowBinding: 'SYNTHETIC_DURABLE_DISPATCH_COUNTER', externalNetwork: 'FORBIDDEN',
  }));
  await replacementDuplicateChecks(db, bucket);
} finally {
  await mf.dispose();
}
