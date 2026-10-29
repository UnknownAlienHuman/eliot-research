// K3 Material understanding UI (this slice only). Presentation adapted from
// the moved K1 reader and K2 evidence chips; NotebookLM behavior is reference
// only, paper-qa ideas only. Wire types imported from the root server
// contract src/understanding.ts. All reads are storage-only GETs; the only
// paid trigger is the explicit Understand button.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Markdown } from './Markdown';
import { ModelPicker, type ModelRoute } from './ModelPicker';
import type { DistillState, Overview, OverviewSource, Understanding } from '../understanding';
import './understanding.css';
// Wire types above come from src/understanding.ts; no local duplicates.
type ModelOption = ModelRoute;
function outputCapOf(m: Pick<ModelOption, 'outputReserveTokens' | 'maxOutputTokens'>): number | null {
  const reserve = m.outputReserveTokens ?? null;
  const max = m.maxOutputTokens ?? null;
  const bound = reserve ?? max;
  if (bound === null) return null;
  if (max === null) return bound;
  return Math.min(bound, max);
}
function twoCallBound(m: ModelOption): number | null {
  const context = m.contextTokens;
  const cap = outputCapOf(m);
  if (context === null || cap === null) return null;
  if (!Number.isSafeInteger(context) || context <= 0) return null;
  if (!Number.isSafeInteger(cap) || cap <= 0) return null;
  const perCall = context + cap;
  if (!Number.isSafeInteger(perCall)) return null;
  const bound = 2 * perCall;
  if (!Number.isSafeInteger(bound)) return null;
  return bound;
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
function stateLabel(s: DistillState): string {
  if (s === 'done') return 'Understood';
  if (s === 'partial') return 'Partially understood';
  if (s === 'queued') return 'Queued for understanding';
  if (s === 'running') return 'Understanding now';
  if (s === 'paused') return 'Paused';
  if (s === 'failed') return 'Understanding failed';
  return 'Not yet understood';
}
export function SourceUnderstanding({ projectId, sourceId, revisionId, sourceTitle }: { readonly projectId: string; readonly sourceId: string; readonly revisionId: string; readonly sourceTitle: string }) {
  const [view, setView] = useState<Understanding | undefined>(undefined);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [readVersion, setReadVersion] = useState(0);
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState('');
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [catalogWarnings, setCatalogWarnings] = useState<readonly string[]>([]);
  const [modelRoutePending, setModelRoutePending] = useState(false);
  const base = '/api/sources/' + encodeURIComponent(sourceId) + '/understanding';
  const url = base + '?revisionId=' + encodeURIComponent(revisionId);
  const state = view?.state;
  useEffect(() => { setModelChoice(''); }, [sourceId, revisionId]);
  useEffect(() => {
    let live = true;
    setCatalogueLoaded(false);
    void apiJson<{ models: ModelOption[]; warnings?: string[] }>('/api/models').then((d) => { if (live) { setModels(d.models); setCatalogWarnings(Array.isArray(d.warnings) ? d.warnings : []); setCatalogError(''); setCatalogueLoaded(true); } }).catch((err: unknown) => { if (live) { setCatalogError(err instanceof Error ? err.message : 'Could not load the model catalog.'); setCatalogueLoaded(true); } });
    return () => { live = false; };
  }, [catalogVersion]);
  useEffect(() => {
    if (sourceId === '' || revisionId === '' || (state !== undefined && state !== 'queued' && state !== 'running')) return;
    let live = true;
    let timer = 0;
    let armed = false;
    async function read(): Promise<void> {
      try {
        const d = await apiJson<Understanding>(url);
        if (!live) return;
        setView(d);
        setFailure('');
      } catch (err) { if (live) setFailure(err instanceof Error ? err.message : 'Could not load understanding.'); }
    }
    if (state === undefined) { void read(); }
    else { armed = true; timer = window.setInterval(() => { void read(); }, 3000); }
    return () => { live = false; if (armed) window.clearInterval(timer); };
  }, [sourceId, revisionId, state, url, readVersion]);
  async function understand(): Promise<void> {
    if (sourceId === '' || revisionId === '' || busy || modelRoutePending) return;
    const chosen = models.find((m) => m.route === modelChoice);
    if (modelChoice !== '' && (!chosen || !chosen.enabled)) { setNote(chosen && chosen.unavailableReason ? 'Selected model is unavailable: ' + chosen.unavailableReason : 'Selected model is unavailable.'); return; }
    if (modelChoice === '' && configuredBound === null) { setNote('The default model is currently unavailable, so Understand cannot start yet.'); return; }
    if (modelChoice !== '' && chosen !== undefined && chosen.enabled && twoCallBound(chosen) === null) { setNote('The selected model is currently unavailable, so Understand cannot start yet.'); return; }
    setBusy(true);
    setNote('');
    try {
      await apiJson(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modelChoice === '' ? { revisionId } : { revisionId, model: modelChoice }) });
      const d = await apiJson<Understanding>(url);
      setView(d);
      setFailure('');
    } catch (err) { setNote(err instanceof Error ? err.message : 'Could not start understanding.'); }
    setBusy(false);
  }
  async function saveAvailable(): Promise<void> {
    if (sourceId === '' || revisionId === '' || busy) return;
    setBusy(true);
    setNote('');
    try {
      await apiJson(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId, saveAvailable: true }) });
      const d = await apiJson<Understanding>(url);
      setView(d);
      setFailure('');
    } catch (err) { setNote(err instanceof Error ? err.message : 'Could not save the available output.'); }
    setBusy(false);
  }
  if (sourceId === '' || revisionId === '') return null;
  if (view === undefined) {
    return (
      <section className='er-und' aria-label='Understanding'>
        <h2 className='er-und__title'>Understanding</h2>
        {failure !== '' ? <p className='er-und__error' role='alert'>{failure}</p> : <p className='er-und__hint' role='status'>Loading understanding…</p>}
        {note !== '' ? <p className='er-und__error' role='alert'>{note}</p> : null}
        {failure !== '' ? <div className='er-und__actions'>
          <button className='er-button er-button--tonal' type='button' onClick={() => setReadVersion((v) => v + 1)}>Reload understanding</button>
        </div> : null}
      </section>
    );
  }
  const canRecover = view.canRecover === true;
  const understandingError = view.error;
  const active = view.state === 'queued' || view.state === 'running';
  const canStart = !active && (view.state === 'none' || view.state === 'paused');
  const canSaveAvailable = !active && canRecover && (view.state === 'failed' || view.state === 'done' || view.state === 'partial');
  const references = view.citations.map((c, index) => ({
    text: '[R' + view.revisionId + ':' + c.block + ']',
    label: 'Open quote · ' + sourceTitle + ' · ' + (index + 1),
    block: c.block,
    start: c.start,
    end: c.end,
    href: '/p/' + encodeURIComponent(projectId) + '/source/' + encodeURIComponent(sourceId) + '?revisionId=' + encodeURIComponent(view.revisionId) + '&start=' + c.start + '&end=' + c.end,
  }));
  const referenceByBlock = new Map(references.map((reference) => [reference.block, reference] as const));
  const chosen = models.find((m) => m.route === modelChoice);
  const chosenDisabled = modelChoice !== '' && (!chosen || !chosen.enabled);
  const chosenBound = chosen !== undefined && chosen.enabled ? twoCallBound(chosen) : null;
  const configuredRoute: string | null | undefined = view.progress.configuredModel;
  const configuredSpec = typeof configuredRoute === "string" ? models.find((m) => m.route === configuredRoute) : undefined;
  const configuredLabel = configuredSpec?.label ?? null;
  const progressTokens = view.progress.maximumTokens ?? null;
  const configuredBound = configuredSpec !== undefined ? (configuredSpec.enabled ? twoCallBound(configuredSpec) : null) : progressTokens;
  const pickerEmptyLabel = 'Use configured default' + (configuredLabel !== null ? ' (' + configuredLabel + ')' : '');
  const understandDisabled = busy || modelRoutePending || (modelChoice === '' ? configuredBound === null : chosenDisabled || chosenBound === null);
  const reloadSnapshot = () => { setCatalogError(''); setCatalogWarnings([]); setCatalogVersion((v) => v + 1); };
  return (
    <section className='er-und' aria-label='Understanding'>
      <h2 className='er-und__title'>Understanding</h2>
      <p className='er-und__hint' role='status'>{stateLabel(view.state)}</p>
      {view.authors || view.published ? <p className='er-und__meta'>{[view.authors, view.published].filter(Boolean).join(' · ')}</p> : null}
      {understandingError !== null && understandingError !== '' ? <p className='er-und__error' role='alert'>{understandingError}</p> : null}
      {failure !== '' ? <p className='er-und__error' role='alert'>{failure}</p> : null}
      {canStart ? <div className='er-field er-und__model-details'>
        <ModelPicker label='Understanding model' choices={models} value={modelChoice} onChange={setModelChoice}
          emptyLabel={pickerEmptyLabel} loading={!catalogueLoaded} error={catalogError} compact
          onRoutePendingChange={setModelRoutePending} />
        <button className='er-button er-button--text' type='button' disabled={!catalogueLoaded} onClick={reloadSnapshot}>Reload model list</button>
        {catalogWarnings.length > 0 ? <p className='er-und__hint' role='status'>Model catalog: {catalogWarnings.join(' ')}</p> : null}
        {modelChoice === '' ? (configuredBound === null ? (<p className='er-und__error' role='alert'>The default model is currently unavailable, so Understand cannot start yet.</p>) : null) : chosen !== undefined && chosen.enabled && chosenBound !== null ? null : (<p className='er-und__error' role='alert'>{chosen === undefined || !chosen.enabled ? 'Selected model is unavailable' + (chosen?.unavailableReason ? ': ' + chosen.unavailableReason : '.') : 'The selected model is currently unavailable, so Understand cannot start yet.'}</p>)}
      </div> : null}
      {canStart || failure !== '' || canSaveAvailable ? <div className='er-und__actions'>
        {canStart ? <button className='er-button er-button--tonal' type='button' disabled={understandDisabled} onClick={() => void understand()}>Understand source</button> : null}
        {failure !== '' ? <button className='er-button er-button--text' type='button' onClick={() => setReadVersion((v) => v + 1)}>Reload understanding</button> : null}
        {canSaveAvailable ? <button className='er-button er-button--tonal' type='button' disabled={busy} onClick={() => void saveAvailable()}>{view.state === 'failed' ? 'Save available output' : 'Recheck saved output'}</button> : null}
      </div> : null}
      {note !== '' ? <p className='er-und__error' role='alert'>{note}</p> : null}
      {(view.state === 'done' || view.state === 'partial') ? (<>
        {view.state === 'partial' ? <p className='er-und__hint'>Partial understanding — some material could not be verified.</p> : view.report && (view.report.dropped.length > 0 || view.report.clearedNumbers > 0) ? <p className='er-und__hint'>Some claims or numeric details could not be verified.</p> : null}
        {view.guide !== null && view.guide !== '' ? (<div className='er-und__guide'><h3>Guide</h3><div className='er-und__answer'><Markdown text={view.guide} references={references} /></div></div>) : null}
        {view.digest !== null && view.digest !== '' ? (<div className='er-und__guide'><h3>Digest</h3><div className='er-und__answer'><Markdown text={view.digest} references={references} /></div></div>) : null}
        {view.glossary.length > 0 ? (<div className='er-und__guide'><h3>Glossary</h3><dl className='er-card er-und__glossary'>{view.glossary.map((g, i) => (<div key={g.en + ':' + g.ru + ':' + i}><dt>{g.en} — {g.ru}</dt><dd><Markdown text={g.definition + '\n\n' + g.labels.join(' ')} references={references} /></dd></div>))}</dl></div>) : null}
        <div className='er-und__guide'><h3>Verified claims</h3>{view.claims.length === 0 ? <p className='er-und__hint'>No verified claims stored for this revision.</p> : (<ul className='er-und__claims'>{view.claims.map((c) => (
          <li key={c.id} className='er-card er-und__claim'>
            <p className='er-und__meta'><span>{c.kind}</span>{c.ambiguous ? <span className='er-chip er-und__badge'>ambiguous match</span> : null}</p>
            <p className='er-und__statement'>{c.statement}</p>
            {c.valueText !== null && c.valueText !== '' ? <p className='er-und__meta'><span>{c.valueText}{c.unit !== null && c.unit !== '' ? ' ' + c.unit : ''}</span>{c.conditions !== null && c.conditions !== '' ? <span>{c.conditions}</span> : null}</p> : null}
            {(c.task ?? '') !== '' || (c.metric ?? '') !== '' || (c.dataset ?? '') !== '' ? <p className='er-und__meta'><span>{[c.task, c.metric, c.dataset].filter((x) => x !== null && x !== '').join(' · ')}</span></p> : null}
            <blockquote className='er-und__quote'>{c.quote}</blockquote>
            <Link className='er-und__cite er-citation' to={'/p/' + encodeURIComponent(projectId) + '/source/' + encodeURIComponent(sourceId) + '?revisionId=' + encodeURIComponent(view.revisionId) + '&start=' + c.start + '&end=' + c.end}>{referenceByBlock.get(c.block)?.label ?? 'Open quote · ' + sourceTitle}</Link>
          </li>))}</ul>)}</div>
      </>) : null}
    </section>
  );
}
export function ProjectOverview({ projectId }: { readonly projectId?: string }) {
  const { projectId: routeId } = useParams();
  const pid = projectId ?? routeId ?? '';
  const [rows, setRows] = useState<readonly OverviewSource[] | undefined>(undefined);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (pid === '') return;
    let live = true;
    void apiJson<Overview>('/api/projects/' + encodeURIComponent(pid) + '/overview').then((d) => { if (live) { setRows(d.sources); setFailure(''); } }).catch((err: unknown) => { if (live) setFailure(err instanceof Error ? err.message : 'Could not load the overview.'); });
    return () => { live = false; };
  }, [pid]);
  if (pid === '') return null;
  if (rows === undefined) return failure !== '' ? <p className='er-und__error' role='alert'>{failure}</p> : <p className='er-und__hint' role='status'>Loading overview…</p>;
  if (rows.length === 0) return <p className='er-und__hint'>No sources yet. Add them under Sources first.</p>;
  return (
    <section className='er-und' aria-label='Project overview'>
      <h2 className='er-und__title'>Project overview</h2>
      <ul className='er-und__rows'>{rows.map((r) => (
        <li key={r.sourceId} className='er-card er-und__row'>
          <Link className='er-und__rowtitle' to={'/p/' + encodeURIComponent(pid) + '/source/' + encodeURIComponent(r.sourceId)}>{r.title}</Link>
          <span className='er-und__meta'>{stateLabel(r.state)}</span>
          {r.summary !== null && r.summary !== '' ? <div className='er-und__answer'><Markdown text={r.summary} /></div> : null}
          {r.questions.length > 0 ? (<ul className='er-und__questions'>{r.questions.map((q, i) => (<li key={i}>{q}</li>))}</ul>) : null}
        </li>))}</ul>
    </section>
  );
}
