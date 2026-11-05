import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { estimateModelInput } from '../../src/model-input.ts';

assert(process.env.ELIOT_K2_MODEL !== '1', 'History acceptance forbids model calls.');
const root = process.cwd(), require = createRequire(path.join(root, 'package.json')), wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild'), { Miniflare, convertV4MiniflareOptions } = wr('miniflare');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-model-history-')), output = path.join(runtime, 'worker.mjs');
const limit = 16 * 1024 * 1024;
const question = (i) => 'Question ' + i + ': preserve NUL \0, emoji 😀 and lone surrogates \ud800 \udfff.';
const answer = (i) => 'Answer ' + i + ': сохранено \0, 😀, \ud800 \udfff.';
const turnId = (i) => 'turn-' + String(i).padStart(6, '0');
await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { buildContext } from ${JSON.stringify(path.join(root, 'src/context.ts'))};
import { createModelHistoryReader } from ${JSON.stringify(path.join(root, 'src/model-history.ts'))};
const question=${question.toString()}, answer=${answer.toString()}, turnId=${turnId.toString()};
export class History {
  constructor(ctx,env) {
    this.sql=ctx.storage.sql; this.env=env;
    this.sql.exec('CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL,history_version INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS turns_by_created ON turns(created_at,id)');
  }
  async fetch(request) {
    const input=await request.json();
    if (new URL(request.url).pathname==='/seed') {
      // Generate each body in the DO. Neither the seed request nor a JavaScript
      // array materializes the 49 MiB failed tail across the runtime boundary.
      for (let i=0;i<input.turns;i++) {
        const failed=i>=input.turns-(input.failedTail??0);
        const payload=JSON.stringify({turnId:turnId(i),state:failed?'failed':'completed',
          question:question(i),answer:failed&&input.failedBytes?'F'.repeat(input.failedBytes):input.answerBytes?'A'.repeat(input.answerBytes):answer(i),
          revisionIds:[],citations:[]});
        this.sql.exec('INSERT INTO turns(id,payload,created_at,history_version) VALUES(?,?,?,1)',turnId(i),payload,Math.floor(i/7));
      }
      this.sql.exec('INSERT INTO turns(id,payload,created_at,history_version) VALUES(?,?,?,1)',
        'current',JSON.stringify({state:'started',question:'Continue.',answer:'',revisionIds:[],citations:[]}),input.turns);
      return Response.json({seeded:input.turns+1});
    }
    const stats={sqlCalls:0,rowsRead:0,returnedStringBytes:0,fragmentCalls:0,fragmentStringBytes:0,maxReturnedStringBytes:0,d1Reads:0,r2Reads:0};
    const encoder=new TextEncoder(), sql=this.sql, env=this.env;
    const measured={exec(query,...bindings) {
      stats.sqlCalls++;
      const cursor=sql.exec(query,...bindings);
      return {toArray() {
        const rows=cursor.toArray();
        // Count the actual native cursor after full consumption, rather than
        // treating result length or a fake SQL implementation as rows read.
        stats.rowsRead+=cursor.rowsRead;
        let bytes=0;
        for (const row of rows) for (const value of Object.values(row))
          if(typeof value==='string') bytes+=encoder.encode(value).byteLength;
        stats.returnedStringBytes+=bytes;
        stats.maxReturnedStringBytes=Math.max(stats.maxReturnedStringBytes,bytes);
        if (/AS question\\b/.test(query)) {stats.fragmentCalls++;stats.fragmentStringBytes+=bytes;}
        return rows;
      }};
    }};
    const DB={prepare(query) {const statement=env.DB.prepare(query);return {bind(...bindings) {
      const bound=statement.bind(...bindings);return {first() {stats.d1Reads++;return bound.first();}};
    }};}};
    const BUCKET={get() {stats.r2Reads++;throw new Error('Empty-scope history must not fetch sources');}};
    const start=Date.now();
    try {
      const context=await buildContext({DB,BUCKET},{type:'owner',id:'owner',authentication:'local'},
        {projectId:'history-project',scopeMode:'empty',model:input.model,question:'Continue.',historyReader:createModelHistoryReader(measured,'current')});
      return Response.json({context,...stats,contextMs:Date.now()-start});
    } catch(error) {
      return Response.json({error:{status:error.status,message:error.message},...stats,contextMs:Date.now()-start});
    }
  }
}
export default {fetch(request,env) {
  const name=new URL(request.url).searchParams.get('fixture');
  return env.HISTORY.get(env.HISTORY.idFromName(name)).fetch(request);
}};
` }, outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], logLevel: 'warning' });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'history', rootPath: runtime, scriptPath: output, modules: true,
  compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'history-db' },
  durableObjects: { HISTORY: { className: 'History', useSQLite: true } }, outboundService: { name: 'no-network' } },
  { name: 'no-network', modules: true, script: "export default{fetch(){throw new Error('External network forbidden');}};" }], resourcePersistencePath: path.join(runtime, 'state') }));
try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'history');
  await db.prepare('CREATE TABLE project(id TEXT PRIMARY KEY)').run();
  await db.prepare("INSERT INTO project(id) VALUES('history-project')").run();
  const invoke = async (fixture, action, input) => {
    const started = performance.now();
    const response = await mf.dispatchFetch('http://127.0.0.1/' + action + '?fixture=' + fixture,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const result = await response.json();
    return { ...result, wallMs: performance.now() - started };
  };
  const model = { contextTokens: 1048576, maxOutputTokens: 2000 };
  const estimate = (context) => estimateModelInput({
    instructions: context.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
    messages: [...context.messages.filter(message => message.role !== 'system').map(({ role, content }) => ({ role, content })), { role: 'user', content: 'Continue.' }],
  });
  const legacyPageEstimate = (context, messages) => estimate({ messages: [
    ...context.messages.filter(message => message.role === 'system' && message.content !== "Older exchanges were omitted from this answer's context."),
    { role: 'system', content: "Older exchanges were omitted from this answer's context." }, ...messages,
  ] });
  const observations = [];
  for (const [fixture, failedTail] of [['all-short', 0], ['failed-short-tail', 49]]) {
    assert.equal((await invoke(fixture, 'seed', { turns: 120, failedTail })).seeded, 121);
    const result = await invoke(fixture, 'context', { model });
    assert.equal(result.error, undefined);
    const messages = result.context.messages.filter(message => message.role !== 'system');
    assert.deepEqual(messages, Array.from({ length: 120 - failedTail }, (_, i) => [
      { role: 'user', content: question(i) }, { role: 'assistant', content: answer(i), turnId: turnId(i) },
    ]).flat(), 'All eligible turns survive beyond the public latest-50 page, with exact Unicode text');
    assert.equal(result.context.historyNotice, undefined);
    assert.equal(result.fragmentCalls, 120 - failedTail, 'Failed and started bodies must not be transferred');
    assert.equal(result.d1Reads, 1); assert.equal(result.r2Reads, 0);
    assert(Number.isSafeInteger(result.rowsRead) && result.rowsRead >= 120, 'Read counts come from consumed native cursors');
    assert(result.returnedStringBytes < limit);
    assert(estimate(result.context) <= model.contextTokens);
    const { context, ...metrics } = result;
    observations.push({ fixture, retainedExchanges: messages.length / 2, inputEstimate: estimate(context),
      legacyPageInputEstimate: legacyPageEstimate(context, failedTail ? [] : messages.slice(-98)), ...metrics });
  }
  assert.equal((await invoke('large-failed-tail', 'seed', { turns: 120, failedTail: 49, failedBytes: 1024 * 1024 })).seeded, 121);
  const blocked = await invoke('large-failed-tail', 'context', { model });
  assert.equal(blocked.error?.status, 400);
  assert.equal(blocked.error.message, 'Conversation history exceeds the safe read budget. Start a new chat.');
  assert.equal(blocked.context, undefined);
  assert.equal(blocked.fragmentCalls, 0); assert.equal(blocked.fragmentStringBytes, 0);
  assert(blocked.returnedStringBytes < limit, 'A failed tail must not transfer its payloads before failing safely');
  assert(blocked.sqlCalls < 49 * 2, 'The raw-byte guard must stop before scanning all 49 MiB');
  assert.equal(blocked.d1Reads, 1); assert.equal(blocked.r2Reads, 0);
  observations.push({ fixture: 'large-failed-tail', seededFailedAnswerBytes: 49 * 1024 * 1024, ...blocked });

  const cappedModel = { contextTokens: 192000, contextWindowTokens: 256000, maxOutputTokens: 128000, outputReserveTokens: 8192 };
  assert.equal((await invoke('token-capped-suffix', 'seed', { turns: 1000, answerBytes: 600 })).seeded, 1001);
  const capped = await invoke('token-capped-suffix', 'context', { model: cappedModel });
  assert.equal(capped.error, undefined, capped.error ? JSON.stringify({ observations, capped }) : undefined);
  const retained = capped.context.messages.filter(message => message.role !== 'system');
  const count = retained.length / 2;
  assert(count > 50 && count < 1000, 'Budget selection retains a suffix, independent of UI page size');
  assert.deepEqual(retained, Array.from({ length: count }, (_, offset) => {
    const i = 1000 - count + offset;
    return [{ role: 'user', content: question(i) }, { role: 'assistant', content: 'A'.repeat(600), turnId: turnId(i) }];
  }).flat(), 'Omit whole oldest exchanges and retain the latest intact');
  assert.equal(capped.context.historyNotice, "Older exchanges were omitted from this answer's context.");
  assert(capped.context.messages.some(message => message.role === 'system' && message.content === capped.context.historyNotice));
  assert(estimate(capped.context) <= cappedModel.contextTokens);
  assert(capped.returnedStringBytes < limit);
  assert.equal(capped.d1Reads, 1); assert.equal(capped.r2Reads, 0);
  const { context, ...metrics } = capped;
  observations.push({ fixture: 'token-capped-suffix', inputBudget: cappedModel.contextTokens, retainedExchanges: count, inputEstimate: estimate(context), legacyPageInputEstimate: legacyPageEstimate(context, retained.slice(-98)), ...metrics });
  const latency = [];
  for (const [fixture, selectedModel] of [['all-short', model], ['token-capped-suffix', cappedModel]]) {
    const samples = [];
    for (let repeat = 0; repeat < 7; repeat++) {
      const result = await invoke(fixture, 'context', { model: selectedModel });
      assert.equal(result.error, undefined);
      samples.push(result.wallMs);
    }
    samples.sort((a, b) => a - b);
    latency.push({ fixture, samplesMs: samples, p50Ms: samples[3], p95Ms: samples[6] });
  }
  console.log(JSON.stringify({ scope: 'K2_MODEL_HISTORY', runtime: 'pinned Workerd/Durable Object SQLite/D1',
    observations, latency, productionLatencyMeasured: false, unicodeFragmentsPreserved: true, modelCalls: 0, externalCalls: 0, fullK2Accepted: false }));
} finally {
  await mf.dispose();
  await rm(runtime, { recursive: true, force: true });
}
