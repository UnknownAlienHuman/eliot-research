import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanBlocks } from '../../src/blocks.ts';
import { resolveCitations } from '../../src/citations.ts';
import { estimateModelInput } from '../../src/model-input.ts';
assert(process.env.ELIOT_K2_MODEL !== '1', 'Context query fixture forbids model calls.');
const r2DelayMs = Number(process.env.ELIOT_CONTEXT_R2_DELAY_MS ?? 0);
assert(Number.isFinite(r2DelayMs) && r2DelayMs >= 0 && r2DelayMs <= 250, 'R2 test delay must be between 0 and 250 ms.');
const root = process.cwd(), require = createRequire(path.join(root, 'package.json')), wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild'), { Miniflare, convertV4MiniflareOptions } = wr('miniflare'), { unstable_splitSqlQuery } = wr('wrangler');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-context-query-')), output = path.join(runtime, 'worker.mjs');
await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import {buildContext} from ${JSON.stringify(path.join(root, 'src/context.ts'))};
export default {async fetch(request,env){
  let d1Reads=0,r2Reads=0,metadataBytes=0,inflight=0,maxInflight=0,readers=0,maxReaders=0;
  const events=[],streamBytes={};const input=await request.json();
  const DB={prepare(sql){const statement=env.DB.prepare(sql);return{bind(...params){const bound=statement.bind(...params);return{
    first(){d1Reads++;return bound.first();},async all(){d1Reads++;const result=await bound.all();metadataBytes+=new TextEncoder().encode(JSON.stringify(result.results)).length;return result;}};}};}};
  const BUCKET={async get(...args){r2Reads++;maxInflight=Math.max(maxInflight,++inflight);try{
    const key=args[0];events.push('get:'+key);
    if (${r2DelayMs}) await new Promise(resolve=>setTimeout(resolve,${r2DelayMs}));
    const object=await env.BUCKET.get(...args);if(!object)return object;
    return {size:object.size,get bodyUsed(){return object.bodyUsed;},body:{
      getReader(){maxReaders=Math.max(maxReaders,++readers);events.push('reader:'+key);const reader=object.body.getReader();return{
        async read(){const result=await reader.read();streamBytes[key]=(streamBytes[key]??0)+(result.value?.byteLength??0);return result;},
        cancel(){return reader.cancel();},releaseLock(){readers--;reader.releaseLock();}};},
      cancel(){events.push('cancel:'+key);return object.body.cancel();}}};
  }finally{inflight--;}}};const started=Date.now();
  const stats=()=>({d1Reads,r2Reads,metadataBytes,maxInflight,maxReaders,events,streamBytes,contextMs:Date.now()-started});
  try {const context=await buildContext({DB,BUCKET},{type:'owner',id:'owner',authentication:'local'},
    {scopeMode:'explicit',model:{contextTokens:1048576,maxOutputTokens:2000},...input});return Response.json({context,...stats()});}
  catch(error){return Response.json({error:{status:error.status,message:error.message},...stats()});}
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
  for (const revision of revisions.slice(0, 10)) {
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
    assert.equal(result.r2Reads, order.length * 2);
    assert.equal(result.maxReaders, order.length ? 1 : 0, 'Materialize only one body at a time');
    for (const source of result.context.sources) {
      assert.deepEqual(source.blocks.map(b => [b.start, b.end]), [[0, size]]);
      assert(result.context.messages.some(m => m.content.includes(text)));
    }
  }
  if (r2DelayMs) {
    const benchmarkText = Array(32).fill('Canonical evidence states the method, conditions and limitations. '.repeat(8)).join('\n\n');
    const benchmarkBlocks = scanBlocks(benchmarkText);
    for (const revision of revisions.slice(0, 10)) {
      await bucket.put('source/' + revision + '/text.md', benchmarkText);
      await bucket.put('source/' + revision + '/blocks.json', JSON.stringify(benchmarkBlocks));
      await db.prepare('UPDATE source_revision SET readable_size=? WHERE id=?').bind(benchmarkText.length, revision).run();
    }
    const observations = [];
    for (const count of [1, 3, 10]) {
      const selected = ids.slice(0, count), samples = [];
      let expected, maxInflight = 0;
      for (let repeat = 0; repeat < 7; repeat++) {
        const result = await invoke(selected);
        assert.equal(result.error, undefined);
        assert.equal(result.d1Reads, 2); assert.equal(result.r2Reads, count * 2);
        assert(result.maxInflight <= 2, 'Only the current source block/text GETs may overlap');
        assert.equal(result.maxReaders, 1);
        maxInflight = Math.max(maxInflight, result.maxInflight);
        if (expected) assert.deepEqual(result.context, expected);
        expected = result.context;
        samples.push(result.contextMs);
      }
      samples.sort((a, b) => a - b);
      observations.push({ sources: count, r2Reads: count * 2, maxInflight, samplesMs: samples, p50Ms: samples[3], p95Ms: samples[6] });
    }
    console.log(JSON.stringify({ scope: 'K2_CONTEXT_R2_LATENCY', runtime: 'pinned Workerd/D1/R2',
      artificialR2GetDelayMs: r2DelayMs, bytesPerSource: benchmarkText.length, blocksPerSource: benchmarkBlocks.length, productionLatencyMeasured: false, observations, modelCalls: 0 }));
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
  // A reachable third question must not fail merely because older optional
  // history consumes the room needed by unchanged evidence and the latest Q/A.
  const followText = Array(150).fill('Canonical source evidence describes the method, its conditions and limitations. '.repeat(50)).join('\n\n').slice(0, 555000);
  const followBlocks = scanBlocks(followText);
  await bucket.put('source/' + revisions[0] + '/text.md', followText);
  await bucket.put('source/' + revisions[0] + '/blocks.json', JSON.stringify(followBlocks));
  await db.prepare('UPDATE source_revision SET readable_size=? WHERE id=?').bind(followText.length, revisions[0]).run();
  const model = { contextTokens: 192000, contextWindowTokens: 256000, maxOutputTokens: 128000, outputReserveTokens: 8192 };
  const firstQuestion = 'Summarize the method.', nextQuestion = 'Explain the study design.', finalQuestion = 'Explain its limitations.';
  const first = await invoke([ids[0]], { model, question: firstQuestion });
  assert.equal(first.error, undefined); assert.equal(first.context.mode, 'whole');
  const answer = 'The study describes its method and limitations. '.repeat(21) + '[S1:1]';
  const citations = resolveCitations('[S1:1]', first.context.sources).citations;
  const exchange = (question, turnId) => [{ role: 'user', content: question, revisionIds: [revisions[0]] },
    { role: 'assistant', content: answer, turnId, revisionIds: [revisions[0]], citations }];
  const older = exchange(firstQuestion, 'older'), latest = exchange(nextQuestion, 'latest');
  const second = await invoke([ids[0]], { model, question: nextQuestion, history: older });
  assert.equal(second.error, undefined); assert.equal(second.context.historyNotice, undefined);
  const third = await invoke([ids[0]], { model, question: finalQuestion, history: [...older, ...latest] });
  assert.equal(third.error, undefined); assert.equal(third.context.mode, 'whole');
  assert.deepEqual(third.context.sources, first.context.sources);
  assert.deepEqual(third.context.messages.filter(message => message.turnId), [{ role: 'assistant', content: answer, turnId: 'latest' }]);
  assert(third.context.historyNotice.includes('Older exchanges were omitted'));
  assert(third.context.messages.some(message => message.role === 'system' && message.content === third.context.historyNotice));
  const thirdEstimate = estimateModelInput({ instructions: third.context.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
    messages: [...third.context.messages.filter(message => message.role !== 'system').map(({ role, content }) => ({ role, content })), { role: 'user', content: finalQuestion }] });
  assert(thirdEstimate <= model.contextTokens);
  assert.equal(third.r2Reads, first.r2Reads); assert.equal(third.d1Reads, first.d1Reads);
  // The latest complete answer can exceed the former 10% quota while still
  // fitting the real input limit. No model or extra source/page fetch is needed.
  const smallModel = { contextTokens: 10000, maxOutputTokens: 100 };
  const largeHistory = [{ role: 'user', content: 'Earlier question', revisionIds: [revisions[2]] },
    { role: 'assistant', content: 'A'.repeat(6000), revisionIds: [revisions[2]], turnId: 'large-latest' }];
  const retained = await invoke([ids[2]], { model: smallModel, question: 'Continue.', history: largeHistory });
  assert.equal(retained.error, undefined);
  assert.deepEqual(retained.context.messages.at(-1), { role: 'assistant', content: 'A'.repeat(6000), turnId: 'large-latest' });
  assert.equal(retained.context.historyNotice, undefined);
  assert.equal(retained.d1Reads, 2); assert.equal(retained.r2Reads, 2);
  const historyEstimate = estimateModelInput({ instructions: retained.context.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
    messages: [...retained.context.messages.filter(message => message.role !== 'system').map(({ role, content }) => ({ role, content })), { role: 'user', content: 'Continue.' }] });
  assert(historyEstimate <= smallModel.contextTokens);
  const excludedPage = await invoke([ids[2]], { model: smallModel, question: 'Continue.', history: largeHistory, earlierHistoryExists: true });
  assert.equal(excludedPage.error, undefined);
  assert(excludedPage.context.historyNotice);
  assert.equal(excludedPage.d1Reads, 2); assert.equal(excludedPage.r2Reads, 2);
  assert.deepEqual(excludedPage.context.messages.at(-1), retained.context.messages.at(-1));
  const cannotRetain = await invoke([ids[2]], { model: smallModel, question: 'Continue.',
    history: [largeHistory[0], { ...largeHistory[1], content: 'A'.repeat(30000) }] });
  assert.equal(cannotRetain.error.status, 400);
  assert(cannotRetain.error.message.includes('latest conversation exchange do not fit'));
  const limit = 16 * 1024 * 1024, textKey = 'source/' + revisions[1] + '/text.md', mapKey = 'source/' + revisions[1] + '/blocks.json';
  await bucket.put(textKey, text);
  await db.prepare('UPDATE source_revision SET readable_size=1 WHERE id=?').bind(revisions[1]).run();
  for (const kind of ['missing', 'invalid', 'oversized block', 'oversized map']) {
    if (kind === 'missing') await bucket.delete(mapKey);
    else await bucket.put(mapKey, kind === 'oversized map' ? ' '.repeat(limit + 1)
      : JSON.stringify(kind === 'invalid' ? [] : [{ id: 1, type: 'paragraph', start: 0, end: limit + 1, heading: null }]));
    const result = await invoke([ids[1], ids[2]]);
    assert.equal(result.error.status, kind.startsWith('oversized') ? 400 : 503);
    assert.equal(result.r2Reads, 2); assert.equal(result.maxInflight, 2); assert.equal(result.maxReaders, kind === 'missing' ? 0 : 1);
    assert(result.events.includes('cancel:' + textKey), 'Cancel the unused prefetched body');
    assert(!result.events.includes('reader:' + textKey), 'Do not materialize text before block validation');
    assert.equal(result.streamBytes[textKey] ?? 0, 0);
  }
  await bucket.put(mapKey, JSON.stringify([{ id: 1, type: 'paragraph', start: 0, end: 1, heading: null }]));
  await bucket.put(textKey, 'x'.repeat(limit + 1));
  const understated = await invoke([ids[1], ids[2]]);
  assert.equal(understated.error.status, 400); assert.equal(understated.r2Reads, 2);
  assert.equal(understated.streamBytes[textKey] ?? 0, 0, 'R2 object size must not bypass the allowance');
  await bucket.delete(textKey);
  const missingText = await invoke([ids[1], ids[2]]);
  assert.equal(missingText.error.status, 503); assert.equal(missingText.r2Reads, 2);
  await db.prepare("UPDATE source SET state='deleted' WHERE id=?").bind(ids[0]).run();
  const deleted = await invoke([ids[0]]); assert.equal(deleted.error.status, 400); assert.equal(deleted.r2Reads, 0);
  console.log(JSON.stringify({ scope: 'K2_CONTEXT_QUERY', runtime: 'pinned Workerd/D1/R2', sourceCounts: [0, 1, 1024],
    d1Reads: [1, 2, 2], largeCase: '1024 metadata rows validated; token cap rejects before R2',
    orderDuplicatesDisabledMembership: true, missingDeletedAndRawCap: true, canonicalUnicodeRanges: true,
    boundedMetadataBytes: bounded.metadataBytes, aboveFormerCap: { bytes: largeText.length, blocks: largeBlocks.length, inputEstimate: aboveCap.context.estimatedInputTokens },
    pairedGetsOnly: true, serialBodyReaders: true, failedMapCancelsUnreadText: true, understatedSizeBounded: true,
    followupHistory: { bytes: followText.length, latestExchangeRetained: true, noticeStoredInContext: true, finalInputEstimate: thirdEstimate },
    sharedHistoryBudget: { latestAnswerCharacters: 6000, inputEstimate: historyEstimate, overBudgetLatestRejected: true, olderPageDisclosedWithoutReads: true },
    modelCalls: 0, fullK2Accepted: false }));
} finally { await mf.dispose(); }

// The same storage-only contour also validates the independent model-history reader.
await import("./k2-history.ts");
