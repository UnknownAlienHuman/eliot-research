// Actual storage callbacks on Workerd/D1/R2; retained synthetic outputs replace both paid producers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
assert(process.env.ELIOT_K3_MODEL !== '1', 'Metadata storage proof forbids model opt-in.');
const root = process.cwd(), require = createRequire(path.join(root, 'package.json')), wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild'), { Miniflare, convertV4MiniflareOptions } = wr('miniflare'), { unstable_splitSqlQuery } = wr('wrangler');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-metadata-')), origin = 'http://127.0.0.1';
const model = { route: 'gateway:command-code/fixture/admitted', id: 'fixture/admitted', label: 'Retained fixture', contextTokens: 262144,
  maxOutputTokens: null, outputReserveTokens: 8192, responseFormat: false, structuredOutputs: false, enabled: true, checkedOn: '2026-11-03' };
const entry = `
import app from ${JSON.stringify(path.join(root, 'src/index.ts'))};
import {DistillWorkflow as Base} from ${JSON.stringify(path.join(root, 'src/workflows/distill.ts'))};
export class MetadataWorkflow extends Base {
  run(event,step){return super.run(event,{do:(name,options,callback)=>step.do(name,options,
    name==='extract source'||name==='review and synthesize'?async()=>null:callback)});}
}
export default {async fetch(request,env,ctx){const url=new URL(request.url),revisionId=url.searchParams.get('revisionId');
  if(url.pathname==='/__start')return Response.json({id:(await env.DISTILL.create({id:'metadata-'+revisionId,params:{revisionId,model:${JSON.stringify(model)}}})).id});
  if(url.pathname==='/__status')return Response.json(await(await env.DISTILL.get('metadata-'+revisionId)).status());
  return app.fetch(request,env,ctx);}};`;
const output = path.join(runtime, 'worker.mjs');
await build({ stdin: { contents: entry, loader: 'ts', resolveDir: root, sourcefile: 'metadata-fixture.ts' }, outfile: output,
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], logLevel: 'warning',
  plugins: [{ name: 'node-path', setup(b) { b.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'fixture-path' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture-path' }, () => ({ contents: "export * from 'node:path';", loader: 'js' })); } }] });
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'metadata', rootPath: runtime, scriptPath: output, modules: true,
  compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'metadata-db' }, r2Buckets: { BUCKET: 'metadata-r2' },
  workflows: { DISTILL: { name: 'metadata-storage', className: 'MetadataWorkflow' } }, outboundService: { name: 'no-network' },
  bindings: { ELIOT_LOCAL_DEV: '1', ELIOT_ORIGIN: origin, ELIOT_ACCESS_TEAM_DOMAIN: '', ELIOT_ACCESS_AUD: '', ELIOT_OWNER_EMAIL: '', ELIOT_OWNER_SERVICE_TOKEN: '', ELIOT_MCP_ORIGIN: '', ELIOT_CF_ACCOUNT_ID: '' } },
  { name: 'no-network', modules: true, script: "export default{fetch(){throw new Error('External network forbidden in metadata storage proof');}};" }],
  resourcePersistencePath: path.join(runtime, 'state') }));
