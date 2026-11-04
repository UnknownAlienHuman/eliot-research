import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanBlocks } from '../../src/blocks.ts';
assert(process.env.ELIOT_K2_MODEL !== '1', 'Context query fixture forbids model calls.');
const root = process.cwd(), require = createRequire(path.join(root, 'package.json')), wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild'), { Miniflare, convertV4MiniflareOptions } = wr('miniflare'), { unstable_splitSqlQuery } = wr('wrangler');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-context-query-')), output = path.join(runtime, 'worker.mjs');
await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import {buildContext} from ${JSON.stringify(path.join(root, 'src/context.ts'))};
export default {async fetch(request,env){
  let d1Reads=0,r2Reads=0,metadataBytes=0;const input=await request.json();
  const DB={prepare(sql){const statement=env.DB.prepare(sql);return{bind(...params){const bound=statement.bind(...params);return{
    first(){d1Reads++;return bound.first();},async all(){d1Reads++;const result=await bound.all();metadataBytes+=new TextEncoder().encode(JSON.stringify(result.results)).length;return result;}};}};}};
  const BUCKET={get(...args){r2Reads++;return env.BUCKET.get(...args);}};
  try {const context=await buildContext({DB,BUCKET},{type:'owner',id:'owner',authentication:'local'},
    {scopeMode:'explicit',model:{contextTokens:1048576,maxOutputTokens:2000},...input});return Response.json({context,d1Reads,r2Reads,metadataBytes});}
  catch(error){return Response.json({error:{status:error.status,message:error.message},d1Reads,r2Reads,metadataBytes});}
}};` }, outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], logLevel: 'warning' });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'context', rootPath: runtime, scriptPath: output, modules: true,
  compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'context-db' }, r2Buckets: { BUCKET: 'context-r2' }, outboundService: { name: 'no-network' } },
  { name: 'no-network', modules: true, script: "export default{fetch(){throw new Error('External network forbidden');}};" }], resourcePersistencePath: path.join(runtime, 'state') }));
try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'context'), bucket = await mf.getR2Bucket('BUCKET', 'context');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter(f => /^\d+_.+\.sql$/.test(f)).sort())
    await db.batch(unstable_splitSqlQuery(await readFile(path.join(root, 'migrations', file), 'utf8')).map(sql => db.prepare(sql)));
  const projectId = crypto.randomUUID(), ids = Array.from({ length: 1024 }, () => crypto.randomUUID()), revisions = ids.map(() => crypto.randomUUID());
  await db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES(?,'Context fixture',1,1)").bind(projectId).run();
  const text = 'Каноническое свидетельство 😀.', size = new TextEncoder().encode(text).length;
  for (let offset = 0; offset < ids.length; offset += 25) {
    await db.batch(ids.slice(offset, offset + 25).flatMap((id, at) => {
      const i = offset + at;
      return [db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES(?,?,'text','owner',?,1)").bind(id, 'Paper ' + i, i),
        db.prepare("INSERT INTO source_revision(id,source_id,revision_no,readable_state,readable_size,created_by,created_at) VALUES(?,?,1,'readable',?,'owner',1)").bind(revisions[i], id, size),
        db.prepare('UPDATE source SET current_revision_id=? WHERE id=?').bind(revisions[i], id),
        db.prepare("INSERT INTO project_source(project_id,source_id,enabled,added_by,added_at) VALUES(?,?,?,'owner',1)").bind(projectId, id, i % 2)];
    }));
  }
  for (const revision of revisions.slice(0, 3)) {
    await bucket.put('source/' + revision + '/text.md', text);
    await bucket.put('source/' + revision + '/blocks.json', JSON.stringify([{ id: 1, type: 'paragraph', start: 0, end: size, heading: null }]));
  }
  const invoke = async (sourceIds, extra = {}) => (await mf.dispatchFetch('http://127.0.0.1/context', {
    method: 'POST', body: JSON.stringify({ projectId, sourceIds, ...extra }), headers: { 'Content-Type': 'application/json' },
  })).json();
  for (const sourceIds of [[], [ids[0]], [ids[2], ids[0], ids[2], ids[1]]]) {
    const result = await invoke(sourceIds), order = [...new Set(sourceIds)], expected = order.map(id => revisions[ids.indexOf(id)]);
    assert.equal(result.error, undefined); assert.equal(result.d1Reads, sourceIds.length ? 2 : 1);
    assert.deepEqual(result.context.revisionIds, expected);
    assert.deepEqual(result.context.sources.map(s => s.sourceId), order);
    assert.deepEqual(result.context.sources.map(s => s.alias), order.map((_, i) => 'S' + (i + 1)));
    for (const source of result.context.sources) {
      assert.deepEqual(source.blocks.map(b => [b.start, b.end]), [[0, size]]);
      assert(result.context.messages.some(m => m.content.includes(text)));
    }
  }
  const large = await invoke(ids, { question: 'q'.repeat(15000), model: { contextTokens: 4096, maxOutputTokens: 256 } });
  assert.equal(large.d1Reads, 2); assert.equal(large.r2Reads, 0);
  assert.equal(large.error.message, 'Narrow the source selection so the answer fits.');
  await db.prepare('UPDATE source_revision SET guide_summary=?').bind('я'.repeat(4096)).run();
  const bounded = await invoke(ids);
  assert.equal(bounded.d1Reads, 2); assert.equal(bounded.r2Reads, 0);
  assert.equal(bounded.error.message, 'Narrow the source selection so the answer fits.');
  assert(bounded.metadataBytes < 4600000, 'SQL must suppress metadata beyond the allowance');
  await db.prepare('UPDATE source_revision SET guide_summary=NULL').run();
  for (const sourceIds of [[crypto.randomUUID()], Array(1025).fill(ids[0])]) {
    const result = await invoke(sourceIds);
    assert.equal(result.error.status, 400); assert.equal(result.r2Reads, 0);
    assert.equal(result.d1Reads, sourceIds.length > 1024 ? 1 : 2);
  }
  const paragraph = 'Canonical evidence describes the method, its conditions and limitations. '.repeat(120);
  const largeText = Array(150).fill(paragraph).join('\n\n').slice(0, 1230000), largeBlocks = scanBlocks(largeText);
  await bucket.put('source/' + revisions[0] + '/text.md', largeText);
  await bucket.put('source/' + revisions[0] + '/blocks.json', JSON.stringify(largeBlocks));
  await db.prepare('UPDATE source_revision SET readable_size=? WHERE id=?').bind(largeText.length, revisions[0]).run();
  const aboveCap = await invoke([ids[0]], { model: { contextTokens: 1000000, contextWindowTokens: 1000000, maxOutputTokens: 32768, outputReserveTokens: 2048 } });
  assert.equal(aboveCap.error, undefined); assert.equal(aboveCap.context.mode, 'whole');
  assert(aboveCap.context.estimatedInputTokens > 400000);
  assert.deepEqual(aboveCap.context.revisionIds, [revisions[0]]);
  assert.deepEqual(aboveCap.context.sources[0].blocks, largeBlocks);
  await db.prepare("UPDATE source SET state='deleted' WHERE id=?").bind(ids[0]).run();
  const deleted = await invoke([ids[0]]); assert.equal(deleted.error.status, 400); assert.equal(deleted.r2Reads, 0);
  console.log(JSON.stringify({ scope: 'K2_CONTEXT_QUERY', runtime: 'pinned Workerd/D1/R2', sourceCounts: [0, 1, 1024],
    d1Reads: [1, 2, 2], largeCase: '1024 metadata rows validated; token cap rejects before R2',
    orderDuplicatesDisabledMembership: true, missingDeletedAndRawCap: true, canonicalUnicodeRanges: true,
    boundedMetadataBytes: bounded.metadataBytes, aboveFormerCap: { bytes: largeText.length, blocks: largeBlocks.length, inputEstimate: aboveCap.context.estimatedInputTokens },
    modelCalls: 0, fullK2Accepted: false }));
} finally { await mf.dispose(); }
