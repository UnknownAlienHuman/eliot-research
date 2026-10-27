// Caller-only smoke, imported by k2 --command-code-smoke. No work runs on import.
// Live product metadata owns discovery, native IDs, prices and bounds; this caller has no model allowlist.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type Model = { route: string; aliases?: string[]; id: string; enabled: boolean; checkedOn: string; contextTokens: number | null; maxOutputTokens: number | null; outputReserveTokens?: number;
  inputMicrousdPerMillion: number | null; cachedMicrousdPerMillion: number | null; outputMicrousdPerMillion: number | null };
type Settings = { settings: Record<string, unknown>; monthlyBudgetMicrousd: number; monthlyUsedMicrousd: number; monthStart: number };
type Turn = { turnId: string; model: string; state: string; scopeMode: string; contextMode?: string; question: string; answer: string;
  revisionIds: string[]; sourceIds: string[]; citations: unknown[]; invalidLabels: number;
  inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; estimatedCostMicrousd: number | null;
  firstTokenMs: number | null; totalMs: number | null; providerUsage?: unknown; error: string | null };
type Fixture = { origin: string; route: string; id: string; projectId: string | null; chatId: string | null;
  turnId: string; dispatchStarted: boolean; createdAt: string };

export async function runCommandCodeSmoke(): Promise<void> {
  const origin = new URL(process.env.ELIOT_URL || 'http://127.0.0.1:5173').origin;
  const optIn = process.env.ELIOT_CC_MODEL === '1';
  const route = process.env.ELIOT_EVAL_MODEL ?? null;
  const out = fileURLToPath(new URL('../../eval/out/command-code/', import.meta.url));
  await mkdir(out, { recursive: true });
  const idsPath = out + 'ids.json';
  const question = 'No sources are selected. Reply with a brief greeting in English.';
  const report = { scope: 'COMMAND_CODE_CALLER_SMOKE_ONLY', quality: 'K2_K3_NOT_EVALUATED', at: new Date().toISOString(), origin,
    optIn, route, status: 'NOT_RUN', preflight: 'NOT_RUN', modelStatus: 'NOT_RUN', reason: 'ELIOT_CC_MODEL=1 was not supplied.',
    models: [] as (Model & { metadataIssues: string[] })[], connection: null as unknown,
    storage: null as unknown, before: null as Settings | null, after: null as Settings | null, fixture: null as Fixture | null,
    bounds: null as { calls: number; outputTokens: number; timeMs: number; estimatedCostMicrousd: number } | null,
    turn: null as Turn | null, usageCompleteness: 'UNKNOWN', providerUsage: null as unknown, observationError: null as string | null,
    requests: { get: 0, projectPost: 0, chatPost: 0, turnPost: 0 }, violations: [] as string[] };
  async function api<T>(path: string, body?: object, timeoutMs = 15000): Promise<T> {
    if (body === undefined) report.requests.get++;
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Origin: origin, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(path + ': HTTP ' + response.status);
    return await response.json() as T;
  }
  const saveIds = () => writeFile(idsPath, JSON.stringify(report.fixture, null, 2) + '\n');
  let turn: Turn | undefined;
  let observationDeadline: number | null = null;
  try {
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Use a loopback local Worker.');
    const me = await api<{ actor: { type: string; authentication: string } }>('/api/me');
    assert(me.actor.type === 'owner' && me.actor.authentication === 'local', 'Only the local owner fixture is supported.');
    const catalog = await api<{ models: Model[] }>('/api/models' + (route === null ? '' : '?selected=' + encodeURIComponent(route)));
    const connection = await api<{ connection: { gatewayId: string | null; provider: string; alias: string } }>('/api/models/connection');
    report.connection = { gatewayId: connection.connection.gatewayId, provider: connection.connection.provider, alias: connection.connection.alias };
    assert.equal(connection.connection.provider, 'ai-gateway'); assert.equal(connection.connection.alias, 'default');
    report.before = await api<Settings>('/api/settings');
    const projects = await api<{ projects: { id: string }[]; nextCursor: string | null }>('/api/projects');
    report.storage = { projectPageReadable: true, projectsOnPage: projects.projects.length, nextCursor: projects.nextCursor };
    const models = catalog.models.filter((m) => typeof m.route === 'string' && m.route.startsWith('gateway:command-code/'));
    assert(models.length > 0, 'No Command Code models were discovered in the live product catalogue.');
    assert.equal(new Set(models.map((m) => m.route)).size, models.length, 'Duplicate Command Code catalogue routes.');
    for (const model of models) {
      assert(model.route !== 'gateway:command-code/' && typeof model.id === 'string' && model.id.trim().length > 0, 'Missing catalogue route/native ID.');
      const metadataIssues: string[] = [];
      if (!Number.isSafeInteger(model.contextTokens) || (model.contextTokens ?? 0) <= 0) metadataIssues.push('UNKNOWN context');
      const bound = model.outputReserveTokens ?? model.maxOutputTokens;
      if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound <= 0) metadataIssues.push('UNKNOWN job output bound');
      if (model.maxOutputTokens !== null && (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0)) metadataIssues.push('Invalid provider output cap');
      for (const field of ['inputMicrousdPerMillion', 'outputMicrousdPerMillion'] as const) {
        const price = model[field];
        if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) metadataIssues.push('UNKNOWN ' + field);
      }
      if (model.cachedMicrousdPerMillion !== null && (typeof model.cachedMicrousdPerMillion !== 'number' || !Number.isFinite(model.cachedMicrousdPerMillion) || model.cachedMicrousdPerMillion < 0)) metadataIssues.push('Invalid cached price');
      if (typeof model.checkedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(model.checkedOn)) metadataIssues.push('UNKNOWN metadata date');
      report.models.push({ ...model, metadataIssues });
    }
    const resolve = (selected: string) => {
      assert(selected.startsWith('gateway:command-code/'), 'Select a Command Code catalogue route.');
      const matches = report.models.filter((m) => m.route === selected || m.aliases?.includes(selected));
      assert.equal(matches.length, 1, 'Selected route/alias must match exactly one discovered Command Code model.');
      return matches[0]!;
    };
    if (route !== null) resolve(route);
    report.preflight = report.models.some((m) => m.metadataIssues.length > 0) ? 'LIMITED' : 'PASS';
    let fixture: Fixture | null = null;
    try { fixture = JSON.parse(await readFile(idsPath, 'utf8')) as Fixture; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (fixture) {
      assert.equal(fixture.origin, origin, 'The saved fixture belongs to another origin; no redispatch.');
      assert.equal(resolve(fixture.route).id, fixture.id, 'Saved fixture native ID no longer matches the live catalogue.');
      if (route !== null) assert.equal(fixture.route, route, 'Selected route differs from saved attempt; no new attempt.');
      report.route = fixture.route;
      report.fixture = fixture;
      assert(fixture.projectId && fixture.chatId && fixture.dispatchStarted, 'Earlier fixture preparation/dispatch is incomplete or ambiguous; no retry.');
    } else if (optIn) {
      assert(route, 'Set ELIOT_EVAL_MODEL to one selected Command Code route.');
      const model = resolve(route);
      assert.deepEqual(model.metadataIssues, [], 'Selected model context/prices/job bound must be known before any POST.');
      assert(model.enabled === true, 'Selected model is disabled; no fallback or connection write.');
      const outputBound = model.outputReserveTokens ?? model.maxOutputTokens;
      assert(typeof outputBound === 'number', 'A finite per-job output reserve is required when the provider cap is unknown.');
      const output = Math.min(outputBound, model.maxOutputTokens ?? outputBound);
      const context = model.contextTokens, inputRate = model.inputMicrousdPerMillion, outputRate = model.outputMicrousdPerMillion;
      assert(typeof context === 'number' && Number.isSafeInteger(context) && context > 0 && Number.isSafeInteger(output) && output > 0, 'Model token bounds must be known.');
      assert(typeof inputRate === 'number' && typeof outputRate === 'number' && [inputRate, outputRate].every((n) => Number.isFinite(n) && n >= 0), 'Unknown prices must not be treated as zero.');
      // Match product admission: reserve all context at the uncached input rate; nullable cache pricing confers no discount.
      const bound = Math.ceil((context * inputRate + output * outputRate) / 1000000);
      assert(Number.isSafeInteger(bound), 'Model cost bound must be a safe integer.');
      report.bounds = { calls: 1, outputTokens: output, timeMs: 90000, estimatedCostMicrousd: bound };
      assert(report.before.monthlyUsedMicrousd + bound <= report.before.monthlyBudgetMicrousd, 'Preserved budget cannot admit this bound; no budget increase.');
      fixture = { origin, route, id: model.id, projectId: null, chatId: null, turnId: randomUUID(), dispatchStarted: false, createdAt: new Date().toISOString() };
      report.fixture = fixture;
      await writeFile(idsPath, JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
      report.requests.projectPost++;
      const project = await api<{ project: { id: string } }>('/api/projects', { title: 'Command Code isolated caller smoke' });
      fixture.projectId = project.project.id; await saveIds();
      report.requests.chatPost++;
      const chat = await api<{ chat: { id: string } }>('/api/projects/' + fixture.projectId + '/chats', { title: 'One empty-scope turn' });
      fixture.chatId = chat.chat.id; await saveIds();
      fixture.dispatchStarted = true; await saveIds();
      report.modelStatus = 'DISPATCHED';
      report.requests.turnPost++;
      observationDeadline = Date.now() + 120000;
      let result: { turn: Turn } | undefined;
      try {
        result = await api<{ turn: Turn }>('/api/projects/' + fixture.projectId + '/chats/' + fixture.chatId + '/turns?wait=1',
          { turnId: fixture.turnId, question, scopeMode: 'empty', model: route }, 110000);
      } catch (error) {
        // The model may have completed after the response was lost. Observe this ID; never repeat the POST.
        report.observationError = error instanceof Error ? error.message : String(error);
      }
      if (result) {
        assert.equal(result.turn.turnId, fixture.turnId, 'Caller must retain the exact requested turn ID.');
        turn = result.turn; report.turn = turn; report.modelStatus = turn.state; report.providerUsage = turn.providerUsage ?? null;
      }
    }
    if (fixture) {
      const path = '/api/projects/' + fixture.projectId + '/chats/' + fixture.chatId;
      const deadline = observationDeadline ?? Date.now() + (optIn ? 100000 : 0);
      do {
        const stored = await api<{ turns: Turn[] }>(path);
        turn = stored.turns.find((t) => t.turnId === fixture.turnId);
        if (turn && turn.state !== 'started') break;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 2500));
      } while (Date.now() < deadline);
      assert(turn, 'The dispatched turn is absent; outcome unknown, no retry.');
      report.turn = turn;
      report.providerUsage = turn.providerUsage ?? null;
      report.modelStatus = turn.state;
      assert.equal(turn.model, fixture.route, 'Stored turn model must equal the selected route.');
      assert.equal(turn.question, question, 'Stored turn question must equal the single smoke question.');
      assert.equal(turn.scopeMode, 'empty');
      assert.equal(turn.contextMode, 'none');
      assert.deepEqual(turn.sourceIds, []); assert.deepEqual(turn.revisionIds, []); assert.deepEqual(turn.citations, []);
      assert.equal(turn.invalidLabels, 0);
      for (const key of ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs'] as const)
        assert(turn[key] === null || (Number.isSafeInteger(turn[key]) && turn[key]! >= 0), 'Invalid stored metric: ' + key);
      if (turn.cachedTokens !== null && turn.inputTokens !== null) assert(turn.cachedTokens <= turn.inputTokens, 'Cached tokens cannot exceed input.');
      report.usageCompleteness = [turn.inputTokens, turn.cachedTokens, turn.outputTokens].every((n) => n !== null) ? 'KNOWN' : 'PARTIAL';
      assert.equal(turn.state, 'completed', 'Observed ' + turn.state + ': ' + (turn.error ?? 'no terminal success; no retry'));
      assert(turn.answer.trim().length > 0, 'Completed turn must expose a nonempty answer.');
      assert(typeof turn.totalMs === 'number' && turn.totalMs <= 90000, 'Completed turn must remain within the product time bound.');
      report.status = report.usageCompleteness === 'KNOWN' && turn.estimatedCostMicrousd !== null && report.observationError === null ? 'PASS' : 'LIMITED';
      report.reason = 'One stored empty-scope caller result; no K2/K3 quality acceptance.';
    }
  } catch (error) {
    report.status = 'FAIL';
    report.reason = error instanceof Error ? error.message : String(error);
    report.violations.push(report.reason);
  } finally {
    if (report.before) {
      try {
        report.after = await api<Settings>('/api/settings');
        assert.deepEqual(report.after.settings, report.before.settings, 'Global defaults/budget/settings timestamp changed.');
        assert.equal(report.after.monthlyBudgetMicrousd, report.before.monthlyBudgetMicrousd);
        assert.equal(report.after.monthStart, report.before.monthStart);
        const delta = report.after.monthlyUsedMicrousd - report.before.monthlyUsedMicrousd;
        if (report.requests.turnPost === 0) assert.equal(delta, 0, 'Storage reads must not add model usage.');
        else assert(delta >= 0 && delta <= report.bounds!.estimatedCostMicrousd, 'Spend exceeded the one-call bound.');
      } catch (error) {
        report.status = 'FAIL'; report.violations.push(error instanceof Error ? error.message : String(error));
      }
    }
    const path = out + 'smoke-' + Date.now() + '.json';
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, artifact: path }, null, 2));
    if (report.status === 'FAIL' || (optIn && report.modelStatus === 'NOT_RUN')) process.exitCode = 1;
  }
}
