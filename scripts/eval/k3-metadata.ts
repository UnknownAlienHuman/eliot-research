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
const encode=TextEncoder.prototype.encode;
TextEncoder.prototype.encode=function(input){
  if(typeof input==='string'&&input.startsWith('UTF-8 reuse fixture')&&input.length>500000)
    throw new Error('Storage verification must reuse canonical bytes, not encode the whole source');
  return encode.call(this,input);
};
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
  const boundaryStatements = Array.from({ length: 31 }, (_, index) => 'The method uses variant ' + String.fromCharCode(65 + index % 26) + (index >= 26 ? 'B' : '') + '.');
  const boundaryExtra = ['The method uses an extra variant.', 'The source retains extra evidence.'];
  for (const mode of ['reviewed-prose', 'unknown', 'historical', 'newer-head', 'cached-unicode', 'extraction-references', 'code-range-references', 'byte-reuse', 'large-byte-reuse', 'decimal-comma', 'cached-decimal-comma', 'empty-additional', 'empty-additional-only', 'claim-boundary', 'prose', 'cached-prose', 'empty-prose', 'code-prose', 'rich-prose', 'cached-rich-prose', 'empty-primary', 'cached-empty-primary', 'ambiguous-claim', 'cached-ambiguous-claim', 'additional-link', 'retained-link', 'cached-additional-link', 'cached-retained-link', 'unselected-link', 'rejected-link', 'duplicate-link', 'guide-drop', 'cached-no-first', 'cached-mismatched-first', 'cached-rejected-link', 'cached-primary-rejected-link', 'cached-bad-first']) {
    const source = crypto.randomUUID(), revision = crypto.randomUUID(), newer = crypto.randomUUID(), prefix = 'source/' + revision + '/';
    const scalar = mode === 'decimal-comma' || mode === 'cached-decimal-comma';
    const cached = mode.startsWith('cached-');
    const byteReuse = mode.endsWith('byte-reuse'), chunks = mode === 'large-byte-reuse' ? 1202 : 512;
    const noClaims = mode === 'empty-additional-only';
    const emptyPrimary = mode === 'empty-primary' || mode === 'cached-empty-primary', rich = mode === 'rich-prose' || mode === 'cached-rich-prose';
    const zeroClaims = noClaims || emptyPrimary;
    const ambiguousClaim = mode === 'ambiguous-claim' || mode === 'cached-ambiguous-claim';
    const additionalLink = mode.endsWith('additional-link'), retainedLink = mode.endsWith('retained-link');
    const unknownOrigin = mode === 'cached-no-first' || mode === 'cached-mismatched-first' || mode === 'cached-bad-first';
    const boundary = mode === 'claim-boundary', sparse = mode === 'prose' || mode === 'cached-prose', noProse = mode === 'empty-prose';
    const lead = 'UTF-8 reuse fixture 😀 я. The method uses normalization. The source retains canonical evidence. The method is described in this source. ';
    const chunk = lead + 'x'.repeat(1023 - new TextEncoder().encode(lead).length) + '\n';
    const text = mode === 'code-prose' ? 'The method uses normalization. The source retains canonical evidence. The method is described in this source. Literal 1, [S1:1], ++ and // are code.'
      : boundary ? 'The method uses normalization. The source retains canonical evidence. The method is described in this source. ' + [...boundaryStatements, ...boundaryExtra].join(' ')
      : scalar ? 'Потеря 😀: 0,500. The method uses normalization. The source retains canonical evidence. The method is described in this source.'
      : byteReuse ? chunk.repeat(chunks)
      : mode === 'cached-unicode' ? 'Prefix \u{1f30d}. The \u201cexact quote\u201d ends here. Tail. The method uses normalization. The source retains canonical evidence. The method is described in this source.'
      : ['extraction-references', 'code-range-references'].includes(mode) ? 'The method uses normalization for 9 layers. The source retains canonical evidence. The method is described in this source.'
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
      ['text.md', text], ['blocks.json', JSON.stringify(Array.from({ length: byteReuse ? chunks : 1 }, (_, i) =>
        ({ id: i + 1, type: 'paragraph', start: i * 1024, end: byteReuse ? (i + 1) * 1024 : size, heading: null })))],
      ['distill-call1.json', JSON.stringify({ output: { guide, questions: ['Which method?', 'Which evidence?', 'What source?'],
        claims: [{ quoteBlock: '[S1:1]', kind: scalar ? 'result' : 'method', statement: scalar ? 'Потеря 😀: 0,500.' : 'The method uses normalization.',
          task: null, metric: scalar ? 'loss' : null, dataset: null, valueText: scalar ? '0,500' : null, unit: null, conditions: null }],
        authors: 'Мария Ёлкина', published: '2023' }, usage })],
      ['distill-call2.json', JSON.stringify({ output: { supportedClaims: ['C0'], additionalClaims: [], guide, digest: [guide[0]], glossary: [] }, usage })],
    ]);
    if (mode === 'reviewed-prose') {
      const first = JSON.parse(originals.get('distill-call1.json'));
      first.output.digest = [{ labels: ['[S1:1]'], text: guide[0].text + ' ' + guide[1].text }];
      first.output.glossary = [{ labels: ['[S1:1]'], en: 'Normalization', ru: 'Нормализация', definition: guide[0].text }];
      originals.set('distill-call1.json', JSON.stringify(first));
      originals.set('distill-call2.json', JSON.stringify({ output: { supportedClaims: ['C0'], additionalClaims: [],
        supportedGuide: ['G0', 'G1', 'G2'], supportedDigest: ['D0'], supportedGlossary: ['T0'] }, usage }));
    }
    if (['extraction-references', 'code-range-references'].includes(mode)) {
      const statements = mode === 'code-range-references'
        ? ['~~~\n` code\n~~~\nUnknown reference [S9:9]. `', 'The method uses normalization.']
        : ['Unknown reference [S9:9].', 'The method uses normalization. [S1:1]'];
      originals.set('distill-call1.json', JSON.stringify({ output: { guide, questions: ['Which method?', 'Which evidence?', 'What source?'],
        claims: statements.map(statement => ({ quoteBlock: '[S1:1]', kind: 'method', statement,
          task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null })) }, usage }));
    }
    if (mode === 'empty-additional' || noClaims) {
      const statements = ['([S1:1])', '**[S1:1]**', ...(noClaims ? [] : ['The method uses normalization.', 'The method uses 9999 layers.'])];
      originals.set('distill-call2.json', JSON.stringify({ output: { supportedClaims: [],
        additionalClaims: statements.map(statement => ({ quoteBlock: '[S1:1]', kind: 'method', statement,
          task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null })), guide, digest: [guide[0]], glossary: [] }, usage }));
    }
    if (boundary) {
      const candidate = statement => ({ quoteBlock: '[S1:1]', kind: 'method', statement,
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null });
      originals.set('distill-call1.json', JSON.stringify({ output: { guide, questions: ['Which method?', 'Which evidence?', 'What source?'],
        claims: boundaryStatements.map(candidate) }, usage }));
      originals.set('distill-call2.json', JSON.stringify({ output: { supportedClaims: boundaryStatements.map((_, index) => 'C' + index),
        additionalClaims: ['[S1:1]', boundaryExtra[0], '[S1:1](https://example.test)'].map(candidate), guide, digest: [guide[0]], glossary: [] }, usage }));
    }
    if (sparse || noProse) {
      const labelOnly = { labels: ['[S1:1]'], text: noProse ? '**[S1:1]**' : cached ? '([S1:1])' : '[S1:1].' }, definition = 'The method [S1:1] uses normalization.';
      originals.set('distill-call2.json', JSON.stringify({ output: { supportedClaims: ['C0'], additionalClaims: [],
        guide: noProse ? [labelOnly, labelOnly, labelOnly] : [{ ...guide[0], text: guide[0].text + ' [S1:1]' }, guide[1], labelOnly],
        digest: noProse ? [labelOnly] : [{ labels: ['[S1:1]'], text: definition }, labelOnly],
        glossary: [
          { en: '', ru: 'Нормализация', definition, labels: ['[S1:1]'] },
          { en: 'Normalization', ru: ' \t', definition, labels: ['[S1:1]'] },
          { en: 'Normalization', ru: 'Нормализация', definition: '**[S1:1]**', labels: ['[S1:1]'] },
          { en: 'Normalization', ru: 'Нормализация', definition: ' \n\t', labels: ['[S1:1]'] },
          { en: 'Normalization', ru: 'Нормализация', definition, labels: ['[S1:1]'] },
        ] }, usage }));
    }
    if (emptyPrimary || ambiguousClaim || retainedLink) {
      const raw = JSON.parse(originals.get('distill-call1.json'));
      raw.output.claims[0].statement = retainedLink ? '[S1:1](https://example.test)' : emptyPrimary ? '([S1:1])' : '~[S1:1]~';
      originals.set('distill-call1.json', JSON.stringify(raw));
      if (emptyPrimary && !cached) {
        const output = JSON.parse(originals.get('distill-call2.json'));
        output.output.supportedClaims = [];
        originals.set('distill-call2.json', JSON.stringify(output));
      }
    }
    if (additionalLink) {
      const output = JSON.parse(originals.get('distill-call2.json'));
      output.output.supportedClaims = [];
      output.output.additionalClaims = [{ quoteBlock: '[S1:1]', kind: 'method', statement: '[S1:1](https://example.test)',
        task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null }];
      originals.set('distill-call2.json', JSON.stringify(output));
    }
    if (['unselected-link', 'rejected-link', 'duplicate-link', 'guide-drop'].includes(mode)) {
      const first = JSON.parse(originals.get('distill-call1.json')), second = JSON.parse(originals.get('distill-call2.json'));
      const link = { ...first.output.claims[0], statement: '[S1:1](https://example.test)' };
      if (mode === 'unselected-link') { first.output.claims.unshift(link); second.output.supportedClaims = ['C1']; }
      if (mode === 'rejected-link') {
        link.conditions = '9999 layers'; first.output.claims.push(link); second.output.additionalClaims = [link];
      }
      if (mode === 'duplicate-link') { first.output.claims[0].statement = '(https://example.test)'; second.output.additionalClaims = [link]; }
      if (mode === 'guide-drop') first.output.guide[0].text = 'Unknown reference [S9:9].';
      originals.set('distill-call1.json', JSON.stringify(first)); originals.set('distill-call2.json', JSON.stringify(second));
    }
    if (mode === 'code-prose' || rich) {
      const output = JSON.parse(originals.get('distill-call2.json'));
      output.output.digest = [{ labels: ['[S1:1]'], text: rich ? cached ? '    //' : '[S1:1](https://example.test)' : '`++`' }];
      if (!rich) {
        output.output.guide = [...guide.slice(0, 2), { labels: ['[S1:1]'], text: '~~~\n[S1:1]\n~~~' }];
        output.output.glossary = [{ en: 'Code', ru: 'Код', definition: '`//`', labels: ['[S1:1]'] }];
      }
      originals.set('distill-call2.json', JSON.stringify(output));
    }
    const canonicalQuote = byteReuse ? chunk : mode === 'cached-unicode' ? 'The \u201cexact quote\u201d ends here.' : text;
    const start = new TextEncoder().encode(text.slice(0, text.indexOf(canonicalQuote))).length;
    const end = start + new TextEncoder().encode(canonicalQuote).length;
    if (cached) {
      if (!scalar && !emptyPrimary && !ambiguousClaim && !retainedLink) {
        const first = JSON.parse(originals.get('distill-call1.json'));
        first.output.claims[0].statement = 'The source retains a quotation.';
        originals.set('distill-call1.json', JSON.stringify(first));
      }
      // Retained synthetic candidate: current extraction quotes whole canonical blocks exactly.
      // Save-existing still rechecks cached candidates through the conservative normalized matcher.
      originals.set('distill-verified.json', JSON.stringify({
        claims: [{ kind: scalar ? 'result' : 'method', statement: retainedLink ? '(https://example.test)' : emptyPrimary ? '****' : ambiguousClaim ? '~~' : scalar ? 'Потеря 😀: 0,500.' : 'The source retains a quotation.',
          quote: mode === 'cached-unicode' ? 'The "exact quote" ends here.' : text, block: 1,
          task: null, metric: scalar ? 'loss' : null, dataset: null, valueText: scalar ? '0,500' : null, unit: null,
          conditions: null, start, end, ambiguous: false, valueNumber: scalar ? 500 : null }],
        evidence: [{ label: '[S1:1]', block: 1, quote: text }], guide, questions: ['Which method?', 'Which evidence?', 'What source?'], dropped: [], clearedNumbers: 0,
      }));
      originals.set('distill.json', JSON.stringify({ state: 'failed', usage: { calls: 2, inputTokens: 34, cachedTokens: 0, outputTokens: 16, tokenLimit: 200 } }));
      await db.prepare("UPDATE source_revision SET distill_state='failed' WHERE id=?").bind(revision).run();
    }
    if (mode === 'cached-no-first') originals.delete('distill-call1.json');
    if (mode === 'cached-bad-first') originals.set('distill-call1.json', '{');
    if (mode === 'cached-mismatched-first') {
      const first = JSON.parse(originals.get('distill-call1.json')); first.output.claims = [];
      originals.set('distill-call1.json', JSON.stringify(first));
    }
    if (mode === 'cached-rejected-link' || mode === 'cached-primary-rejected-link') {
      const first = JSON.parse(originals.get('distill-call1.json')), verified = JSON.parse(originals.get('distill-verified.json'));
      const second = JSON.parse(originals.get('distill-call2.json')), primaryDrop = mode === 'cached-primary-rejected-link';
      first.output.claims.unshift({ ...first.output.claims[0], kind: primaryDrop ? 'result' : 'method', statement: '[S1:1](https://example.test)' });
      verified.claims.unshift({ ...verified.claims[0], kind: primaryDrop ? 'result' : 'method', statement: '(https://example.test)', quote: primaryDrop ? text : 'Unmatched retained quote.' });
      second.output.supportedClaims = ['C0', 'C1'];
      originals.set('distill-call1.json', JSON.stringify(first)); originals.set('distill-verified.json', JSON.stringify(verified));
      originals.set('distill-call2.json', JSON.stringify(second));
    }
    for (const [name, body] of originals) await bucket.put(prefix + name, body);
    const etags = new Map((await bucket.list({ prefix })).objects.map(o => [o.key, o.etag]));
    if (!cached) {
      await request('/__start?revisionId=' + revision);
      const deadline = Date.now() + 30000; let status;
      do { status = await request('/__status?revisionId=' + revision); if (['complete', 'errored', 'terminated'].includes(status.status)) break; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
      assert.equal(status.status, 'complete', JSON.stringify(status));
    }
    const p = '/api/sources/' + source + '/understanding';
    if (cached) await request(p, { revisionId: revision, saveAvailable: true });
    for (let repeat = 0; repeat < 2; repeat++) {
      const before = await request(p + '?revisionId=' + revision); assert.equal(before.state, noProse ? 'failed' : zeroClaims || sparse || rich || ambiguousClaim || additionalLink || retainedLink || unknownOrigin ? 'partial' : 'done', JSON.stringify({ mode, error: before.report?.error }));
      if (mode === 'reviewed-prose') {
        assert.equal(before.digest, guide[0].text + ' ' + guide[1].text + '\n\n[R' + revision + ':1]');
        assert.deepEqual(before.glossary, [{ labels: ['[R' + revision + ':1]'], en: 'Normalization', ru: 'Нормализация', definition: guide[0].text }]);
      }
      if (mode === 'extraction-references') assert.equal(before.claims[0]?.statement, 'The method uses normalization. ');
      if (mode === 'code-range-references') {
        assert.equal(before.claims[0]?.statement, 'The method uses normalization.');
        assert(before.report.dropped.some(item => item.index === 0 && item.reason === 'claim-invalid-reference'));
      }
      assert.equal(before.authors, metadata.authors); assert.equal(before.published, metadata.published); assert.equal(before.report.usage.calls, 2);
      assert.equal(before.claims.length, zeroClaims || noProse ? 0 : boundary ? 32 : 1);
      if (!zeroClaims && !noProse) { assert.equal(before.claims[0].quote, canonicalQuote); assert.equal(before.claims[0].start, start); assert.equal(before.claims[0].end, end); }
      if (emptyPrimary) assert(before.report.dropped.some(item => item.reason === (cached ? 'retained-empty-statement' : 'empty-claim-statement')));
      if (ambiguousClaim) assert.equal(before.claims[0].statement, '~~');
      if (additionalLink || retainedLink) assert.equal(before.claims[0].statement, '(https://example.test)');
      if (mode === 'duplicate-link') assert.equal(before.claims[0].statement, '(https://example.test)');
      if (mode === 'cached-rejected-link' || mode === 'cached-primary-rejected-link') {
        assert.equal(before.claims[0].statement, 'The source retains a quotation.');
        assert(before.report.dropped.some(item => item.index === 0 && item.reason === (mode === 'cached-rejected-link' ? 'retained-unmatched' : 'retained-missing-or-unsupported-primary-result')));
      }
      if (mode === 'guide-drop') assert(before.report.dropped.some(item => item.index === 0 && item.reason === 'guide-invalid-reference'));
      if (mode === 'rejected-link') for (const reason of ['unsupported-condition-numbers', 'additional-unsupported-condition-numbers'])
        assert(before.report.dropped.some(item => item.reason === reason));
      if (rich) assert.equal(before.digest, (cached ? '    //' : '[R' + revision + ':1](https://example.test)') + '\n\n[R' + revision + ':1]');
      if (mode === 'code-prose') {
        assert(before.guide.includes('~~~\n[S1:1]\n~~~'));
        assert.equal(before.digest, '`++`\n\n[R' + revision + ':1]');
        assert.equal(before.glossary[0].definition, '`//`');
      }
      if (boundary) {
        assert.deepEqual(before.claims.map(claim => claim.statement), [...boundaryStatements, boundaryExtra[0]]);
        assert(before.report.dropped.some(item => item.index === 2 && item.reason === 'claim-output-bound'));
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM claim WHERE source_revision_id=?').bind(revision).first()).count, 32);
      }
      if (sparse) {
        const label = '[R' + revision + ':1]';
        assert.equal(before.guide, guide.slice(0, 2).map(item => item.text + '\n\n' + label).join('\n\n'));
        assert.equal(before.digest, 'The method ' + label + ' uses normalization.\n\n' + label);
        assert.deepEqual(before.glossary, [{ en: 'Normalization', ru: 'Нормализация', definition: 'The method ' + label + ' uses normalization.', labels: [label] }]);
        for (const index of [0, 2]) assert(before.report.dropped.some(item => item.index === index && item.reason === 'guide-empty-statement'));
        assert(before.report.dropped.some(item => item.index === 1 && item.reason === 'digest-empty-statement'));
        for (const index of [0, 1, 2, 3]) assert(before.report.dropped.some(item => item.index === index && item.reason === 'glossary-empty-output'));
      }
      if (mode === 'empty-additional' || noClaims) {
        if (!noClaims) assert.equal(before.claims[0].statement, 'The method uses normalization.');
        for (const index of [0, 1]) assert(before.report.dropped.some(item => item.index === index && item.reason === 'additional-empty-statement'));
        if (!noClaims) assert(before.report.dropped.some(item => item.index === 3 && item.reason === 'additional-unsupported-statement-numbers'));
      }
      if (byteReuse) assert.equal(before.claims[0].ambiguous, true);
      if (scalar) { assert.equal(before.claims[0].valueText, '0,500'); assert.equal(before.claims[0].valueNumber, 0.5); }
      assert.equal(before.revisionId, revision);
      const range = await mf.dispatchFetch(origin + '/api/revisions/' + revision + '/range?start=' + start + '&end=' + end);
      assert.equal(range.status, 200); assert.equal(await range.text(), canonicalQuote);
      if (noProse) {
        assert.equal(before.guide, null); assert.equal(before.digest, null);
        const retry = await mf.dispatchFetch(origin + p, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: revision, saveAvailable: true }) });
        assert.equal(retry.status, 409);
      } else await request(p, { revisionId: revision, saveAvailable: true });
    }
    const claim = await db.prepare('SELECT source_revision_id,block_index,quote,start_byte,end_byte,value_text,value_number FROM claim WHERE source_revision_id=?').bind(revision).first();
    assert.deepEqual(claim, zeroClaims || noProse ? null : { source_revision_id: revision, block_index: 1, quote: canonicalQuote, start_byte: start, end_byte: end,
      value_text: scalar ? '0,500' : null, value_number: scalar ? 0.5 : null });
    const row = await db.prepare('SELECT authors,published,current_revision_id AS head FROM source WHERE id=?').bind(source).first();
    assert.deepEqual(row, { ...metadata, head: mode === 'newer-head' ? newer : revision });
    for (const [name, body] of originals) { const object = await bucket.get(prefix + name); assert.equal(await object.text(), body); assert.equal(object.etag, etags.get(prefix + name)); }
    assert.equal((await db.prepare('SELECT distill_calls FROM source_revision WHERE id=?').bind(revision).first()).distill_calls, 2);
  }
  console.log(JSON.stringify({ scope: 'K3_METADATA_STORAGE', runtime: 'pinned Workerd/Workflows/D1/R2', cases: 37, reviewedProseSelection: true, understandingContent: true, ambiguousMarkdownPartial: true, claimOutputBound32: true, decimalCommaScalar: true, emptyAdditionalClaims: true, cachedUnicodeQuoteRecheck: true, extractionStatementReferences: true, codeRangeReferences: true, byteReuse: { sourceBytes: 524288, blocks: 512, wholeSourceEncodeForbidden: true }, largeByteReuse: { sourceBytes: 1230848, blocks: 1202, wholeSourceEncodeForbidden: true }, paidProducerSteps: 'SKIPPED_WITH_RETAINED_SYNTHETIC_OUTPUT', newModelCalls: 0,
    historicalRecordedCallsPerCase: 2, metadataAndHeadPreserved: true, sourceAndRawBytesEtagsPreserved: true, repeatedGetSave: true, semanticAcceptance: 'NOT_RUN' }));
} finally { await mf.dispose(); }
