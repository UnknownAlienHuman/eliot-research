// K3 source understanding and project overview. Only explicit Understand starts model work.
import { useEffect, useRef, useState } from 'react';
import { apiJson } from './api';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Markdown } from './Markdown';
import { ModelPicker, type ModelRoute } from './ModelPicker';
import type { DistillState, Overview, Understanding } from '../understanding';
import './understanding.css';
// Wire types above come from src/understanding.ts; no local duplicates.
type ModelOption = ModelRoute;
export interface SuggestedQuestion { readonly sourceId: string; readonly sourceTitle: string; readonly question: string }
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
function stateLabel(s: DistillState): string {
  if (s === 'done') return 'Understood';
  if (s === 'partial') return 'Partially understood';
  if (s === 'queued') return 'Queued for understanding';
  if (s === 'running') return 'Understanding now';
  if (s === 'paused') return 'Paused';
  if (s === 'failed') return 'Understanding failed';
  return 'Not yet understood';
}
function Questions({ questions, onUse, showHint = true }: { readonly questions: readonly string[]; readonly onUse?: ((question: string) => void) | undefined; readonly showHint?: boolean }) {
  const usable = Array.isArray(questions) ? questions.filter(question => typeof question === 'string' && question.trim() !== '') : [];
  if (!usable.length) return null;
  return <div className='er-und__guide'>
    <h3>Suggested questions</h3>
    {showHint ? <p className='er-und__hint'>{onUse ? 'Use in chat selects only this source. Send uses its current readable version.' : 'Open the current source revision to use its questions in chat.'}</p> : null}
    <ul className='er-und__questions'>{usable.map((question, index) => <li key={index}><div className='er-und__question'>
      <span>{question}</span>{onUse ? <button className='er-button er-button--text' type='button' aria-label={'Use question in chat: ' + question}
        onClick={() => onUse(question)}>Use in chat</button> : null}
    </div></li>)}</ul>
  </div>;
}
export function SourceUnderstanding({ projectId, sourceId, revisionId, sourceTitle, onUseQuestion }: { readonly projectId: string; readonly sourceId: string; readonly revisionId: string; readonly sourceTitle: string; readonly onUseQuestion?: ((question: string) => void) | undefined }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [awaitingStatus, setAwaitingStatus] = useState(false);
  const mounted = useRef(false);
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState('');
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [catalogWarnings, setCatalogWarnings] = useState<readonly string[]>([]);
  const [modelRoutePending, setModelRoutePending] = useState(false);
  const base = '/api/sources/' + encodeURIComponent(sourceId) + '/understanding';
  const url = base + '?revisionId=' + encodeURIComponent(revisionId);
  const understanding = useQuery({
    queryKey: ['understanding', sourceId, revisionId],
    queryFn: ({ signal }) => apiJson<Understanding>(url, { signal }),
    enabled: sourceId !== '' && revisionId !== '',
    staleTime: Infinity,
    gcTime: 0,
    networkMode: 'always',
    refetchInterval: query => !query.state.error && (query.state.data?.state === 'queued' || query.state.data?.state === 'running') ? 3000 : false,
  });
  const view = understanding.data;
  const failure = understanding.error?.message ?? '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setModelChoice(''); }, [sourceId, revisionId]);
  useEffect(() => {
    let live = true;
    setCatalogueLoaded(false);
    void apiJson<{ models: ModelOption[]; warnings?: string[] }>('/api/models').then((d) => { if (live) { setModels(d.models); setCatalogWarnings(Array.isArray(d.warnings) ? d.warnings : []); setCatalogError(''); setCatalogueLoaded(true); } }).catch((err: unknown) => { if (live) { setCatalogError(err instanceof Error ? err.message : 'Could not load the model catalog.'); setCatalogueLoaded(true); } });
    return () => { live = false; };
  }, [catalogVersion]);
  async function reload(): Promise<void> {
    const result = await understanding.refetch();
    if (mounted.current && !result.error) { setAwaitingStatus(false); setNote(''); }
  }
  async function request(saveAvailable = false): Promise<void> {
    if (sourceId === '' || revisionId === '' || busy || awaitingStatus || understanding.isFetching || (!saveAvailable && modelRoutePending)) return;
    if (!saveAvailable) {
      const chosen = models.find((m) => m.route === modelChoice);
      if (modelChoice !== '' && (!chosen || !chosen.enabled)) { setNote(chosen && chosen.unavailableReason ? 'Selected model is unavailable: ' + chosen.unavailableReason : 'Selected model is unavailable.'); return; }
      if (modelChoice === '' && configuredBound === null) { setNote('The default model is currently unavailable, so Understand cannot start yet.'); return; }
      if (modelChoice !== '' && chosen !== undefined && chosen.enabled && twoCallBound(chosen) === null) { setNote('The selected model is currently unavailable, so Understand cannot start yet.'); return; }
    }
    setBusy(true);
    setNote('');
    try {
      const input = saveAvailable ? { revisionId, saveAvailable: true } : modelChoice === '' ? { revisionId } : { revisionId, model: modelChoice };
      await apiJson(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      void queryClient.invalidateQueries({ queryKey: ['sources', projectId], exact: true });
      if (!mounted.current) return;
      setAwaitingStatus(true);
      await reload();
    } catch (err) { if (mounted.current) setNote(err instanceof Error ? err.message : 'Could not confirm the request. Reload understanding to check its status.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (sourceId === '' || revisionId === '') return null;
  if (view === undefined) {
    return (
      <section className='er-und' aria-label='Understanding'>
        <h2 className='er-und__title'>Understanding</h2>
        {failure !== '' ? <p className='er-und__error' role='alert'>{failure}</p> : <p className='er-und__hint' role='status'>Loading understanding…</p>}
        {note !== '' ? <p className='er-und__error' role='alert'>{note}</p> : null}
        {failure !== '' ? <div className='er-und__actions'>
          <button className='er-button er-button--tonal' type='button' disabled={understanding.isFetching} onClick={() => void reload()}>Reload understanding</button>
        </div> : null}
      </section>
    );
  }
  const canRecover = view.canRecover === true;
  const understandingError = view.error;
  const active = view.state === 'queued' || view.state === 'running';
  const canStart = !awaitingStatus && !active && (view.state === 'none' || view.state === 'paused');
  const canSaveAvailable = !awaitingStatus && !active && canRecover && (view.state === 'failed' || view.state === 'done' || view.state === 'partial');
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
  const understandDisabled = busy || understanding.isFetching || modelRoutePending || (modelChoice === '' ? configuredBound === null : chosenDisabled || chosenBound === null);
  const reloadSnapshot = () => { setCatalogError(''); setCatalogWarnings([]); setCatalogVersion((v) => v + 1); };
  return (
    <section className='er-und' aria-label='Understanding' aria-busy={busy || understanding.isFetching}>
      <h2 className='er-und__title'>Understanding</h2>
      <p className='er-und__hint' role='status'>{awaitingStatus ? understanding.isFetching ? 'Request accepted. Reading status.' : 'Request accepted. Reload understanding to check its status.' : stateLabel(view.state)}</p>
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
      {canStart || failure !== '' || note !== '' || awaitingStatus || canSaveAvailable ? <div className='er-und__actions'>
        {canStart ? <button className='er-button er-button--tonal' type='button' disabled={understandDisabled} onClick={() => void request()}>Understand source</button> : null}
        {failure !== '' || note !== '' || awaitingStatus ? <button className='er-button er-button--text' type='button' disabled={busy || understanding.isFetching} onClick={() => void reload()}>Reload understanding</button> : null}
        {canSaveAvailable ? <button className='er-button er-button--tonal' type='button' disabled={busy || understanding.isFetching} onClick={() => void request(true)}>{view.state === 'failed' ? 'Save available output' : 'Recheck saved output'}</button> : null}
      </div> : null}
      {note !== '' ? <p className='er-und__error' role='alert'>{note}</p> : null}
      {(view.state === 'done' || view.state === 'partial') ? (<>
        {view.state === 'partial' ? <p className='er-und__hint'>Partial understanding — some material could not be verified.</p> : view.report && (view.report.dropped.length > 0 || view.report.clearedNumbers > 0) ? <p className='er-und__hint'>Some claims or numeric details could not be verified.</p> : null}
        {view.guide !== null && view.guide !== '' ? (<div className='er-und__guide'><h3>Guide</h3><div className='er-und__answer'><Markdown text={view.guide} references={references} /></div></div>) : null}
        <Questions questions={view.report?.questions ?? []} onUse={onUseQuestion} />
        {view.digest !== null && view.digest !== '' ? (<div className='er-und__guide'><h3>Digest</h3><div className='er-und__answer'><Markdown text={view.digest} references={references} /></div></div>) : null}
        {view.glossary.length > 0 ? (<div className='er-und__guide'><h3>Glossary</h3><dl className='er-card er-und__glossary'>{view.glossary.map((g, i) => (<div key={g.en + ':' + g.ru + ':' + i}><dt>{g.en} — {g.ru}</dt><dd><Markdown text={g.definition + '\n\n' + g.labels.join(' ')} references={references} /></dd></div>))}</dl></div>) : null}
        <div className='er-und__guide'><h3>Verified claims</h3>{view.claims.length === 0 ? <p className='er-und__hint'>No verified claims stored for this revision.</p> : (<ul className='er-und__claims'>{view.claims.map((c) => (
          <li key={c.id} className='er-card er-und__claim'>
            <p className='er-und__meta'><span>{c.kind}</span>{c.ambiguous ? <span className='er-chip er-und__badge'>ambiguous match</span> : null}</p>
            <p className='er-und__statement'>{c.statement}</p>
            {c.valueText !== null && c.valueText !== '' ? <p className='er-und__meta'><span>{c.valueText}{c.unit !== null && c.unit.trim() !== '' && !c.valueText.trim().endsWith(c.unit.trim()) ? ' ' + c.unit : ''}</span>{c.conditions !== null && c.conditions !== '' ? <span>{c.conditions}</span> : null}</p> : null}
            {(c.task ?? '') !== '' || (c.metric ?? '') !== '' || (c.dataset ?? '') !== '' ? <p className='er-und__meta'><span>{[c.task, c.metric, c.dataset].filter((x) => x !== null && x !== '').join(' · ')}</span></p> : null}
            <blockquote className='er-und__quote'>{c.quote}</blockquote>
            <Link className='er-und__cite er-citation' to={'/p/' + encodeURIComponent(projectId) + '/source/' + encodeURIComponent(sourceId) + '?revisionId=' + encodeURIComponent(view.revisionId) + '&start=' + c.start + '&end=' + c.end}>{referenceByBlock.get(c.block)?.label ?? 'Open quote · ' + sourceTitle}</Link>
          </li>))}</ul>)}</div>
      </>) : null}
    </section>
  );
}
export function ProjectOverview({ projectId, onUseQuestion }: { readonly projectId?: string; readonly onUseQuestion?: ((suggestion: SuggestedQuestion) => void) | undefined }) {
  const { projectId: routeId } = useParams();
  const pid = projectId ?? routeId ?? '';
  const queryClient = useQueryClient();
  const queryKey = ['overview', pid];
  const overview = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiJson<Overview>('/api/projects/' + encodeURIComponent(pid) + '/overview'
      + (pageParam ? '?cursor=' + encodeURIComponent(pageParam) : ''), { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: pid !== '',
    staleTime: Infinity,
    gcTime: 0,
  });
  const rows = overview.data?.pages.flatMap(page => page.sources);
  const more = () => { if (!overview.isFetching) void overview.fetchNextPage({ cancelRefetch: false }); };
  if (pid === '') return null;
  return (
    <section className='er-und' aria-label='Project overview' aria-busy={overview.isFetching}>
      <h2 className='er-und__title'>Project overview</h2>
      <p className='er-und__hint'>Guides and questions from readable project sources. Use in chat selects one source; Send uses its current readable version. Refresh to include source changes.</p>
      <div className='er-und__actions'><button className='er-button er-button--text' type='button'
        onClick={() => void queryClient.resetQueries({ queryKey, exact: true })}>Refresh overview</button></div>
      {overview.error ? <p className='er-und__error' role='alert'>{overview.error.message} <button className='er-button er-button--text' type='button'
        disabled={overview.isFetching} onClick={() => overview.isFetchNextPageError ? more() : void overview.refetch()}>Retry overview</button></p> : null}
      {rows === undefined ? overview.error ? null : <p className='er-und__hint' role='status'>Loading overview.</p>
        : rows.length === 0 ? <p className='er-und__hint'>No readable sources yet. <Link to={'/p/' + encodeURIComponent(pid) + '/sources'}>Open Sources</Link> to add a source or finish conversion.</p> :
      <ul className='er-und__rows'>{rows.map((r) => (
        <li key={r.sourceId} className='er-card er-und__row'>
          <Link className='er-und__rowtitle' to={'/p/' + encodeURIComponent(pid) + '/source/' + encodeURIComponent(r.sourceId) + '?revisionId=' + encodeURIComponent(r.revisionId)}>{r.title}</Link>
          <span className='er-und__meta'>{stateLabel(r.state)}</span>
          {r.summary !== null && r.summary !== '' ? <div className='er-und__answer'><Markdown text={r.summary} /></div> : null}
          <Questions questions={r.questions} showHint={false} onUse={onUseQuestion ? question => onUseQuestion({ sourceId: r.sourceId, sourceTitle: r.title, question }) : undefined} />
        </li>))}</ul>}
      {overview.hasNextPage ? <button className='er-button er-button--text' type='button' disabled={overview.isFetching} onClick={more}>
        {overview.isFetchingNextPage ? 'Loading more sources.' : 'Load more sources'}</button> : null}
    </section>
  );
}
