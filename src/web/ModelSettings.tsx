// K2 model settings. Global defaults + budget in USD with explicit save, and
// the per-project variant (instructions plus a nullable answerModel override).
// Root mounts global settings; ChatView embeds project defaults collapsed.
// Catalogue reads are storage-only; an explicit Settings action refreshes the
// snapshot before re-reading it. No model job is started here.
// Global form also owns the AI Gateway connection mini-section
// (GET/PUT /api/models/connection, gatewayId only, no secrets).
import { useEffect, useRef, useState } from 'react';
import { ModelPicker } from './ModelPicker';
import type { ModelRoute } from './ModelPicker';
import './model-settings.css';
interface GlobalSettings { readonly answerModel: string; readonly distillModel: string; readonly autoDistill: number; readonly monthlyModelBudgetMicrousd: number; readonly updatedAt: number; }
interface ProjectSettings { readonly instructions: string; readonly answerModel: string | null; }
interface GatewayConnection { readonly gatewayId: string | null; readonly provider: string; readonly alias: string; }
interface ModelCatalog { readonly models: ModelRoute[]; readonly warnings: string[]; readonly defaultModel: string; }
async function apiErrorMessage(res: Response): Promise<string> {
  try { const b = (await res.json()) as { error?: { message?: string } }; if (b.error && b.error.message) return b.error.message; } catch { /* status text */ }
  return 'Request failed with status ' + res.status + '.';
}
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.ok) return (await res.json()) as T;
  throw new Error(await apiErrorMessage(res));
}
async function apiRequest(path: string, init?: RequestInit): Promise<void> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new Error(await apiErrorMessage(res));
}
export function ModelSettings({ projectId }: { readonly projectId?: string }) {
  const [models, setModels] = useState<ModelRoute[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [modelsWarnings, setModelsWarnings] = useState<string[]>([]);
  const [answerModel, setAnswerModel] = useState('');
  const [distillModel, setDistillModel] = useState('');
  const [autoDistill, setAutoDistill] = useState(false);
  const [useGlobal, setUseGlobal] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [budgetUsd, setBudgetUsd] = useState('');
  const [note, setNote] = useState('');
  const [refreshNote, setRefreshNote] = useState('');
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [ready, setReady] = useState(false);
  const [gatewayId, setGatewayId] = useState('');
  const [gatewayAlias, setGatewayAlias] = useState('default');
  const [allowGateway, setAllowGateway] = useState(false);
  const [gatewayNote, setGatewayNote] = useState('');
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const catalogRequest = useRef({ sequence: 0, controller: null as AbortController | null });
  const gatewayGeneration = useRef(0);
  const modelChoices = models;
  const trimmedGatewayId = gatewayId.trim();
  const gatewayHelpHref = trimmedGatewayId !== 'default' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmedGatewayId)
    ? 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/gateways/' + encodeURIComponent(trimmedGatewayId) + '/integrations'
    : null;
  const gatewayOff = gatewayId === '' && modelChoices.some((m) => !m.enabled && m.route.startsWith('gateway:'));
  const otherDisabled = modelChoices.filter((m) => !m.enabled && !(gatewayOff && m.route.startsWith('gateway:')));
  function invalidateModels(): number {
    catalogRequest.current.sequence++;
    catalogRequest.current.controller?.abort();
    catalogRequest.current.controller = null;
    return catalogRequest.current.sequence;
  }
  async function reloadModels(): Promise<ModelRoute[] | undefined> {
    const sequence = invalidateModels();
    const generation = gatewayGeneration.current;
    const controller = new AbortController();
    catalogRequest.current.controller = controller;
    const current = () => catalogRequest.current.sequence === sequence
      && gatewayGeneration.current === generation && !controller.signal.aborted;
    setModelsLoading(true);
    setModelsError('');
    try {
      const d = await apiJson<ModelCatalog>('/api/models', { signal: controller.signal });
      if (!current()) return;
      setModelsWarnings(d.warnings);
      setModels((previous) => current() ? d.models : previous);
      return d.models;
    } catch (err) {
      if (!current()) return;
      setModelsError(err instanceof Error ? err.message : 'Could not load model catalog.');
      throw err;
    } finally {
      if (current()) { catalogRequest.current.controller = null; setModelsLoading(false); }
    }
  }
  function selectAnswerModel(route: string): void {
    setAnswerModel(route);
    if (projectId !== undefined) setUseGlobal(route === '');
  }
  function selectDistillModel(route: string): void {
    setDistillModel(route);
  }
  useEffect(() => {
    let live = true;
    const generation = ++gatewayGeneration.current;
    const reads = new AbortController();
    setGatewaySaving(false);
    const catalog = reloadModels();
    let settings: Promise<void>;
    if (projectId === undefined) {
      settings = apiJson<{ settings: GlobalSettings }>('/api/settings', { signal: reads.signal }).then((d) => { if (!live) return; setAnswerModel(d.settings.answerModel); setDistillModel(d.settings.distillModel); setAutoDistill(!!d.settings.autoDistill); setBudgetUsd(String(d.settings.monthlyModelBudgetMicrousd / 1000000)); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
      void apiJson<{ connection: GatewayConnection }>('/api/models/connection', { signal: reads.signal }).then((d) => { if (!live || gatewayGeneration.current !== generation) return; setGatewayId(d.connection.gatewayId ?? ''); setGatewayAlias(d.connection.alias); setAllowGateway(false); }).catch((err: unknown) => { if (live && gatewayGeneration.current === generation) setGatewayNote(err instanceof Error ? err.message : 'Gateway connection status unavailable.'); });
    } else {
      const pid = projectId;
      settings = apiJson<{ project: ProjectSettings }>('/api/projects/' + encodeURIComponent(pid), { signal: reads.signal }).then((d) => { if (!live) return; setAnswerModel(d.project.answerModel ?? ''); setUseGlobal(d.project.answerModel === null); setInstructions(d.project.instructions); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
    }
    void Promise.all([catalog, settings]).catch(() => { /* the owning settings/catalog reader displays its error */ });
    return () => { live = false; reads.abort(); gatewayGeneration.current++; invalidateModels(); };
  }, [projectId]);
  async function save(): Promise<void> {
    setNote('');
    try {
      if (projectId === undefined) {
        const trimmedBudget = budgetUsd.trim();
        if (/^\d+\.\d{7,}$/.test(trimmedBudget)) { setNote('Use up to six decimal places for the monthly budget.'); return; }
        const budgetMatch = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmedBudget);
        if (budgetMatch === null) { setNote('Enter a non-negative budget in USD.'); return; }
        const whole = budgetMatch[1] ?? '';
        if (whole === '') { setNote('Enter a non-negative budget in USD.'); return; }
        const microBig = BigInt(whole) * 1000000n + BigInt((budgetMatch[2] ?? '').padEnd(6, '0'));
        if (microBig > BigInt(Number.MAX_SAFE_INTEGER)) { setNote('Enter a non-negative budget in USD.'); return; }
        const micro = Number(microBig);
        if (answerModel === '') { setNote('Choose an answer model.'); return; }
        await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel, distillModel, autoDistill, monthlyModelBudgetMicrousd: micro }) });
      } else {
        await apiJson('/api/projects/' + encodeURIComponent(projectId) + '/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instructions, answerModel: useGlobal ? null : answerModel }) });
      }
      setNote('Saved.');
    } catch (err) { setNote(err instanceof Error ? err.message : 'Could not save settings.'); }
  }
  async function refreshModels(): Promise<void> {
    if (modelsRefreshing || modelsLoading) return;
    setModelsRefreshing(true);
    setRefreshNote('');
    const selectedRoutes = [...new Set([answerModel, distillModel].filter((route) => route !== ''))];
    try {
      await apiRequest('/api/models/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedRoutes.length > 0 ? { selectedRoutes } : {}),
      });
      await reloadModels();
      setRefreshNote('Models refreshed.');
    } catch (err) {
      setRefreshNote(err instanceof Error ? err.message : 'Could not refresh model catalog.');
    } finally {
      setModelsRefreshing(false);
    }
  }
  async function saveGateway(): Promise<void> {
    setGatewayNote('');
    const trimmed = gatewayId.trim();
    if (trimmed !== '' && !allowGateway) { setGatewayNote('Check the BYOK consent box to connect a Gateway, or clear the field to disable.'); return; }
    const generation = ++gatewayGeneration.current;
    const current = () => gatewayGeneration.current === generation;
    invalidateModels();
    setModelsLoading(true);
    setModelsError('');
    setGatewaySaving(true);
    try {
      const body = trimmed === '' ? { gatewayId: null } : { gatewayId: trimmed, confirmCredentialAccess: true };
      const d = await apiJson<{ connection: GatewayConnection }>('/api/models/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!current()) return;
      setGatewayId(d.connection.gatewayId ?? '');
      setGatewayAlias(d.connection.alias);
      setAllowGateway(false);
      await reloadModels();
      if (current()) setGatewayNote(trimmed === '' ? 'Gateway disabled.' : 'Gateway connection saved.');
    } catch (err) {
      if (!current()) return;
      invalidateModels();
      setModelsLoading(false);
      setModelsError('Reload the model catalog to confirm current Gateway availability.');
      setGatewayNote(err instanceof Error ? err.message : 'Could not save Gateway connection.');
    } finally { if (current()) setGatewaySaving(false); }
  }
  const catalogWarnings = modelsWarnings.length > 0 || otherDisabled.length > 0
    ? <details className='er-models__details'>
      <summary>Provider availability</summary>
      {otherDisabled.length > 0 ? <p className='er-status'><span>Some models are currently unavailable. They remain listed with their provider status.</span></p> : null}
      {modelsWarnings.length > 0 ? <ul className='er-models__warnings'>{modelsWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    </details> : null;
  if (!ready) return note === '' ? <p className='er-status' role='status'><span>Loading settings…</span></p> : <p className='er-status er-status--error' role='alert'><span>{note}</span></p>;
  if (projectId !== undefined) {
    return (
      <div className='er-models er-models--compact'>
        <label className='er-models__row'>
          <span className='er-models__label'>Instructions<span className='er-models__help'>Guides answers in this project.</span></span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} rows={3} maxLength={10000} />
        </label>
        <ModelPicker label='Answer model' choices={modelChoices} value={useGlobal ? '' : answerModel} emptyLabel='Use global default'
          loading={modelsLoading || gatewaySaving} error={modelsError}
          onChange={selectAnswerModel} />
        {catalogWarnings}
        <div className='er-models__actions'>
          <button className='er-button er-button--primary' type='button' onClick={() => void save()}>Save</button>
          {note !== '' ? <p className='er-status' role='status'><span>{note}</span></p> : null}
        </div>
      </div>
    );
  }
  return (
    <div className='er-models'>
      <section className='er-models__card' aria-label='Models'>
        <div className='er-models__head'>
          <h2 className='er-models__title'>Models</h2>
          <p className='er-status'><span>Defaults for answers and understanding.</span></p>
        </div>
        <ModelPicker label='Answer model' choices={modelChoices} value={answerModel} onChange={selectAnswerModel}
          loading={modelsLoading || gatewaySaving} error={modelsError} />
        <ModelPicker label='Understanding model' choices={modelChoices} value={distillModel} onChange={selectDistillModel}
          loading={modelsLoading || gatewaySaving} error={modelsError} />
        {catalogWarnings}
        <label className='er-models__check'>
          <input type='checkbox' checked={autoDistill} onChange={(e) => setAutoDistill(e.currentTarget.checked)} />
          <span className='er-models__checktext'>Understand new sources automatically<span className='er-models__help'>Two bounded calls per revision.</span></span>
        </label>
        <label className='er-models__row'>
          <span className='er-models__label'>Monthly budget (USD)</span>
          <input inputMode='decimal' value={budgetUsd} onChange={(e) => setBudgetUsd(e.currentTarget.value)} />
        </label>
        {gatewayOff ? (<p className='er-status'><span>Connect AI Gateway to use external models.</span></p>) : null}
        <div className='er-models__actions'>
          <button className='er-button er-button--text' type='button' disabled={modelsLoading || modelsRefreshing || gatewaySaving} onClick={() => void refreshModels()}>
            {modelsRefreshing ? 'Refreshing models…' : 'Refresh models'}
          </button>
          <button className='er-button er-button--primary' type='button' onClick={() => void save()}>Save</button>
          {note !== '' ? <p className='er-status' role='status'><span>{note}</span></p> : null}
        </div>
        {refreshNote !== '' ? <p className='er-status' role={refreshNote === 'Models refreshed.' ? 'status' : 'alert'}>{refreshNote}</p> : null}
      </section>
      <section className='er-models__card' aria-label='AI Gateway connection'>
        <div className='er-models__head'>
          <h2 className='er-models__title'>AI Gateway</h2>
          <p className='er-status'><span>External model routing is {gatewayId === '' ? 'not configured' : 'configured'}.</span></p>
        </div>
        {gatewayHelpHref !== null ? <a className='er-button er-button--text' href={gatewayHelpHref} target='_blank' rel='noopener noreferrer'>Open Gateway integrations</a> : null}
        <details className='er-models__details'>
          <summary>Advanced provider settings</summary>
          <label className='er-models__row'>
            <span className='er-models__label'>Gateway ID<span className='er-models__help'>Blank disables external routing.</span></span>
            <input value={gatewayId} onChange={(e) => setGatewayId(e.currentTarget.value)} autoComplete='off' />
          </label>
          <label className='er-models__check'>
            <input type='checkbox' checked={allowGateway} onChange={(e) => setAllowGateway(e.currentTarget.checked)} />
            <span className='er-models__checktext'>Allow external model requests from this workspace.</span>
          </label>
          {gatewayId !== '' ? <p className='er-status'><span>Gateway {gatewayId} · credential alias {gatewayAlias} · saved configuration does not verify provider usability.</span></p> : null}
          <div className='er-models__actions'>
            <button className='er-button er-button--primary' type='button' disabled={gatewaySaving || (gatewayId.trim() !== '' && !allowGateway)} onClick={() => void saveGateway()}>{gatewaySaving ? 'Saving…' : 'Save connection'}</button>
          </div>
        </details>
        {gatewayNote !== '' ? <p className='er-status' role='status'><span>{gatewayNote}</span></p> : null}
      </section>
    </div>
  );
}
