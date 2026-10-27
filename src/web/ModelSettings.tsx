// K2 model settings (NEW, this slice). Global defaults + budget in USD
// with explicit save, and the per-project variant (instructions plus a
// nullable answerModel override). Root mounts the global form in App;
// ChatView embeds the project form collapsed. The selected model shows
// its catalog context/output capacity, known job bound and dated USD-per-1M prices
// from GET /models; all reads and writes here are storage-only.
// Global form also owns the AI Gateway connection mini-section
// (GET/PUT /api/models/connection, gatewayId only, no secrets).
import { useEffect, useRef, useState } from 'react';
import { ModelPicker, modelCatalogEntryKey } from './ModelPicker';
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
  const [ready, setReady] = useState(false);
  const [gatewayId, setGatewayId] = useState('');
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
  async function reloadModels(selected?: string): Promise<void> {
    const matches = selected === undefined ? [] : models.filter((model) => model.route === selected || model.aliases?.includes(selected));
    const target = matches.length === 1 ? matches[0] : undefined;
    const targetKey = target ? modelCatalogEntryKey(target) : null;
    const sequence = invalidateModels();
    const generation = gatewayGeneration.current;
    const controller = new AbortController();
    catalogRequest.current.controller = controller;
    const current = () => catalogRequest.current.sequence === sequence
      && gatewayGeneration.current === generation && !controller.signal.aborted;
    if (selected === undefined) { setModelsLoading(true); setModelsError(''); }
    const unknownPrices = () => setModels((previous) => !current() || targetKey === null ? previous : previous.map((model) =>
      modelCatalogEntryKey(model) === targetKey ? { ...model, inputMicrousdPerMillion: null,
        cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null } : model));
    try {
      const d = await apiJson<ModelCatalog>('/api/models' + (selected === undefined ? '' : '?selected=' + encodeURIComponent(selected)), { signal: controller.signal });
      if (!current()) return;
      setModelsWarnings(d.warnings);
      if (selected === undefined) setModels((previous) => current() ? d.models : previous);
      else {
        const details = targetKey === null ? [] : d.models.filter((model) => modelCatalogEntryKey(model) === targetKey);
        const detail = details.length === 1 ? details[0] : undefined;
        if (!detail) {
          unknownPrices();
          setModelsWarnings((warnings) => [...warnings, 'Selected model metadata could not be matched uniquely. Selection was kept.']);
        } else setModels((previous) => {
          if (!current() || previous.filter((model) => modelCatalogEntryKey(model) === targetKey).length !== 1) return previous;
          return previous.map((model) => modelCatalogEntryKey(model) === targetKey
            ? { ...model, ...detail, route: model.route, id: model.id } : model);
        });
      }
    } catch (err) {
      if (!current()) return;
      if (selected !== undefined) {
        unknownPrices();
        setModelsWarnings((warnings) => [...new Set([...warnings, 'Selected model pricing is unavailable. Selection was kept; prices are Unknown.'])]);
        return;
      }
      setModelsError(err instanceof Error ? err.message : 'Could not load model catalog.');
      throw err;
    } finally {
      if (current()) { catalogRequest.current.controller = null; setModelsLoading(false); }
    }
  }
  function retryModels(): void { void reloadModels().catch(() => { /* catalog error is shown beside the picker */ }); }
  function selectedMetadata(route: string): void {
    if (route !== '') void reloadModels(route).catch(() => { /* enrichment warnings are nonblocking */ });
  }
  function selectAnswerModel(route: string): void {
    setAnswerModel(route);
    if (projectId !== undefined) setUseGlobal(route === '');
    selectedMetadata(route);
  }
  function selectDistillModel(route: string): void { setDistillModel(route); selectedMetadata(route); }
  useEffect(() => {
    let live = true;
    const generation = ++gatewayGeneration.current;
    const reads = new AbortController();
    setGatewaySaving(false);
    retryModels();
    if (projectId === undefined) {
      void apiJson<{ settings: GlobalSettings }>('/api/settings', { signal: reads.signal }).then((d) => { if (!live) return; setAnswerModel(d.settings.answerModel); setDistillModel(d.settings.distillModel); setAutoDistill(!!d.settings.autoDistill); setBudgetUsd(String(d.settings.monthlyModelBudgetMicrousd / 1000000)); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
      void apiJson<{ connection: GatewayConnection }>('/api/models/connection', { signal: reads.signal }).then((d) => { if (!live || gatewayGeneration.current !== generation) return; setGatewayId(d.connection.gatewayId ?? ''); setAllowGateway(false); }).catch((err: unknown) => { if (live && gatewayGeneration.current === generation) setGatewayNote(err instanceof Error ? err.message : 'Gateway connection status unavailable.'); });
    } else {
      const pid = projectId;
      void apiJson<{ project: ProjectSettings }>('/api/projects/' + encodeURIComponent(pid), { signal: reads.signal }).then((d) => { if (!live) return; setAnswerModel(d.project.answerModel ?? ''); setUseGlobal(d.project.answerModel === null); setInstructions(d.project.instructions); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
    }
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
  const catalogWarnings = modelsWarnings.length > 0
    ? <p className='er-status' role='status'><span>Model catalog: {modelsWarnings.join(' ')}</span></p> : null;
  if (!ready) return note === '' ? <p className='er-status' role='status'><span>Loading settings…</span></p> : <p className='er-status er-status--error' role='alert'><span>{note}</span></p>;
  if (projectId !== undefined) {
    return (
      <div className='er-models er-models--compact'>
        <label className='er-models__row'>
          <span className='er-models__label'>Instructions<span className='er-models__help'>Guides answers in this project.</span></span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} rows={3} maxLength={2000} />
        </label>
        <ModelPicker label='Answer model' choices={modelChoices} value={useGlobal ? '' : answerModel} emptyLabel='Use global default'
          loading={modelsLoading || gatewaySaving} error={modelsError} onReload={retryModels}
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
          loading={modelsLoading || gatewaySaving} error={modelsError} onReload={retryModels} />
        <ModelPicker label='Understanding model' choices={modelChoices} value={distillModel} onChange={selectDistillModel}
          loading={modelsLoading || gatewaySaving} error={modelsError} onReload={retryModels} />
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
        {otherDisabled.length > 0 ? (<p className='er-status'><span>{otherDisabled.length.toLocaleString('en-US')} models unavailable. Availability details are shown with each model.</span></p>) : null}
        <div className='er-models__actions'>
          <button className='er-button er-button--primary' type='button' onClick={() => void save()}>Save</button>
          {note !== '' ? <p className='er-status' role='status'><span>{note}</span></p> : null}
        </div>
      </section>
      <section className='er-models__card' aria-label='AI Gateway connection'>
        <div className='er-models__head'>
          <h2 className='er-models__title'>AI Gateway</h2>
          <p className='er-status'><span>Use provider credentials already stored in Cloudflare.</span></p>
        </div>
        <label className='er-models__row'>
          <span className='er-models__label'>Gateway ID<span className='er-models__help'>Blank disables.</span></span>
          <input value={gatewayId} onChange={(e) => setGatewayId(e.currentTarget.value)} autoComplete='off' />
        </label>
        <label className='er-models__check'>
          <input type='checkbox' checked={allowGateway} onChange={(e) => setAllowGateway(e.currentTarget.checked)} />
          <span className='er-models__checktext'>Allow external model requests from this workspace.</span>
        </label>
        {gatewayId !== '' ? (<details className='er-models__details'><summary>Provider details</summary><p className='er-status'><span>Gateway {gatewayId} · credential alias default · stored only; never verified by a model call.</span></p>{gatewayHelpHref !== null ? <a className='er-button er-button--text' href={gatewayHelpHref} target='_blank' rel='noopener noreferrer'>Open Gateway integrations</a> : null}</details>) : (<p className='er-status'><span className='er-models__chip' data-status='uncertain'>Not connected</span></p>)}
        <div className='er-models__actions'>
          <button className='er-button er-button--primary' type='button' disabled={gatewaySaving || (gatewayId.trim() !== '' && !allowGateway)} onClick={() => void saveGateway()}>Save connection</button>
          {gatewayNote !== '' ? <p className='er-status' role='status'><span>{gatewayNote}</span></p> : null}
        </div>
      </section>
    </div>
  );
}
