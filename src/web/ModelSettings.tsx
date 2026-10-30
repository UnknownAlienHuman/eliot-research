// K2 model settings. Global answer/understanding defaults with explicit save, and
// the per-project variant (instructions plus a nullable answerModel override).
// Root mounts global settings; ChatView embeds project defaults collapsed.
// Catalogue reads are storage-only; an explicit Settings action refreshes the
// snapshot before re-reading it. No model job is started here.
// Global form also owns the AI Gateway connection mini-section
// (GET/PUT /api/models/connection, gatewayId only, no secrets).
import { useEffect, useRef, useState } from 'react';
import { ModelPicker } from './ModelPicker';
import { ModelProviders, toDraft, validateDrafts, type Draft as ProviderDraft } from './ModelProviders';
import type { ModelProvider } from '../models';
import type { NativeUsage, ProviderQuota } from '../model-quota';
import type { ModelRoute } from './ModelPicker';
import type { NativeUsageMode } from '../shared/api';
import './model-settings.css';
interface GlobalSettings { readonly answerModel: string; readonly distillModel: string; readonly nativeUsageMode?: NativeUsageMode; readonly updatedAt: number; }
interface ProjectSettings { readonly instructions: string; readonly answerModel: string | null; }
interface GatewayConnection { readonly gatewayId: string | null; readonly provider: string; readonly alias: string; }
interface ModelCatalog { readonly models: ModelRoute[]; readonly warnings: string[]; readonly defaultModel: string; readonly quotas?: ProviderQuota[]; readonly nativeUsage?: NativeUsage | null; }
function quotaLabels(quotas: ProviderQuota[]): Record<string, string | null> {
  return Object.fromEntries(quotas.map((quota) => [quota.providerId,
    quota.usage === null || quota.limit === null ? null :
      `${quota.usage.toLocaleString('en-US')} / ${quota.limit.toLocaleString('en-US')}`]));
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
export function ModelSettings({ projectId, onSaved }: { readonly projectId?: string; readonly onSaved?: () => void }) {
  const [models, setModels] = useState<ModelRoute[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
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
  const gatewayDialog = useRef<HTMLDialogElement | null>(null);
  const [gatewayId, setGatewayId] = useState('');
  const [allowGateway, setAllowGateway] = useState(false);
  const [editingTarget, setEditingTarget] = useState<'answer' | 'distill'>('answer');
  const [gatewayNote, setGatewayNote] = useState('');
  const [initialGatewayId, setInitialGatewayId] = useState('');
  const [providerDrafts, setProviderDrafts] = useState<ProviderDraft[] | null>(null);
  const [providersBaseline, setProvidersBaseline] = useState<readonly ModelProvider[]>([]);
  const [providersError, setProvidersError] = useState('');
  const [providerFieldErrors, setProviderFieldErrors] = useState<Record<number, string>>({});
  const [nativeUsage, setNativeUsage] = useState<NativeUsage | null>(null);
  const [initialAnswer, setInitialAnswer] = useState('');
  const [initialDistill, setInitialDistill] = useState('');
  const [initialNativeUsageMode, setInitialNativeUsageMode] = useState<NativeUsageMode>('included');
  const [savingAll, setSavingAll] = useState(false);
  const catalogRequest = useRef({ sequence: 0, controller: null as AbortController | null });
  const gatewayGeneration = useRef(0);
  const modelChoices = models;
  const trimmedGatewayId = gatewayId.trim();
  const gatewayHelpHref = trimmedGatewayId !== 'default' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmedGatewayId)
    ? 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/gateways/' + encodeURIComponent(trimmedGatewayId) + '/integrations'
    : null;
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
      setProviderQuotas(quotaLabels(d.quotas ?? []));
      setNativeUsage(d.nativeUsage ?? null);
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
  function openGatewayDialog(): void {
    if (gatewayDialog.current !== null && !gatewayDialog.current.open) gatewayDialog.current.showModal();
  }
  function closeGatewayDialog(): void {
    gatewayDialog.current?.close();
  }
  const nativeUsageLabel = nativeUsage !== null && nativeUsage.error === null && nativeUsage.neurons !== null
    ? `Workers AI: ${nativeUsage.neurons.toLocaleString('en-US')} / ${nativeUsage.allowanceNeurons.toLocaleString('en-US')} neurons today`
    : null;
  useEffect(() => {
    let live = true;
    const generation = ++gatewayGeneration.current;
    const reads = new AbortController();
    const catalog = reloadModels();
    let settings: Promise<void>;
    if (projectId === undefined) {
      settings = apiJson<{ settings: GlobalSettings }>('/api/settings', { signal: reads.signal }).then((d) => { if (!live) return; setAnswerModel(d.settings.answerModel); setDistillModel(d.settings.distillModel); setNativeUsageMode(d.settings.nativeUsageMode ?? 'included'); setInitialAnswer(d.settings.answerModel); setInitialDistill(d.settings.distillModel); setInitialNativeUsageMode(d.settings.nativeUsageMode ?? 'included'); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
      if (projectId === undefined) void apiJson<{ providers: ModelProvider[] }>('/api/models/providers', { signal: reads.signal }).then((d) => { if (!live) return; setProviderDrafts(d.providers.map(toDraft)); setProvidersBaseline(d.providers); }).catch(() => { if (live) setProvidersError('Providers are unavailable.'); });
    void apiJson<{ connection: GatewayConnection }>('/api/models/connection', { signal: reads.signal }).then((d) => { if (!live || gatewayGeneration.current !== generation) return; setGatewayId(d.connection.gatewayId ?? ''); setInitialGatewayId(d.connection.gatewayId ?? ''); setAllowGateway(false); }).catch((err: unknown) => { if (live && gatewayGeneration.current === generation) setGatewayNote(err instanceof Error ? err.message : 'Gateway connection status unavailable.'); });
    } else {
      const pid = projectId;
      settings = apiJson<{ project: ProjectSettings }>('/api/projects/' + encodeURIComponent(pid), { signal: reads.signal }).then((d) => { if (!live) return; setAnswerModel(d.project.answerModel ?? ''); setUseGlobal(d.project.answerModel === null); setInstructions(d.project.instructions); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
    }
    void Promise.all([catalog, settings]).catch(() => { /* the owning settings/catalog reader displays its error */ });
    return () => { live = false; reads.abort(); gatewayGeneration.current++; invalidateModels(); };
  }, [projectId]);
  async function save(): Promise<void> {
    setNote('');
    if (projectId !== undefined) {
      setSavingAll(true);
      let saved = false;
      try {
        await apiJson('/api/projects/' + encodeURIComponent(projectId) + '/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instructions, answerModel: useGlobal ? null : answerModel }) });
        setNote('Saved.');
        saved = true;
      } catch (err) { setNote(err instanceof Error ? err.message : 'Could not save settings.'); }
      finally { setSavingAll(false); }
      if (saved) onSaved?.();
      return;
    }
    if (answerModel === '') { setNote('Choose an answer model.'); return; }
    const checked = providerDrafts === null ? null : validateDrafts(providerDrafts);
    if (checked !== null) setProviderFieldErrors(checked.errors);
    if (checked !== null && checked.providers === null) { setNote('Check the highlighted provider fields.'); return; }
    const nextProviders = checked?.providers ?? null;
    const providerChanged = nextProviders !== null && JSON.stringify(providerDrafts) !== JSON.stringify(providersBaseline.map(toDraft));
    const settingsChanged = answerModel !== initialAnswer || distillModel !== initialDistill || nativeUsageMode !== initialNativeUsageMode;
    const gatewayTrimmed = gatewayId.trim();
    const gatewayChanged = gatewayTrimmed !== initialGatewayId;
    if (gatewayChanged && gatewayTrimmed !== '' && !allowGateway) { setNote('gateway: check the box to connect a Gateway, or clear the field to disable'); return; }
    if (providerDrafts !== null && !providerChanged && !settingsChanged && !gatewayChanged) { setNote('No changes.'); return; }
    setSavingAll(true);
    const problems: string[] = [];
    let gatewayReload = false;
    if (providerChanged && nextProviders !== null) {
      try {
        const d = await apiJson<{ providers: ModelProvider[] }>('/api/models/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: nextProviders }) });
        setProviderDrafts(d.providers.map(toDraft));
        setProvidersBaseline(d.providers);
        setProviderFieldErrors({});
        gatewayReload = true;
      } catch (err) { problems.push('providers: ' + (err instanceof Error ? err.message : 'could not save providers')); }
    } else if (providerDrafts === null) {
      problems.push('providers unavailable: provider changes not saved');
    }
    if (settingsChanged) {
      try {
        await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel, distillModel, nativeUsageMode }) });
        setInitialAnswer(answerModel);
        setInitialDistill(distillModel);
        setInitialNativeUsageMode(nativeUsageMode);
      } catch (err) { problems.push('settings: ' + (err instanceof Error ? err.message : 'could not save settings')); }
    }
    if (gatewayChanged) {
      try {
          const gd = await apiJson<{ connection: GatewayConnection }>('/api/models/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(gatewayTrimmed === '' ? { gatewayId: null } : { gatewayId: gatewayTrimmed, confirmCredentialAccess: true }) });
          setGatewayId(gd.connection.gatewayId ?? '');
          setInitialGatewayId(gd.connection.gatewayId ?? '');
          setAllowGateway(false);
          gatewayReload = true;
        } catch (err) { problems.push('gateway connection: ' + (err instanceof Error ? err.message : 'could not save Gateway connection')); }
    }
    if (gatewayReload) void reloadModels();
    setSavingAll(false);
    setNote(problems.length === 0 ? 'Saved.' : 'Partially saved: ' + problems.join('; '));
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

  if (!ready) return note === '' ? <p className='er-status' role='status'><span>Loading settings…</span></p> : <p className='er-status er-status--error' role='alert'><span>{note}</span></p>;
  if (projectId !== undefined) {
    return (
      <div className='er-models er-models--compact'>
        <label className='er-field er-models__row'>
          <span className='er-models__label'>Instructions<span className='er-models__help'>Guides answers in this project.</span></span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} rows={3} maxLength={10000} />
        </label>
        <ModelPicker label='Answer model' choices={modelChoices} value={useGlobal ? '' : answerModel} emptyLabel='Use global default'
          loading={modelsLoading || savingAll} error={modelsError} compact
          onChange={selectAnswerModel} />
        <div className='er-models__actions'>
          <button className='er-button er-button--primary' type='button' disabled={savingAll} onClick={() => void save()}>{savingAll ? 'Saving…' : 'Save'}</button>
          {note !== '' ? <p className='er-status' role='status'><span>{note}</span></p> : null}
        </div>
      </div>
    );
  }
  return (
    <div className='er-models'>
      <section className='er-card er-models__card' aria-label='Models'>
        <div className='er-models__head'>
          <h2 className='er-models__title'>Models</h2>
          <p className='er-status'><span>Defaults for answers and understanding.</span></p>
        </div>
        <fieldset className='er-models__target er-models__target--inline'>
          <legend>Use model for</legend>
          <label className='er-models__check er-models__check--compact'>
            <input type='radio' name='er-models-target' value='answer' disabled={savingAll} checked={editingTarget === 'answer'} onChange={() => setEditingTarget('answer')} />
            <span className='er-models__checktext'>Answers — {answerLabel}</span>
          </label>
          <label className='er-models__check er-models__check--compact'>
            <input type='radio' name='er-models-target' value='distill' disabled={savingAll} checked={editingTarget === 'distill'} onChange={() => setEditingTarget('distill')} />
            <span className='er-models__checktext'>Understanding — {distillLabel}</span>
          </label>
        </fieldset>
        <ModelPicker label={editingTarget === 'answer' ? 'Answer model' : 'Understanding model'} choices={modelChoices} value={editingTarget === 'answer' ? answerModel : distillModel} onChange={(route) => { if (editingTarget === 'answer') selectAnswerModel(route); else selectDistillModel(route); }}
          loading={modelsLoading || savingAll} error={modelsError} />
        <fieldset className='er-models__target er-models__target--inline er-models__usage'>
          <legend>Workers AI usage</legend>
          <label className='er-models__check er-models__check--compact'>
            <input type='radio' name='er-native-usage' value='included' disabled={savingAll} checked={nativeUsageMode === 'included'} onChange={() => setNativeUsageMode('included')} />
            <span className='er-models__checktext'>Use included quota<span className='er-models__help'>Native requests stay paused while the daily cap cannot be verified and enforced.</span></span>
          </label>
          <label className='er-models__check er-models__check--compact'>
            <input type='radio' name='er-native-usage' value='standard' disabled={savingAll} checked={nativeUsageMode === 'standard'} onChange={() => setNativeUsageMode('standard')} />
            <span className='er-models__checktext'>Standard Cloudflare billing<span className='er-models__help'>Standard permits normal Cloudflare billing, including Paid overage, for native requests.</span></span>
          </label>
        </fieldset>
        {nativeUsageLabel !== null ? <p className='er-status'><span>{nativeUsageLabel}</span></p> : null}
        <div className='er-models__actions'>
          <button className='er-button er-button--text' type='button' disabled={modelsLoading || modelsRefreshing || savingAll} onClick={() => void refreshModels()}>
            {modelsRefreshing ? 'Refreshing models…' : 'Refresh models'}
          </button>
          <button className='er-button er-button--text' type='button' disabled={savingAll} onClick={openGatewayDialog}>AI Gateway connection</button>
          <button className='er-button er-button--primary' type='button' disabled={savingAll} onClick={() => void save()}>{savingAll ? 'Saving…' : 'Save'}</button>
          {note !== '' ? <p className='er-status' role='status'><span>{note}</span></p> : null}
        </div>
        {refreshNote !== '' ? <p className='er-status' role={refreshNote === 'Models refreshed.' ? 'status' : 'alert'}>{refreshNote}</p> : null}
        <ModelProviders drafts={providerDrafts} onChange={(d) => { setProviderDrafts(d); setProviderFieldErrors({}); }} quotas={providerQuotas} fieldErrors={providerFieldErrors} disabled={savingAll} />
        {providersError !== '' ? <p className='er-status er-status--error' role='alert'><span>{providersError}</span></p> : null}
        <dialog className='er-dialog er-models__dialog' ref={gatewayDialog} aria-labelledby='er-gateway-connection-title'>
          <h2 className='er-dialog__title' id='er-gateway-connection-title'>AI Gateway connection</h2>
          <div className='er-dialog__body er-models__dialog-body'>
            {gatewayHelpHref !== null ? <a className='er-button er-button--text' href={gatewayHelpHref} target='_blank' rel='noopener noreferrer'>Open Gateway integrations</a> : null}
            <label className='er-field er-models__row'>
              <span className='er-models__label'>Gateway ID</span>
              <input value={gatewayId} disabled={savingAll} onChange={(e) => setGatewayId(e.currentTarget.value)} autoComplete='off' />
            </label>
            <label className='er-models__check er-models__check--compact'>
              <input type='checkbox' disabled={savingAll} checked={allowGateway} onChange={(e) => setAllowGateway(e.currentTarget.checked)} />
              <span className='er-models__checktext'>Allow external model requests from this workspace</span>
            </label>
            <p className='er-status'><span>Credentials remain in Cloudflare.</span></p>
            {gatewayId !== '' ? <p className='er-status'><span>Saved connection does not verify provider usability.</span></p> : null}
            {gatewayNote !== '' ? <p className='er-status' role='status'><span>{gatewayNote}</span></p> : null}
            <div className='er-models__dialog-actions'>
              <button className='er-button er-button--primary' type='button' onClick={closeGatewayDialog}>Done</button>
            </div>
          </div>
        </dialog>
      </section>
    </div>
  );
}
