import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Local-only regression: hold the real D1 validation dependency, accept through
// the ordinary HTTP route, then tear down Workerd without releasing the hold.
assert(process.env.ELIOT_K2_MODEL !== '1', 'Admission recovery fixture forbids model calls.');
const root = process.cwd(), require = createRequire(path.join(root, 'package.json')), wr = createRequire(require.resolve('wrangler'));
const { build } = wr('esbuild'), { Miniflare, convertV4MiniflareOptions } = wr('miniflare'), { unstable_splitSqlQuery } = wr('wrangler');
const runtime = await mkdtemp(path.join(os.tmpdir(), 'eliot-chat-admission-')), output = path.join(runtime, 'worker.mjs');
const origin = 'http://127.0.0.1:5198', projectId = '11111111-1111-4111-8111-111111111111';
const cases = [undefined, 'gateway:must-not-resolve/accepted-model'].map((model, n) => ({
  chatId: `22222222-2222-4222-8222-22222222222${n}`,
  turnId: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`,
  question: 'Retain this accepted question exactly. 文', scopeMode: 'explicit',
  sourceIds: ['44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333'],
  ...(model === undefined ? {} : { model }),
}));
await build({ stdin: { loader: 'ts', resolveDir: root, contents: `
import app from ${JSON.stringify(path.join(root, 'src/index.ts'))};
import { ChatAgent as BaseChatAgent } from ${JSON.stringify(path.join(root, 'src/chat.ts'))};
import { getAgentByName } from 'agents';
export class ChatAgent extends BaseChatAgent {
  fixtureInstance = crypto.randomUUID();
  fixtureMetrics;
  fixtureReadonly = null;
  constructor(ctx, env) {
    const metrics = { validations: 0, modelSettings: 0, admissionWrites: 0, modelCalls: 0, catalogReads: 0 };
    const DB = new Proxy(env.DB, { get(target, key) {
      if (key !== 'prepare') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return (sql) => {
        if (sql.includes('COALESCE(p.answer_model')) metrics.modelSettings++;
        if (sql.startsWith('INSERT INTO chat_turn')) metrics.admissionWrites++;
        const statement = target.prepare(sql);
        if (!sql.includes('SELECT project_id FROM chat WHERE id=')) return statement;
        return { bind(...args) {
          const bound = statement.bind(...args);
          return { async first() {
            const count = ++metrics.validations;
            if (count === 2) await env.GATE.fetch('https://fixture/hold', {method:'POST',body:JSON.stringify({chatId:args[0]})});
            return bound.first();
          } };
        } };
      };
    } });
    super(ctx, {...env, DB,
      BUCKET: { get() { metrics.catalogReads++; throw new Error('Recovery must not read the model catalogue'); } },
      AI: { fetch() { metrics.modelCalls++; throw new Error('Model calls forbidden'); } }
    });
    this.fixtureMetrics = metrics;
  }
  onConnect(connection, context) {
    this.fixtureReadonly = this.isConnectionReadonly(connection);
    return super.onConnect(connection, context);
  }
  fixtureStatus() {
    return {instance:this.fixtureInstance,state:this.state,metrics:this.fixtureMetrics,readonly:this.fixtureReadonly,
      currentReleased:this.current === undefined,controllerReleased:this.controller === undefined,
      turns:this.sql\`SELECT id,payload,created_at,history_version FROM turns ORDER BY created_at,id\`};
  }
}
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/__fixtureStatus') return Response.json(await (await getAgentByName(env.CHAT,url.searchParams.get('chatId'))).fixtureStatus());
  return app.fetch(request, env, ctx);
} };` }, outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], logLevel: 'warning',
  plugins: [{ name: 'fixture-node-path', setup(build) {
    build.onResolve({ filter: /^path$/ }, () => ({ path: 'path', namespace: 'fixture-path' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture-path' }, () => ({ contents: "export * from 'node:path';", loader: 'js' }));
  } }] });
let holding = true;
const held = new Set();
const options = convertV4MiniflareOptions({ workers: [{ name: 'chat-admission', rootPath: runtime, scriptPath: output, modules: true,
  compatibilityDate: '2026-10-24', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'chat-admission-db' }, durableObjects: { CHAT: { className: 'ChatAgent', useSQLite: true } },
  serviceBindings: { GATE: async (request) => {
    const { chatId } = await request.json();
    if (holding) { held.add(chatId); return new Promise(() => {}); }
    return new Response('Validation resumed');
  } },
  bindings: { ELIOT_LOCAL_DEV: '1', ELIOT_ORIGIN: origin, ELIOT_ACCESS_TEAM_DOMAIN: '', ELIOT_ACCESS_AUD: '', ELIOT_OWNER_EMAIL: '',
    ELIOT_OWNER_SERVICE_TOKEN: '', ELIOT_MCP_ORIGIN: '', ELIOT_CF_ACCOUNT_ID: '' },
  outboundService: { name: 'no-network' },
}, { name: 'no-network', modules: true, script: "export default {fetch(){throw new Error('External network forbidden');}};" }],
  resourcePersistencePath: path.join(runtime, 'state'), host: '127.0.0.1', port: 5198, inspectorPort: 0 });
let mf = new Miniflare(options);
const route = (input) => `/api/projects/${projectId}/chats/${input.chatId}`;
const status = (input) => request(`/__fixtureStatus?chatId=${input.chatId}`);
const body = ({ chatId, ...input }) => JSON.stringify(input);
async function request(url, init = {}, expected = 200) {
  const response = await mf.dispatchFetch(origin + url, { ...init, headers: { Origin: origin, 'Content-Type': 'application/json', ...init.headers } });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify({ url, value }));
  return value;
}
function nextFrame(socket, predicate) {
  return new Promise((resolve, reject) => {
    const listener = ({ data }) => { const frame = JSON.parse(data); if (predicate(frame)) { clearTimeout(timer); socket.removeEventListener('message', listener); resolve(frame); } };
    const timer = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('Missing SDK WebSocket frame')); }, 5000);
    socket.addEventListener('message', listener);
  });
}
function noModel(status) {
  assert.equal(status.metrics.modelSettings, 0); assert.equal(status.metrics.admissionWrites, 0);
  assert.equal(status.metrics.catalogReads, 0); assert.equal(status.metrics.modelCalls, 0);
}
try {
  await mf.ready;
  const db = await mf.getD1Database('DB', 'chat-admission');
  for (const file of (await readdir(path.join(root, 'migrations'))).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(path.join(root, 'migrations', file), 'utf8')).map(sql => db.prepare(sql)));
  }
  await db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES(?,'Admission fixture',100,100)").bind(projectId).run();
  const instances = [];
  for (const input of cases) {
    await db.prepare("INSERT INTO chat(id,project_id,title,created_by,created_at,updated_at) VALUES(?,?,'Accepted input','owner',100,100)").bind(input.chatId, projectId).run();
    assert.deepEqual(await request(route(input) + '/turns', { method: 'POST', body: body(input) }, 202), { turnId: input.turnId });
    const before = await status(input); instances.push(before.instance);
    assert.deepEqual(before.state, { active: input.turnId, queued: { projectId, ...input }, stopRequested: false });
    assert.equal(before.turns.length, 0); assert.equal(before.currentReleased, false); assert.equal(before.controllerReleased, true);
    assert.deepEqual(await request(route(input) + '/turns', { method: 'POST', body: body(input) }, 202), { turnId: input.turnId });
    const busy = await request(route(input) + '/turns', { method: 'POST', body: body({ ...input, turnId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001' }) }, 409);
    assert(busy.error.message.includes('current question is still being saved'));
    assert.equal((await request(route(input))).queued, null); noModel(await status(input));
  }
  assert.equal(held.size, cases.length, 'Both real runTurn validation calls reached the held dependency');
  await mf.dispose(); // Actual process teardown, preserving SQLite; no state seeding or lifecycle override.
  holding = false;
  mf = new Miniflare(options); await mf.ready;
  for (const [index, input] of cases.entries()) {
    const response = await mf.dispatchFetch(origin + `/agents/chat-agent/${input.chatId}?projectId=${projectId}`, { headers: { Upgrade: 'websocket', Origin: origin } });
    assert.equal(response.status, 101);
    const socket = response.webSocket; socket.accept();
    try {
      const snapshot = await nextFrame(socket, frame => frame.type === 'snapshot');
      const saved = snapshot.turns.find(turn => turn.turnId === input.turnId);
      assert(saved); assert.equal(snapshot.queued, null); assert.equal(saved.state, 'failed');
      assert.deepEqual(saved.input, { projectId, ...input }); assert.deepEqual(saved.revisionIds, []);
      assert.equal(saved.model, input.model ?? '');
      for (const key of ['inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit']) assert.equal(saved[key], 0);
      assert(saved.error.includes('not sent to the model'));
      assert(saved.error.includes('conversation restarted'), 'Recovery must come from startup, not a drained validation failure during teardown');
      const before = await status(input);
      assert.notEqual(before.instance, instances[index]); assert.equal(before.currentReleased, true); assert.equal(before.controllerReleased, true);
      assert.equal(before.readonly, true);
      assert.deepEqual(before.state, { active: null, queued: null, stopRequested: false }); noModel(before);
      for (const wait of ['', '?wait=1']) {
        const repeated = await request(route(input) + '/turns' + wait, { method: 'POST', body: body(input) }, wait ? 200 : 202);
        assert.deepEqual(repeated.turn ?? repeated, saved);
      }
      socket.send(JSON.stringify({ type: 'cf_agent_state', state: { active: 'client-forged', queued: null, stopRequested: true } }));
      const refused = nextFrame(socket, frame => frame.type === 'rpc' && frame.id === 'readonly-probe');
      socket.send(JSON.stringify({ type: 'rpc', id: 'readonly-probe', method: 'setState', args: [{ active: 'client-forged', queued: null, stopRequested: true }] }));
      assert.equal((await refused).success, false);
      const after = await status(input); assert.deepEqual(after.turns, before.turns); assert.deepEqual(after.state, before.state); noModel(after);
    } finally { socket.close(); }
  }
  const restartedDb = await mf.getD1Database('DB', 'chat-admission');
  assert.equal((await restartedDb.prepare('SELECT count(*) AS n FROM chat_turn').first()).n, 0);
  console.log(JSON.stringify({ scope: 'K2_ACCEPTED_INPUT', runtime: 'pinned Workerd/Agents/D1', acceptedBeforePayload: 2,
    actualRestart: true, exactInputAndOptionalModel: true, readonlySnapshotAndClientRefusal: true, repeatIdStable: true,
    secondQuestionBusyBeforePayload: true, executionHandlesReleased: true, modelResolutionAdmissionDispatch: 0, browserReader: 'NOT_RUN' }));
} finally { await mf.dispose(); }
