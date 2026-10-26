// K2 model settings (NEW, this slice). Global defaults + budget in USD
// with explicit save, and the per-project variant (instructions plus a
// nullable answerModel override). Root mounts the global form in App;
// ChatView embeds the project form collapsed. The selected model shows
// its verified context/max-output bounds and dated USD-per-1M prices
// from GET /models; all reads and writes here are storage-only.
// Global form also owns the AI Gateway connection mini-section
// (GET/PUT /api/models/connection, gatewayId only, no secrets).
import { useEffect, useState } from 'react';
interface ModelRoute { readonly route: string; readonly label: string; readonly enabled: boolean; readonly unavailableReason?: string | null; readonly contextTokens: number; readonly maxOutputTokens: number; readonly inputMicrousdPerMillion: number; readonly cachedMicrousdPerMillion: number; readonly outputMicrousdPerMillion: number; readonly checkedOn: string; }
interface GlobalSettings { readonly answerModel: string; readonly distillModel: string; readonly autoDistill: number; readonly monthlyModelBudgetMicrousd: number; readonly updatedAt: number; }
interface ProjectSettings { readonly instructions: string; readonly answerModel: string | null; }
interface GatewayConnection { readonly gatewayId: string | null; readonly provider: 'google-ai-studio'; readonly alias: 'default'; }
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
function modelOptionLabel(m: ModelRoute): string { return m.enabled ? m.label : m.label + ' — unavailable' + (m.unavailableReason ? ': ' + m.unavailableReason : ''); }
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
  const effectiveRoute = projectId === undefined ? answerModel : useGlobal ? '' : answerModel;
  const spec = models.find((m) => m.route === effectiveRoute);
  const disabledModels = models.filter((m) => !m.enabled);
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
        const micro = Math.round(Number(budgetUsd) * 1000000);
        if (!Number.isFinite(micro) || micro < 0) { setNote('Enter a non-negative budget in USD.'); return; }
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
      setGatewayNote(trimmed === '' ? 'Gateway disabled.' : 'Gateway saved. Models reloaded; external model was not auto-selected.');
    } catch (err) { setGatewayNote(err instanceof Error ? err.message : 'Could not save Gateway connection.'); }
    finally { setGatewaySaving(false); }
  }
  if (!ready) return note === '' ? <p className='er-chat__hint' role='status'>Loading settings…</p> : <p className='er-chat__error' role='alert'>{note}</p>;
  return (
    <div className='er-chat__scope'>
      {projectId === undefined ? null : (<label className='er-chat__model'>Instructions<textarea value={instructions} onChange={(e) => setInstructions(e.currentTarget.value)} rows={3} maxLength={2000} /></label>)}
      {projectId === undefined ? (<label className='er-chat__model'>Answer model<select value={answerModel} onChange={(e) => setAnswerModel(e.currentTarget.value)}>{models.map((m) => (<option key={m.route} value={m.route} disabled={!m.enabled}>{modelOptionLabel(m)}</option>))}</select></label>) : (<label className='er-chat__model'>Answer model<select value={useGlobal ? '' : answerModel} onChange={(e) => { setUseGlobal(e.currentTarget.value === ''); setAnswerModel(e.currentTarget.value); }}><option value=''>Use global default</option>{models.map((m) => (<option key={m.route} value={m.route} disabled={!m.enabled}>{modelOptionLabel(m)}</option>))}</select></label>)}
      {spec !== undefined ? (<><p className='er-chat__hint'>{spec.label} — context {spec.contextTokens.toLocaleString('en-US')} tokens, max output {spec.maxOutputTokens.toLocaleString('en-US')} tokens.</p><p className='er-chat__hint'>{usdPerMillion(spec.inputMicrousdPerMillion)} in / {usdPerMillion(spec.cachedMicrousdPerMillion)} cached / {usdPerMillion(spec.outputMicrousdPerMillion)} out per 1M tokens, verified {spec.checkedOn}. Turn costs are estimates.</p></>) : null}
      {spec !== undefined && !spec.enabled ? (<p className='er-chat__error' role='alert'>Selected model is unavailable{spec.unavailableReason ? ': ' + spec.unavailableReason : '.'}</p>) : null}
      {disabledModels.length > 0 ? (<p className='er-chat__hint'>Unavailable: {disabledModels.map((m) => modelOptionLabel(m)).join('; ')}.</p>) : null}
      {projectId === undefined ? (<label className='er-chat__model'>Monthly model budget (USD)<input inputMode='decimal' value={budgetUsd} onChange={(e) => setBudgetUsd(e.currentTarget.value)} /></label>) : null}
      {projectId === undefined ? (<><label className='er-chat__model'>Source understanding model<select value={distillModel} onChange={(e) => setDistillModel(e.currentTarget.value)}>{models.map((m) => (<option key={m.route} value={m.route} disabled={!m.enabled}>{modelOptionLabel(m)}</option>))}</select></label><label><input type='checkbox' checked={autoDistill} onChange={(e) => setAutoDistill(e.currentTarget.checked)} /> Understand new readable revisions automatically</label><p className='er-chat__hint'>At most two bounded model calls per new revision, charged to the same monthly budget. Opening or saving existing material does not run a model.</p></>) : null}
      {projectId === undefined ? (<section aria-label='AI Gateway' className='er-chat__scope'><h3>AI Gateway</h3><label className='er-chat__model'>Gateway ID<input value={gatewayId} onChange={(e) => setGatewayId(e.currentTarget.value)} placeholder='Leave blank to disable' autoComplete='off' /></label><label><input type='checkbox' checked={allowGateway} onChange={(e) => setAllowGateway(e.currentTarget.checked)} /> Allow this app to use the existing Google AI Studio default BYOK credential in this Gateway</label><p className='er-chat__hint'>Stored only; the connection is not verified by a model request. No keys are entered here. Paid Send/Understand remain explicit.</p><span className='er-chat__actions'><button className='er-button er-button--primary' type='button' disabled={gatewaySaving || (gatewayId.trim() !== '' && !allowGateway)} onClick={() => void saveGateway()}>Save connection</button></span>{gatewayNote !== '' ? <p className='er-chat__hint' role='status'>{gatewayNote}</p> : null}</section>) : null}
      <span className='er-chat__actions'><button className='er-button er-button--primary' type='button' onClick={() => void save()}>Save</button></span>
      {note !== '' ? <p className='er-chat__hint' role='status'>{note}</p> : null}
    </div>
  );
}
