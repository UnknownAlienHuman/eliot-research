// K2 model settings (NEW, this slice). Global defaults + budget in USD
// with explicit save, and the per-project variant (instructions plus a
// nullable answerModel override). Root mounts the global form in App;
// ChatView embeds the project form collapsed. The selected model shows
// its verified context/max-output bounds and dated USD-per-1M prices
// from GET /models; all reads and writes here are storage-only.
// Global form also owns the AI Gateway connection mini-section
// (GET/PUT /api/models/connection, gatewayId only, no secrets).
import { useEffect, useState } from 'react';
import './model-settings.css';
interface ModelRoute { readonly route: string; readonly id?: string; readonly label: string; readonly enabled: boolean; readonly unavailableReason?: string | null; readonly contextTokens: number; readonly maxOutputTokens: number; readonly outputReserveTokens?: number; readonly inputMicrousdPerMillion: number; readonly cachedMicrousdPerMillion: number; readonly outputMicrousdPerMillion: number; readonly checkedOn: string; }
interface GlobalSettings { readonly answerModel: string; readonly distillModel: string; readonly autoDistill: number; readonly monthlyModelBudgetMicrousd: number; readonly updatedAt: number; }
interface ProjectSettings { readonly instructions: string; readonly answerModel: string | null; }
interface GatewayConnection { readonly gatewayId: string | null; readonly provider: string; readonly alias: string; }
async function apiErrorMessage(res: Response): Promise<string> {
  try { const b = (await res.json()) as { error?: { message?: string } }; if (b.error && b.error.message) return b.error.message; } catch { /* status text */ }
  return 'Request failed with status ' + res.status + '.';
}
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.ok) return (await res.json()) as T;
  throw new Error(await apiErrorMessage(res));
}
function usdPerMillion(micro: number): string { return '$' + (micro / 1000000).toFixed(2); }
function optionLabel(m: ModelRoute): string { return m.enabled ? m.label : m.label + ' — unavailable'; }
function isChatModel(m: ModelRoute): boolean { return !/embed|rerank/i.test(m.route + ' ' + (m.id ?? '') + ' ' + m.label); }
export function ModelSettings({ projectId }: { readonly projectId?: string }) {
  const [models, setModels] = useState<ModelRoute[]>([]);
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
  const chatModels = models.filter(isChatModel);
  const effectiveRoute = projectId === undefined ? answerModel : useGlobal ? '' : answerModel;
  const spec = chatModels.find((m) => m.route === effectiveRoute);
  const gatewayOff = gatewayId === '' && chatModels.some((m) => !m.enabled && m.route.startsWith('gateway:'));
  const otherDisabled = chatModels.filter((m) => !m.enabled && !(gatewayOff && m.route.startsWith('gateway:')));
  async function reloadModels(): Promise<void> {
    const d = await apiJson<{ models: ModelRoute[] }>('/api/models');
    setModels(d.models);
  }
  useEffect(() => {
    let live = true;
    void apiJson<{ models: ModelRoute[] }>('/api/models').then((d) => { if (live) setModels(d.models); }).catch(() => { if (live) setModels([]); });
    if (projectId === undefined) {
      void apiJson<{ settings: GlobalSettings }>('/api/settings').then((d) => { if (!live) return; setAnswerModel(d.settings.answerModel); setDistillModel(d.settings.distillModel); setAutoDistill(!!d.settings.autoDistill); setBudgetUsd(String(d.settings.monthlyModelBudgetMicrousd / 1000000)); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
      void apiJson<{ connection: GatewayConnection }>('/api/models/connection').then((d) => { if (!live) return; setGatewayId(d.connection.gatewayId ?? ''); setAllowGateway(false); }).catch((err: unknown) => { if (live) setGatewayNote(err instanceof Error ? err.message : 'Gateway connection status unavailable.'); });
    } else {
      const pid = projectId;
      void apiJson<{ project: ProjectSettings }>('/api/projects/' + encodeURIComponent(pid)).then((d) => { if (!live) return; setAnswerModel(d.project.answerModel ?? ''); setUseGlobal(d.project.answerModel === null); setInstructions(d.project.instructions); setReady(true); }).catch((err: unknown) => { if (live) setNote(err instanceof Error ? err.message : 'Could not load settings.'); });
    }
    return () => { live = false; };
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
    setGatewaySaving(true);
    try {
      const body = trimmed === '' ? { gatewayId: null } : { gatewayId: trimmed, confirmCredentialAccess: true };
      const d = await apiJson<{ connection: GatewayConnection }>('/api/models/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setGatewayId(d.connection.gatewayId ?? '');
      setAllowGateway(false);
      await reloadModels();
      setGatewayNote(trimmed === '' ? 'Gateway disabled.' : 'Saved. Models reloaded; external model was not auto-selected.');
    } catch (err) { setGatewayNote(err instanceof Error ? err.message : 'Could not save Gateway connection.'); }
    finally { setGatewaySaving(false); }
  }
  if (!ready) return note === '' ? <p className='er-status' role='status'><span>Loading settings…</span></p> : <p className='er-status er-status--error' role='alert'><span>{note}</span></p>;
  if (projectId !== undefined) {
    return (
      <div className='er-models er-models--compact'>
        <label className='er-models__row'>
          <span className='er-models__label'>Instructions<span className='er-models__help'>Guides answers in this project.</span></span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} rows={3} maxLength={2000} />
        </label>
        <label className='er-models__row'>
          <span className='er-models__label'>Answer model</span>
          <select value={useGlobal ? '' : answerModel} onChange={(e) => { setUseGlobal(e.currentTarget.value === ''); setAnswerModel(e.currentTarget.value); }}>
            <option value=''>Use global default</option>
            {chatModels.map((m) => (<option key={m.route} value={m.route} disabled={!m.enabled}>{optionLabel(m)}</option>))}
          </select>
        </label>
        {spec !== undefined && !spec.enabled ? (<p className='er-status er-status--error' role='alert'><span>Selected model is unavailable{spec.unavailableReason ? ': ' + spec.unavailableReason : '.'}</span></p>) : null}
        {spec !== undefined ? (<details className='er-models__details'><summary>Model details</summary><p className='er-status'><span>{spec.label} — context {spec.contextTokens.toLocaleString('en-US')} tokens, max output {spec.maxOutputTokens.toLocaleString('en-US')} tokens. {spec.outputReserveTokens === undefined ? '' : 'Output bound per job: ' + spec.outputReserveTokens.toLocaleString('en-US') + ' tokens. '}{usdPerMillion(spec.inputMicrousdPerMillion)} in / {usdPerMillion(spec.cachedMicrousdPerMillion)} cached / {usdPerMillion(spec.outputMicrousdPerMillion)} out per 1M tokens, verified {spec.checkedOn}.</span></p></details>) : null}
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
        <label className='er-models__row'>
          <span className='er-models__label'>Answer model</span>
          <select value={answerModel} onChange={(e) => setAnswerModel(e.currentTarget.value)}>
            {chatModels.map((m) => (<option key={m.route} value={m.route} disabled={!m.enabled}>{optionLabel(m)}</option>))}
          </select>
        </label>
        <label className='er-models__row'>
          <span className='er-models__label'>Understanding model</span>
          <select value={distillModel} onChange={(e) => setDistillModel(e.currentTarget.value)}>
            {chatModels.map((m) => (<option key={m.route} value={m.route} disabled={!m.enabled}>{optionLabel(m)}</option>))}
          </select>
        </label>
        <label className='er-models__check'>
          <input type='checkbox' checked={autoDistill} onChange={(e) => setAutoDistill(e.currentTarget.checked)} />
          <span className='er-models__checktext'>Understand new sources automatically<span className='er-models__help'>Two bounded calls per revision.</span></span>
        </label>
        <label className='er-models__row'>
          <span className='er-models__label'>Monthly budget (USD)</span>
          <input inputMode='decimal' value={budgetUsd} onChange={(e) => setBudgetUsd(e.currentTarget.value)} />
        </label>
        {gatewayOff ? (<p className='er-status'><span>Connect OpenRouter to use these models.</span></p>) : null}
        {otherDisabled.length > 0 ? (<p className='er-status'><span>Unavailable: {otherDisabled.map((m) => m.unavailableReason ? m.label + ' — ' + m.unavailableReason : m.label).join('; ')}.</span></p>) : null}
        {spec !== undefined && !spec.enabled ? (<p className='er-status er-status--error' role='alert'><span>Selected model is unavailable{spec.unavailableReason ? ': ' + spec.unavailableReason : '.'}</span></p>) : null}
        {spec !== undefined ? (<details className='er-models__details'><summary>Model details</summary><p className='er-status'><span>{spec.label} — context {spec.contextTokens.toLocaleString('en-US')} tokens, max output {spec.maxOutputTokens.toLocaleString('en-US')} tokens. {usdPerMillion(spec.inputMicrousdPerMillion)} in / {usdPerMillion(spec.cachedMicrousdPerMillion)} cached / {usdPerMillion(spec.outputMicrousdPerMillion)} out per 1M tokens, verified {spec.checkedOn}.</span></p></details>) : null}
        <div className='er-models__actions'>
          <button className='er-button er-button--primary' type='button' onClick={() => void save()}>Save</button>
          {note !== '' ? <p className='er-status' role='status'><span>{note}</span></p> : null}
        </div>
      </section>
      <section className='er-models__card' aria-label='Connection'>
        <div className='er-models__head'>
          <h2 className='er-models__title'>Connection</h2>
          <p className='er-status'><span>Use the credential already stored in Cloudflare.</span></p>
        </div>
        <label className='er-models__row'>
          <span className='er-models__label'>Gateway ID<span className='er-models__help'>Blank disables.</span></span>
          <input value={gatewayId} onChange={(e) => setGatewayId(e.currentTarget.value)} autoComplete='off' />
        </label>
        <label className='er-models__check'>
          <input type='checkbox' checked={allowGateway} onChange={(e) => setAllowGateway(e.currentTarget.checked)} />
          <span className='er-models__checktext'>Allow OpenRouter requests from this workspace.</span>
        </label>
        {gatewayId !== '' ? (<details className='er-models__details'><summary>Provider details</summary><p className='er-status'><span>Gateway {gatewayId} · OpenRouter · stored only; never verified by a model call.</span></p></details>) : (<p className='er-status'><span className='er-models__chip' data-status='uncertain'>Not connected</span></p>)}
        <div className='er-models__actions'>
          <button className='er-button er-button--primary' type='button' disabled={gatewaySaving || (gatewayId.trim() !== '' && !allowGateway)} onClick={() => void saveGateway()}>Save connection</button>
          {gatewayNote !== '' ? <p className='er-status' role='status'><span>{gatewayNote}</span></p> : null}
        </div>
      </section>
    </div>
  );
}
