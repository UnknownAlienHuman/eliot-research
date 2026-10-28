// K2 model settings. Global answer/understanding defaults with explicit save, and
// the per-project variant (instructions plus a nullable answerModel override).
// Root mounts global settings; ChatView embeds project defaults collapsed.
// Catalogue reads are storage-only; an explicit Settings action refreshes the
// snapshot before re-reading it. No model job is started here.
// Global form also owns the AI Gateway connection mini-section
// (GET/PUT /api/models/connection, gatewayId only, no secrets).
import { useEffect, useRef, useState } from 'react';
import { ModelPicker } from './ModelPicker';
import { ModelProviders } from './ModelProviders';
import type { ProviderQuota } from '../model-quota';
import type { ModelRoute } from './ModelPicker';
import type { NativeUsageMode } from '../shared/api';
import './model-settings.css';
interface GlobalSettings { readonly answerModel: string; readonly distillModel: string; readonly nativeUsageMode?: NativeUsageMode; readonly updatedAt: number; }
interface ProjectSettings { readonly instructions: string; readonly answerModel: string | null; }
interface GatewayConnection { readonly gatewayId: string | null; readonly provider: string; readonly alias: string; }
interface ModelCatalog { readonly models: ModelRoute[]; readonly warnings: string[]; readonly defaultModel: string; readonly quotas?: ProviderQuota[]; }
function quotaLabels(quotas: ProviderQuota[]): Record<string, string | null> {
  return Object.fromEntries(quotas.map((quota) => [quota.providerId,
    quota.usage === null && quota.limit === null && quota.resetAt === null ? quota.error === 'quota-unavailable' ? 'Quota unavailable' : null :
      `Last refresh: usage ${quota.usage?.toLocaleString('en-US') ?? 'unknown'} / ${quota.limit?.toLocaleString('en-US') ?? 'unknown'}${quota.unit ? ' ' + quota.unit : ''} · Reset ${quota.resetAt ?? 'unknown'}`]));
}
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
  const [providerQuotas, setProviderQuotas] = useState<Record<string, string | null>>({});
  const [answerModel, setAnswerModel] = useState('');
  const [distillModel, setDistillModel] = useState('');
  const [nativeUsageMode, setNativeUsageMode] = useState<NativeUsageMode>('included');
  const [useGlobal, setUseGlobal] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [note, setNote] = useState('');
  const [refreshNote, setRefreshNote] = useState('');
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [ready, setReady] = useState(false);
  const [gatewayId, setGatewayId] = useState('');
  const [allowGateway, setAllowGateway] = useState(false);
  const [editingTarget, setEditingTarget] = useState<'answer' | 'distill'>('answer');
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
  const answerMatches = modelChoices.filter((m) => m.route === answerModel);
  const answerLabel = answerModel === '' ? 'not chosen' : answerMatches.length === 1 ? answerMatches.at(0)?.label ?? answerModel : answerModel;
  const distillMatches = modelChoices.filter((m) => m.route === distillModel);
  const distillLabel = distillModel === '' ? 'not chosen' : distillMatches.length === 1 ? distillMatches.at(0)?.label ?? distillModel : distillModel;
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
      setProviderQuotas(quotaLabels(d.quotas ?? []));
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
      settings = apiJson<{ settings: GlobalSettings }>('/api/settings', { signal: reads.signal }).then((d) => { if (!live) return; setAnswerModel(d.settings.answerModel); setDistillModel(d.settings.distillModel); setNativeUsageMode(d.settings.nativeUsageMode ?? 'included'); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
      void apiJson<{ connection: GatewayConnection }>('/api/models/connection', { signal: reads.signal }).then((d) => { if (!live || gatewayGeneration.current !== generation) return; setGatewayId(d.connection.gatewayId ?? ''); setAllowGateway(false); }).catch((err: unknown) => { if (live && gatewayGeneration.current === generation) setGatewayNote(err instanceof Error ? err.message : 'Gateway connection status unavailable.'); });
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
        if (answerModel === '') { setNote('Choose an answer model.'); return; }
        await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel, distillModel, nativeUsageMode }) });
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
    try {
      await apiRequest('/api/models/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
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
    if (trimmed !== '' && !allowGateway) { setGatewayNote('Check the box to connect a Gateway, or clear the field to disable.'); return; }
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
          loading={modelsLoading || gatewaySaving} error={modelsError} compact
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
        <fieldset className='er-models__target'>
          <legend>Use model for</legend>
          <label className='er-models__check'>
            <input type='radio' name='er-models-target' value='answer' checked={editingTarget === 'answer'} onChange={() => setEditingTarget('answer')} />
            <span className='er-models__checktext'>Answers — {answerLabel}</span>
          </label>
          <label className='er-models__check'>
            <input type='radio' name='er-models-target' value='distill' checked={editingTarget === 'distill'} onChange={() => setEditingTarget('distill')} />
            <span className='er-models__checktext'>Understanding — {distillLabel}</span>
          </label>
        </fieldset>
        <ModelPicker label={editingTarget === 'answer' ? 'Answer model' : 'Understanding model'} choices={modelChoices} value={editingTarget === 'answer' ? answerModel : distillModel} onChange={(route) => { if (editingTarget === 'answer') selectAnswerModel(route); else selectDistillModel(route); }}
          loading={modelsLoading || gatewaySaving} error={modelsError} />
        {catalogWarnings}
        <fieldset className='er-models__target'>
          <legend>Workers AI usage</legend>
          <label className='er-models__check'>
            <input type='radio' name='er-native-usage' value='included' checked={nativeUsageMode === 'included'} onChange={() => setNativeUsageMode('included')} />
            <span className='er-models__checktext'>Only included quota — 10,000 Neurons/day<span className='er-models__help'>Native requests stay paused until this cap can be enforced. OpenRouter uses its own limits.</span></span>
          </label>
          <label className='er-models__check'>
            <input type='radio' name='er-native-usage' value='standard' checked={nativeUsageMode === 'standard'} onChange={() => setNativeUsageMode('standard')} />
            <span className='er-models__checktext'>Standard Cloudflare billing<span className='er-models__help'>Overage beyond the included quota is billed to the Cloudflare account. Applies to new native requests only. Choosing and saving starts no inference.</span></span>
          </label>
        </fieldset>
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
      <ModelProviders quotas={providerQuotas} onSaved={() => void reloadModels()} />
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
          {gatewayId !== '' ? <p className='er-status'><span>Saved connection does not verify provider usability.</span></p> : null}
          <div className='er-models__actions'>
            <button className='er-button er-button--primary' type='button' disabled={gatewaySaving || (gatewayId.trim() !== '' && !allowGateway)} onClick={() => void saveGateway()}>{gatewaySaving ? 'Saving…' : 'Save connection'}</button>
          </div>
        </details>
        {gatewayNote !== '' ? <p className='er-status' role='status'><span>{gatewayNote}</span></p> : null}
      </section>
    </div>
  );
}
