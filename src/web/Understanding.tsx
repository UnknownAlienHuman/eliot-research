// K3 source understanding and project overview. Only explicit Understand starts model work.
import { useEffect, useRef, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import type { NativeReasoningEffort, Source } from '../shared/api';
import { apiJson } from './api';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Markdown } from './Markdown';
import { ModelPicker, type ModelRoute } from './ModelPicker';
import type { DistillState, Overview, Understanding, UnderstandingHistory } from '../understanding';
import './understanding.css';
// Wire types above come from src/understanding.ts; no local duplicates.
type ModelOption = ModelRoute;
interface PendingRetry { revisionId: string; model?: string; nativeReasoningEffort?: NativeReasoningEffort; retry: { attemptId: string; previousAttemptId: string } }
function storedRetry(key: string): PendingRetry | null {
  try { const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as PendingRetry | null;
    return value && typeof value.revisionId === 'string' && typeof value.retry?.attemptId === 'string' && typeof value.retry.previousAttemptId === 'string' ? value : null;
  } catch { return null; }
}
export interface SuggestedQuestion { readonly sourceId: string; readonly sourceTitle: string; readonly question: string }
function usableModel(m: ModelOption): boolean {
  return Number.isSafeInteger(m.contextTokens) && m.contextTokens !== null && m.contextTokens > 0;
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
  const sourcesFetching = useIsFetching({ queryKey: ['sources', projectId], exact: true });
  const pendingKey = 'understanding-retry:' + sourceId + ':' + revisionId;
  const [pendingRetry, setPendingRetry] = useState<PendingRetry | null>(() => storedRetry(pendingKey));
  const [historyAttempt, setHistoryAttempt] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [awaitingStatus, setAwaitingStatus] = useState<null | 'unknown' | 'accepted'>(null);
  const statusKey = sourceId + ':' + revisionId + ':' + historyAttempt;
  const [statusReadKey, setStatusReadKey] = useState('');
  const mounted = useRef(false);
  const sourcesSynced = useRef('');
  const [models, setModels] = useState<readonly ModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState('');
  const [nativeEffortChoice, setNativeEffortChoice] = useState<NativeReasoningEffort | ''>('');
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [catalogWarnings, setCatalogWarnings] = useState<readonly string[]>([]);
  const [modelRoutePending, setModelRoutePending] = useState(false);
  const base = '/api/sources/' + encodeURIComponent(sourceId) + '/understanding';
  const url = base + '?revisionId=' + encodeURIComponent(revisionId)
    + (historyAttempt ? '&attemptId=' + encodeURIComponent(historyAttempt) : '')
    + (pendingRetry ? '&requestId=' + encodeURIComponent(pendingRetry.retry.attemptId) : '');
  const history = useInfiniteQuery({
    queryKey: ['understanding-history', sourceId, revisionId], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiJson<UnderstandingHistory>(base + '/history?revisionId=' + encodeURIComponent(revisionId) + (pageParam ? '&cursor=' + encodeURIComponent(pageParam) : ''), { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined, enabled: showHistory, staleTime: Infinity,
  });
  const understanding = useQuery({
    queryKey: ['understanding', sourceId, revisionId, historyAttempt],
    queryFn: ({ signal }) => apiJson<Understanding>(url, { signal }),
    enabled: sourceId !== '' && revisionId !== '' && statusReadKey === statusKey,
    staleTime: Infinity,
    gcTime: 0,
    networkMode: 'always',
    refetchInterval: query => !query.state.error && (query.state.data?.state === 'queued' || query.state.data?.state === 'running') ? 3000 : false,
  });
  const view = understanding.data;
  const effectiveModels = models.filter(model => model.route === (modelChoice || view?.progress.configuredModel));
  const effortModel = effectiveModels.length === 1 ? effectiveModels[0] : undefined;
  const nativeEffortSupported = effortModel?.route.startsWith('workers-ai:') === true
    && (effortModel.nativeReasoningEffort === 'low' || effortModel.nativeReasoningEffort === 'high');
  useEffect(() => { if (!nativeEffortSupported) setNativeEffortChoice(''); }, [nativeEffortSupported]);
  useEffect(() => {
    if (pendingRetry && view?.knownRequestId === pendingRetry.retry.attemptId) {
      sessionStorage.removeItem(pendingKey); setPendingRetry(null);
      if (view.requestRejection) setNote(view.requestRejection);
      else {
        const filter = { queryKey: ['understanding-history', sourceId, revisionId], exact: true };
        // A first fetch has no cached data, so invalidation alone may reuse its pre-accept response.
        void queryClient.cancelQueries(filter).then(() => queryClient.invalidateQueries(filter, { cancelRefetch: false }));
      }
    }
  }, [view, pendingRetry, pendingKey, queryClient, sourceId, revisionId]);
  const failure = understanding.error?.message ?? '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setModelChoice(''); setNativeEffortChoice(''); }, [projectId, sourceId, revisionId]);
  const refetchUnderstanding = understanding.refetch;
  useEffect(() => {
    if (sourceId === '' || revisionId === '') return;
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      void refetchUnderstanding({ cancelRefetch: false }).then(result => {
        if (live && !result.error) setStatusReadKey(statusKey);
      });
    });
    return () => { live = false; };
  }, [statusKey, refetchUnderstanding]);
  useEffect(() => {
    if (!view || historyAttempt !== '' || projectId === '' || view.revisionId !== revisionId ||
      view.attemptId !== view.currentAttemptId || sourcesFetching !== 0) return;
    const sourceQuery = queryClient.getQueryState(['sources', projectId]);
    const cached = queryClient.getQueryData<{ pages: ReadonlyArray<{ sources: Source[] }> }>(['sources', projectId]);
    if (sourceQuery?.status !== 'success' || sourceQuery.fetchStatus !== 'idle' || !cached?.pages) return;
    const source = cached.pages.flatMap(page => page.sources).find(item => item.id === sourceId);
    if (!source || source.currentRevisionId !== revisionId) return;
    const signature = JSON.stringify([statusKey, view.attemptId, view.currentAttemptId, view.state, view.claims.length]);
    if (sourcesSynced.current === signature) return;
    sourcesSynced.current = signature;
    if (source.distillState !== view.state || source.claimCount !== view.claims.length)
      void queryClient.invalidateQueries({ queryKey: ['sources', projectId], exact: true });
  }, [view, historyAttempt, projectId, sourceId, revisionId, statusKey, sourcesFetching, queryClient]);
  useEffect(() => {
    let live = true;
    setCatalogueLoaded(false);
    void apiJson<{ models: ModelOption[]; warnings?: string[] }>('/api/models').then((d) => { if (live) { setModels(d.models); setCatalogWarnings(Array.isArray(d.warnings) ? d.warnings : []); setCatalogError(''); setCatalogueLoaded(true); } }).catch((err: unknown) => { if (live) { setCatalogError(err instanceof Error ? err.message : 'Could not load the model catalog.'); setCatalogueLoaded(true); } });
    return () => { live = false; };
  }, [catalogVersion]);
  async function reload(): Promise<void> {
    const result = await understanding.refetch();
    if (mounted.current && !result.error) { setStatusReadKey(statusKey); setAwaitingStatus(null); setNote(''); }
  }
  function toggleHistory(): void {
    if (!showHistory && history.data) void history.refetch({ cancelRefetch: false });
    setShowHistory(value => !value);
  }
  async function request(saveAvailable = false, retryFailed = false): Promise<void> {
    if (sourceId === '' || revisionId === '' || busy || awaitingStatus || statusReadKey !== statusKey || failure !== '' || understanding.isFetching || (!saveAvailable && modelRoutePending)) return;
    if (!saveAvailable && !(retryFailed && pendingRetry)) {
      const chosen = models.find((m) => m.route === modelChoice);
      if (modelChoice !== '' && (!chosen || !chosen.enabled)) { setNote(chosen && chosen.unavailableReason ? 'Selected model is unavailable: ' + chosen.unavailableReason : 'Selected model is unavailable.'); return; }
      if (modelChoice === '' && !configuredUsable) { setNote('The default model is currently unavailable, so Understand cannot start yet.'); return; }
      if (modelChoice !== '' && chosen !== undefined && chosen.enabled && !usableModel(chosen)) { setNote('The selected model is currently unavailable, so Understand cannot start yet.'); return; }
    }
    const effort = nativeEffortSupported && nativeEffortChoice !== '' ? { nativeReasoningEffort: nativeEffortChoice } : {};
    let retryInput = pendingRetry;
    if (retryFailed && !retryInput) {
      if (!view || !['done', 'failed', 'partial'].includes(view.state) || !view.attemptId) return;
      retryInput = { revisionId, ...(modelChoice ? { model: modelChoice } : {}), ...effort, retry: { attemptId: crypto.randomUUID(), previousAttemptId: view.attemptId } };
      try { sessionStorage.setItem(pendingKey, JSON.stringify(retryInput)); }
      catch { setNote('This browser cannot keep the pending request. Allow site storage before retrying.'); return; }
      setPendingRetry(retryInput);
    }
    setBusy(true);
    setAwaitingStatus('unknown');
    setNote('');
    try {
      const input = retryFailed && retryInput ? retryInput : saveAvailable ? { revisionId, saveAvailable: true } : { revisionId, ...(modelChoice ? { model: modelChoice } : {}), ...effort };
      const accepted = await apiJson<{ revisionId: string; attemptId?: string; rejected?: string }>(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      if (accepted?.revisionId !== revisionId || (retryFailed && accepted.attemptId !== retryInput?.retry.attemptId)) throw new Error('Could not confirm the request. Reload understanding to check its status.');
      void queryClient.invalidateQueries({ queryKey: ['sources', projectId], exact: true });
      if (!mounted.current) return;
      if (accepted.rejected) {
        sessionStorage.removeItem(pendingKey); setPendingRetry(null);
        await reload(); if (mounted.current) setNote(accepted.rejected); return;
      }
      setAwaitingStatus('accepted');
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
        {historyAttempt ? <button className='er-button er-button--text' type='button' disabled={busy || understanding.isFetching} onClick={() => setHistoryAttempt('')}>Current attempt</button> : null}
        {failure !== '' ? <div className='er-und__actions'>
          <button className='er-button er-button--tonal' type='button' disabled={understanding.isFetching} onClick={() => void reload()}>Reload understanding</button>
        </div> : null}
      </section>
    );
  }
  const canRecover = view.canRecover === true;
  const understandingError = view.error;
  const active = view.state === 'queued' || view.state === 'running';
  const statusReady = statusReadKey === statusKey && failure === '' && !understanding.isFetching;
  const historical = historyAttempt !== '';
  const canRetry = !historical && !pendingRetry && !awaitingStatus && statusReady && (view.state === 'done' || view.state === 'failed' || view.state === 'partial') && typeof view.attemptId === 'string';
  const canConfirm = !historical && !!pendingRetry && !awaitingStatus && statusReady;
  const canStart = !historical && !pendingRetry && !awaitingStatus && statusReady && !active && (view.state === 'none' || view.state === 'paused');
  const canSaveAvailable = !historical && !pendingRetry && !awaitingStatus && statusReady && !active && canRecover && (view.state === 'failed' || view.state === 'done' || view.state === 'partial');
  const requestOptionsLocked = busy || pendingRetry !== null || awaitingStatus !== null || !statusReady;
  const effortOptions: readonly NativeReasoningEffort[] = pendingRetry
    ? pendingRetry.nativeReasoningEffort ? [pendingRetry.nativeReasoningEffort] : []
    : nativeEffortSupported ? ['low', 'high'] : [];
  const recordedEffort = view.progress.nativeReasoningEffort;
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
  const chosenUsable = chosen !== undefined && chosen.enabled && usableModel(chosen);
  const configuredRoute: string | null | undefined = view.progress.configuredModel;
  const configuredSpec = typeof configuredRoute === "string" ? models.find((m) => m.route === configuredRoute) : undefined;
  const configuredLabel = configuredSpec?.label ?? null;
  const configuredUsable = configuredSpec !== undefined && configuredSpec.enabled && usableModel(configuredSpec);
  const pickerEmptyLabel = 'Use configured default' + (configuredLabel !== null ? ' (' + configuredLabel + ')' : '');
  const understandDisabled = busy || failure !== '' || understanding.isFetching || modelRoutePending || (modelChoice === '' ? !configuredUsable : chosenDisabled || !chosenUsable);
  const hasGuide = typeof view.guide === 'string' && view.guide.trim() !== '';
  const hasDigest = typeof view.digest === 'string' && view.digest.trim() !== '';
  const claimDetailsDropped = view.report?.dropped.some(({ reason }) => !reason.startsWith('guide-') && !reason.startsWith('glossary-')) ?? false;
  const partialNotice = !hasGuide && hasDigest
    ? view.claims.length > 0 ? 'Guide unavailable; claims and digest are available below.' : 'Guide unavailable; the digest is available below.'
    : hasGuide && !hasDigest
      ? view.claims.length > 0 ? 'Digest unavailable; guide and claims are available below.' : 'Digest unavailable; the guide is available below.'
      : view.claims.length === 0 && (hasGuide || hasDigest) ? 'No claims were retained; available source material is shown below.'
        : claimDetailsDropped ? 'Some claims could not be retained.' : 'This understanding needs review.';
  const requestStatus = awaitingStatus === null
    ? statusReady ? stateLabel(view.state) : 'Checking understanding status.'
    : busy ? 'Sending request.'
      : (awaitingStatus === 'accepted' ? 'Request accepted.' : 'Request outcome is unknown.')
        + (understanding.isFetching ? ' Reading status.' : ' Reload understanding to check its status.');
  const reloadSnapshot = () => { setCatalogError(''); setCatalogWarnings([]); setCatalogVersion((v) => v + 1); };
  return (
    <section className='er-und' aria-label='Understanding' aria-busy={busy || understanding.isFetching || !statusReady}>
      <h2 className='er-und__title'>Understanding</h2>
      <p className='er-und__hint' role='status'>{requestStatus}</p>
      {view.progress.model?.startsWith('workers-ai:') || recordedEffort === 'low' || recordedEffort === 'high'
        ? <p className='er-und__hint' role='status'>Requested native reasoning effort: {recordedEffort === 'low' ? 'Low' : recordedEffort === 'high' ? 'High' : 'Unknown (not recorded)'}.</p> : null}
      {view.authors || view.published ? <p className='er-und__meta'>{[view.authors, view.published].filter(Boolean).join(' · ')}</p> : null}
      {understandingError !== null && understandingError !== '' ? <p className='er-und__error' role='alert'>{understandingError}</p> : null}
      {failure !== '' ? <p className='er-und__error' role='alert'>{failure}</p> : null}
      {!historical && (canStart || canRetry || pendingRetry || awaitingStatus) ? <div className='er-field er-und__model-details'>
        {(canStart || canRetry) && !busy ? <>
          <ModelPicker label='Understanding model' choices={models} value={modelChoice} onChange={setModelChoice}
            emptyLabel={pickerEmptyLabel} loading={!catalogueLoaded} error={catalogError} compact
            onRoutePendingChange={setModelRoutePending} />
          <button className='er-button er-button--text' type='button' disabled={!catalogueLoaded} onClick={reloadSnapshot}>Reload model list</button>
          {catalogWarnings.length > 0 ? <p className='er-und__hint' role='status'>Model catalog: {catalogWarnings.join(' ')}</p> : null}
          {modelChoice === '' ? (!configuredUsable ? (<p className='er-und__error' role='alert'>The default model is currently unavailable, so Understand cannot start yet.</p>) : null) : chosen !== undefined && chosen.enabled && chosenUsable ? null : (<p className='er-und__error' role='alert'>{chosen === undefined || !chosen.enabled ? 'Selected model is unavailable' + (chosen?.unavailableReason ? ': ' + chosen.unavailableReason : '.') : 'The selected model is currently unavailable, so Understand cannot start yet.'}</p>)}
        </> : null}
        <label className='er-field'><span>Native reasoning effort</span>
          <select aria-label='Understanding reasoning effort' value={pendingRetry ? pendingRetry.nativeReasoningEffort ?? '' : nativeEffortChoice}
            disabled={requestOptionsLocked || !catalogueLoaded || catalogError !== '' || modelRoutePending || !nativeEffortSupported || effortModel?.enabled !== true}
            onChange={event => { const value = event.currentTarget.value; if (!requestOptionsLocked && nativeEffortSupported && (value === '' || value === 'low' || value === 'high')) setNativeEffortChoice(value); }}>
            <option value=''>Model default</option>
            {effortOptions.map(effort => <option key={effort} value={effort}>{effort === 'low' ? 'Low' : 'High'}</option>)}
          </select>
        </label>
        {nativeEffortSupported && !pendingRetry ? <p className='er-und__hint'>Low and High request native reasoning levels. Model default keeps the model's existing profile.</p> : null}
      </div> : null}
      {canStart || canRetry || canConfirm || failure !== '' || note !== '' || awaitingStatus || canSaveAvailable ? <div className='er-und__actions'>
        {canStart ? <button className='er-button er-button--tonal' type='button' disabled={understandDisabled} onClick={() => void request()}>Understand source</button> : null}
        {canRetry ? <button className='er-button er-button--tonal' type='button' disabled={understandDisabled} onClick={() => void request(false, true)}>{view.state === 'done' ? 'Run understanding again' : 'Retry understanding'}</button> : null}
        {canConfirm ? <button className='er-button er-button--tonal' type='button' disabled={busy || understanding.isFetching} onClick={() => void request(false, true)}>Send same request</button> : null}
        {failure !== '' || note !== '' || awaitingStatus || pendingRetry ? <button className='er-button er-button--text' type='button' disabled={busy || understanding.isFetching} onClick={() => void reload()}>Reload understanding</button> : null}
        {canSaveAvailable ? <button className='er-button er-button--tonal' type='button' disabled={busy || understanding.isFetching} onClick={() => void request(true)}>{view.state === 'failed' ? 'Save available output' : 'Recheck saved output'}</button> : null}
      </div> : null}
      {note !== '' ? <p className='er-und__error' role='alert'>{note}</p> : null}
      {canRetry ? <p className='er-und__hint'>{view.state === 'done' ? 'Starts a new model run on this same source text and uses provider allowance. The current output is archived in previous attempts.' : 'Starts a new model run on this same source text and uses provider allowance. Previous output stays in history.'}</p> : null}
      {pendingRetry ? <p className='er-und__hint'>The last request has not been confirmed. Reload checks its status. Send same request may start that run if it was never accepted.</p> : null}
      <div className='er-und__actions'>
        <button className='er-button er-button--text' type='button' disabled={busy || understanding.isFetching} onClick={toggleHistory}>Previous attempts</button>
        {historical ? <button className='er-button er-button--text' type='button' disabled={busy || understanding.isFetching} onClick={() => setHistoryAttempt('')}>Current attempt</button> : null}
      </div>
      {historical ? <p className='er-und__hint'>Viewing a previous attempt. Its saved failure, usage and output are preserved.</p> : null}
      {showHistory ? <div className='er-und__guide'>
        {history.error ? <p role='alert'>{history.error.message}</p> : null}
        {history.data?.pages.flatMap(page => page.attempts).map((attempt, index) => <button className='er-button er-button--text' type='button' key={attempt.attemptId} disabled={busy || understanding.isFetching} onClick={() => setHistoryAttempt(attempt.attemptId)}>View previous attempt {index + 1} · Archived {new Date(attempt.archivedAt).toLocaleString()}</button>)}
        {history.data?.pages[0]?.attempts.length === 0 ? <p>No previous attempts.</p> : null}
        {history.hasNextPage ? <button className='er-button er-button--text' type='button' disabled={history.isFetching} onClick={() => void history.fetchNextPage()}>Load more attempts</button> : null}
      </div> : null}
      {(historical || view.state === 'done' || view.state === 'partial') ? (<>
        {view.state === 'partial' ? <p className='er-und__hint'>{partialNotice}</p> : view.report && (view.report.dropped.length > 0 || view.report.clearedNumbers > 0) ? <p className='er-und__hint'>Some claims or numeric details could not be retained.</p> : null}
        {view.guide !== null && view.guide !== '' ? (<div className='er-und__guide'><h3>Guide</h3><div className='er-und__answer'><Markdown text={view.guide} references={references} /></div></div>) : null}
        <Questions questions={view.report?.questions ?? []} onUse={historical ? undefined : onUseQuestion} />
        {view.digest !== null && view.digest !== '' ? (<div className='er-und__guide'><h3>Digest</h3><div className='er-und__answer'><Markdown text={view.digest} references={references} /></div></div>) : null}
        {view.glossary.length > 0 ? (<div className='er-und__guide'><h3>Glossary</h3><dl className='er-card er-und__glossary'>{view.glossary.map((g, i) => (<div key={g.en + ':' + g.ru + ':' + i}><dt>{g.en} — {g.ru}</dt><dd><Markdown text={g.definition + '\n\n' + g.labels.join(' ')} references={references} /></dd></div>))}</dl></div>) : null}
        <div className='er-und__guide'><h3>Claims and source excerpts</h3>{view.claims.length === 0 ? <p className='er-und__hint'>No claims stored for this revision.</p> : (<ul className='er-und__claims'>{view.claims.map((c) => (
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