const request = async (p, body?) => {
  const r = await mf.dispatchFetch(origin + p, { headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const data = await r.json(); assert(r.ok, JSON.stringify({ p, status: r.status, data })); return data;
};
try {
  await mf.ready; const db = await mf.getD1Database('DB', 'metadata'), bucket = await mf.getR2Bucket('BUCKET', 'metadata');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter(f => /^\d+_.+\.sql$/.test(f)).sort())
    await db.batch(unstable_splitSqlQuery(await readFile(path.join(root, 'migrations', file), 'utf8')).map(sql => db.prepare(sql)));
  for (const mode of ['unknown', 'historical', 'newer-head', 'cached-unicode', 'extraction-references']) {
    const source = crypto.randomUUID(), revision = crypto.randomUUID(), newer = crypto.randomUUID(), prefix = 'source/' + revision + '/';
    const text = mode === 'cached-unicode' ? 'Prefix \u{1f30d}. The \u201cexact quote\u201d ends here. Tail. The method uses normalization. The source retains canonical evidence. The method is described in this source.'
      : mode === 'extraction-references' ? 'The method uses normalization for 9 layers. The source retains canonical evidence. The method is described in this source.'
      : 'References: Мария Ёлкина, 2023. Zoë Example described earlier work in 2024-02.\nThe method uses normalization. The source retains canonical evidence. The method is described in this source.';
    const size = new TextEncoder().encode(text).length;
    const metadata = mode === 'unknown' ? { authors: '', published: null } : { authors: 'Историческая Zoë Łukasz', published: '2021-03' };
    await db.batch([
      db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at,authors,published) VALUES(?,'Metadata fixture','text','owner',1,1,?,?)").bind(source, metadata.authors, metadata.published),
      db.prepare("INSERT INTO source_revision(id,source_id,revision_no,original_key,readable_state,readable_size,created_by,created_at,distill_state,distill_model,distill_calls,distill_started_at) VALUES(?,?,1,?,'readable',?,'owner',1,'running',?,2,?)")
        .bind(revision, source, prefix + 'original', size, model.route, Date.now()),
      db.prepare('UPDATE source SET current_revision_id=? WHERE id=?').bind(revision, source),
    ]);
    if (mode === 'newer-head') await db.batch([
      db.prepare("INSERT INTO source_revision(id,source_id,revision_no,original_key,readable_state,created_by,created_at) VALUES(?,?,2,?,'readable','owner',2)").bind(newer, source, 'source/' + newer + '/original'),
      db.prepare('UPDATE source SET current_revision_id=? WHERE id=?').bind(newer, source),
    ]);
    const guide = ['The method uses normalization.', 'The source retains canonical evidence.', 'The method is described in this source.'].map(text => ({ labels: ['[S1:1]'], text }));
    const usage = { inputTokens: 17, cachedTokens: 0, outputTokens: 8, tokenLimit: 100 };
    const originals = new Map([
      ['text.md', text], ['blocks.json', JSON.stringify([{ id: 1, type: 'paragraph', start: 0, end: size, heading: null }])],
      ['distill-call1.json', JSON.stringify({ output: { guide, questions: ['Which method?', 'Which evidence?', 'What source?'],
        claims: [{ quoteBlock: '[S1:1]', kind: 'method', statement: 'The method uses normalization.', task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }],
        authors: 'Мария Ёлкина', published: '2023' }, usage })],
      ['distill-call2.json', JSON.stringify({ output: { supportedClaims: ['C0'], additionalClaims: [], guide, digest: [guide[0]], glossary: [] }, usage })],
    ]);
    if (mode === 'extraction-references') {
      originals.set('distill-call1.json', JSON.stringify({ output: { guide, questions: ['Which method?', 'Which evidence?', 'What source?'],
        claims: ['Unknown reference [S9:9].', 'The method uses normalization. [S1:1]'].map(statement => ({ quoteBlock: '[S1:1]', kind: 'method', statement,
          task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null })) }, usage }));
    }
    const canonicalQuote = mode === 'cached-unicode' ? 'The \u201cexact quote\u201d ends here.' : text;
    const start = new TextEncoder().encode(text.slice(0, text.indexOf(canonicalQuote))).length;
    const end = start + new TextEncoder().encode(canonicalQuote).length;
    if (mode === 'cached-unicode') {
      // Retained synthetic candidate: current extraction quotes whole canonical blocks exactly.
      // Save-existing still rechecks cached candidates through the conservative normalized matcher.
      originals.set('distill-verified.json', JSON.stringify({
        claims: [{ kind: 'method', statement: 'The source retains a quotation.', quote: 'The "exact quote" ends here.', block: 1,
          task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null, start, end, ambiguous: false, valueNumber: null }],
        evidence: [{ label: '[S1:1]', block: 1, quote: text }], guide, questions: ['Which method?', 'Which evidence?', 'What source?'], dropped: [], clearedNumbers: 0,
      }));
      originals.set('distill.json', JSON.stringify({ state: 'failed', usage: { calls: 2, inputTokens: 34, cachedTokens: 0, outputTokens: 16, tokenLimit: 200 } }));
      await db.prepare("UPDATE source_revision SET distill_state='failed' WHERE id=?").bind(revision).run();
    }
    for (const [name, body] of originals) await bucket.put(prefix + name, body);
    const etags = new Map((await bucket.list({ prefix })).objects.map(o => [o.key, o.etag]));
    if (mode !== 'cached-unicode') {
      await request('/__start?revisionId=' + revision);
      const deadline = Date.now() + 30000; let status;
      do { status = await request('/__status?revisionId=' + revision); if (['complete', 'errored', 'terminated'].includes(status.status)) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
      assert.equal(status.status, 'complete', JSON.stringify(status));
    }
    const p = '/api/sources/' + source + '/understanding';
    if (mode === 'cached-unicode') await request(p, { revisionId: revision, saveAvailable: true });
    for (let repeat = 0; repeat < 2; repeat++) {
      const before = await request(p + '?revisionId=' + revision); assert.equal(before.state, 'done');
      if (mode === 'extraction-references') assert.equal(before.claims[0]?.statement, 'The method uses normalization. ');
      assert.equal(before.authors, metadata.authors); assert.equal(before.published, metadata.published); assert.equal(before.report.usage.calls, 2);
      assert.equal(before.claims.length, 1); assert.equal(before.claims[0].quote, canonicalQuote); assert.equal(before.claims[0].start, start); assert.equal(before.claims[0].end, end);
      assert.equal(before.revisionId, revision);
      const range = await mf.dispatchFetch(origin + '/api/revisions/' + revision + '/range?start=' + start + '&end=' + end);
      assert.equal(range.status, 200); assert.equal(await range.text(), canonicalQuote);
      await request(p, { revisionId: revision, saveAvailable: true });
    }
    const claim = await db.prepare('SELECT source_revision_id,block_index,quote,start_byte,end_byte FROM claim WHERE source_revision_id=?').bind(revision).first();
    assert.deepEqual(claim, { source_revision_id: revision, block_index: 1, quote: canonicalQuote, start_byte: start, end_byte: end });
    const row = await db.prepare('SELECT authors,published,current_revision_id AS head FROM source WHERE id=?').bind(source).first();
    assert.deepEqual(row, { ...metadata, head: mode === 'newer-head' ? newer : revision });
    for (const [name, body] of originals) { const object = await bucket.get(prefix + name); assert.equal(await object.text(), body); assert.equal(object.etag, etags.get(prefix + name)); }
    assert.equal((await db.prepare('SELECT distill_calls FROM source_revision WHERE id=?').bind(revision).first()).distill_calls, 2);
  }
  console.log(JSON.stringify({ scope: 'K3_METADATA_STORAGE', runtime: 'pinned Workerd/Workflows/D1/R2', cases: 5, cachedUnicodeQuoteRecheck: true, extractionStatementReferences: true, paidProducerSteps: 'SKIPPED_WITH_RETAINED_SYNTHETIC_OUTPUT', newModelCalls: 0,
    historicalRecordedCallsPerCase: 2, metadataAndHeadPreserved: true, sourceAndRawBytesEtagsPreserved: true, repeatedGetSave: true, semanticAcceptance: 'NOT_RUN' }));
} finally { await mf.dispose(); }
