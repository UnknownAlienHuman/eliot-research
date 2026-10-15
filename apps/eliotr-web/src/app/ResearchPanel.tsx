import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { WorkspaceLink } from '../routes/WorkspaceLink';
import { Button, MaterialSymbol, OperationAnnouncement, ResearchRunFeature, Status, researchEngineLabel } from '@eliotr/ui';
import type { ResearchRunLaunchView, VersionedRef } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import type { NextQuestionSource } from './NextQuestionScope';
import { matchesResearchRunLaunch, researchQueryOptions } from '../query/research';
import { protectedQueryKey, runProtectedRead } from '../query/client';
import { ReportPanel } from './ReportPanel';
import { usePaneAnnouncement } from './usePaneAnnouncement';

interface ResearchIntent {
  readonly body: string; readonly key: string; readonly question: string;
  readonly scope: readonly { readonly id: string; readonly label: string }[];
  readonly phase: 'pending' | 'unknown' | 'admitted';
  readonly launch?: ResearchRunLaunchView;
}
interface ResearchMemory {
  readonly intent?: ResearchIntent;
  readonly observedLaunch?: ResearchRunLaunchView;
  readonly artifact?: VersionedRef;
}
const copy = {
  en: { statusUnavailable: 'The research status could not be read.', working: 'Researching your question.', runRead: 'Status updated.', runFailed: 'The research ended with an error.', runComplete: 'The engine finished. Review its result.', cancelled: 'Research cancelled.', historyLoaded: 'Recent research loaded.', scope: 'Choose sources', scopeStale: 'Review your selected sources again before asking a new question.', scopeEmpty: 'Choose the sources for your next question first.', noProject: 'Open a project to choose its sources.', projects: 'Open projects', blocked: 'Research settings need a check before you ask.', check: 'Check research readiness', connections: 'Review connections', history: 'Recent research', readHistory: 'Refresh recent research', openRun: 'Read this run', report: 'Open saved report', unknown: 'The launch outcome is unknown. The original question and request identity are preserved.', recover: 'Reconcile this question', same: 'If the research started, it opens; if not, the same request is sent again without a duplicate.', next: 'Ask another question', input: 'The question could not be prepared. Review its text and source selection.', unavailable: 'Recent research could not be read. Refresh it.', noRuns: 'Your questions and saved reports will appear here.', incomplete: 'No draft report yet.' },
  ru: { statusUnavailable: 'Не удалось узнать статус исследования.', working: 'Исследую ваш вопрос.', runRead: 'Статус обновлён.', runFailed: 'Исследование завершилось с ошибкой.', runComplete: 'Исследование завершено. Посмотрите результат.', cancelled: 'Исследование отменено.', historyLoaded: 'Последние исследования прочитаны.', scope: 'Выбрать источники', scopeStale: 'Перед новым вопросом проверьте выбранные источники ещё раз.', scopeEmpty: 'Сначала выберите источники для следующего вопроса.', noProject: 'Откройте проект, чтобы выбрать его источники.', projects: 'Открыть проекты', blocked: 'Перед вопросом нужно проверить настройки исследования.', check: 'Проверить готовность исследования', connections: 'Проверить подключения', history: 'Последние исследования', readHistory: 'Обновить список', openRun: 'Открыть исследование', report: 'Открыть отчёт', unknown: 'Не удалось подтвердить запуск исследования. Вопрос сохранён.', recover: 'Проверить этот вопрос', same: 'Если исследование началось, оно откроется; если нет — тот же запрос уйдёт ещё раз, без дубликата.', next: 'Задать другой вопрос', input: 'Не удалось подготовить вопрос. Проверьте текст и выбранные источники.', unavailable: 'Не удалось загрузить последние исследования. Обновите список.', noRuns: 'Здесь появятся ваши вопросы и сохранённые отчёты.', incomplete: 'Черновика отчёта пока нет.' },
} as const;

/** One explicit intent owns admission. Polling, navigation and history never allocate a run. */
export function ResearchPanel({ apis, privacy, context, locale, scope, scopeCurrent, isScopeCurrent, projectId, isProjectCurrent, cover, wholeScope }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly locale: 'en' | 'ru'; readonly scope: readonly NextQuestionSource[]; readonly scopeCurrent: boolean;
  readonly isScopeCurrent: () => boolean;
  readonly projectId: string | undefined; readonly isProjectCurrent: () => boolean;
  /** Names the whole-project scope used when no source is ticked ("All 3 sources"). */
  readonly wholeScope?: string | undefined;
  /** Presentation only: the open project's title and source count for the start cover. */
  readonly cover?: { readonly title: string; readonly meta?: string } | undefined;
}) {
  const client = useQueryClient(), text = copy[locale];
  const memoryKey = [...protectedQueryKey(context, 'research'), 'local-intent'];
  const memory = useQuery<ResearchMemory>({ queryKey: memoryKey, queryFn: skipToken, gcTime: Infinity });
  const options = researchQueryOptions({ ...apis.research, configuration: apis.connections.configuration }, privacy, context,
    projectId === undefined ? undefined : { id: projectId, isCurrent: isProjectCurrent },
    import.meta.env.VITE_ELIOTR_RECENT_DIAGNOSTIC === 'true' ? {
      onRecentHistoryRead: event => {
        if (event.outcome !== 'resolved') console.warn('[eliotr-recent-read]', JSON.stringify(event));
      },
    } : undefined);
  const configuration = useQuery(options.configuration());
  const history = useQuery(options.history());
  const saved = memory.data, launch = saved?.intent?.launch ?? saved?.observedLaunch;
  const historyHeading = useRef<HTMLHeadingElement>(null), returningFromReport = useRef(false);
  const composer = useRef<HTMLDivElement>(null), returningToComposer = useRef(false);
  useLayoutEffect(() => {
    if (!saved?.artifact && returningFromReport.current) {
      returningFromReport.current = false;
      historyHeading.current?.focus();
    }
  }, [saved?.artifact]);
  useLayoutEffect(() => {
    if (returningToComposer.current && !saved?.intent && !saved?.observedLaunch && privacy.isCurrent(context)) {
      returningToComposer.current = false;
      composer.current?.querySelector('textarea')?.focus();
    }
  }, [saved?.intent, saved?.observedLaunch, privacy, context]);
  const displayTime = (iso: string) => {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : iso;
  };
  const status = useQuery(launch ? { ...options.status(launch),
    refetchInterval: query => query.state.data?.execution_state === 'ACTIVE' &&
      ['queued', 'running', 'waiting'].includes(query.state.data.engine_status) ? 5000 : false,
    refetchIntervalInBackground: false,
  } : { queryKey: [...protectedQueryKey(context, 'research'), 'status-unselected'], queryFn: skipToken });
  const [busy, setBusy] = useState(false), [inputError, setInputError] = useState(false);
  const [heldDraft, setHeldDraft] = useState<{ readonly context: SessionContext; readonly text: string } | undefined>(undefined);
  const nextQuestionDraft = heldDraft !== undefined && heldDraft.context === context && privacy.isCurrent(context)
    ? heldDraft.text : '';
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const read = () => client.getQueryData<ResearchMemory>(memoryKey) ?? {};
  const write = (update: (old: ResearchMemory) => ResearchMemory) => {
    if (privacy.isCurrent(context)) client.setQueryData<ResearchMemory>(memoryKey, old => update(old ?? {}));
  };
  useEffect(() => {
    mounted.current = true;
    const clearStaleDraft = () => {
      if (!privacy.isCurrent(context)) setHeldDraft(undefined);
    };
    const unsubscribe = privacy.subscribe(clearStaleDraft);
    clearStaleDraft();
    return () => {
      unsubscribe();
      mounted.current = false; controller.current?.abort();
      if (running.current && privacy.isCurrent(context)) client.setQueryData<ResearchMemory>(memoryKey, old =>
        old?.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    };
  }, [client, context, privacy]);
  const run = (action: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || !privacy.isCurrent(context)) return;
    running.current = true; controller.current = new AbortController(); setBusy(true);
    const signal = controller.current.signal;
    void action(signal).catch(() => {
      write(old => old.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    }).finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  };
  const admit = async (intent: ResearchIntent, signal: AbortSignal) => {
    const result = await runProtectedRead(privacy, context, signal, readSignal =>
      apis.research.runs.startResearchRun(intent.body, intent.key, context.deploymentGeneration, readSignal));
    write(old => old.intent?.key === intent.key ? { ...old, intent: { ...intent, phase: 'admitted', launch: result } } : old);
  };
  const ask = (question: string) => {
    // No ticked source asks the whole open project (a PROJECT scope); a selection must still be current.
    const wholeProject = scope.length === 0;
    if (read().intent || read().observedLaunch || running.current || projectId === undefined || !isProjectCurrent() ||
      (!wholeProject && (!scopeCurrent || !isScopeCurrent())) || !privacy.isCurrent(context) ||
      configuration.isError || configuration.isFetching || !configuration.data ||
      client.getQueryData(options.configuration().queryKey) !== configuration.data || configuration.data.run_readiness === 'blocked') return;
    try {
      const body = apis.research.runs.researchRunBody(question, scope.map(source => source.id), undefined, projectId);
      const intent: ResearchIntent = Object.freeze({ body, key: apis.sources.mintIntent(), question,
        scope: Object.freeze(scope.map(source => Object.freeze({ id: source.id, label: source.label }))), phase: 'pending' });
      write(old => ({ ...old, intent }));
      if (read().intent?.key !== intent.key) return;
      setInputError(false); setHeldDraft(undefined);
      run(signal => admit(intent, signal));
    } catch { setInputError(true); }
  };
  const reconcile = () => {
    const intent = read().intent; if (!intent || intent.phase === 'pending') return;
    run(async signal => {
      // History has no request identity and is independent of same-key reconciliation.
      if (signal.aborted || !privacy.isCurrent(context)) return;
      if (intent.launch) {
        await client.fetchQuery(options.status(intent.launch));
        write(old => old.intent?.key === intent.key ? { ...old, intent: { ...intent, phase: 'admitted' } } : old);
      } else await admit(intent, signal);
    });
  };
  const progress = status.isError ? undefined : status.data;
  const terminal = saved?.intent?.launch && progress?.workflow_instance_id === saved.intent.launch.workflow_instance_id &&
    progress.execution_state !== 'ACTIVE' && !status.isError && !status.isFetching;
  const observed = saved?.intent ? undefined : saved?.observedLaunch;
  const historyTerminal = observed && status.isSuccess && !status.isFetching &&
    progress !== undefined && matchesResearchRunLaunch(progress, observed) &&
    (progress.execution_state === 'ENGINE_COMPLETED' || progress.execution_state === 'CANCELLED');
  const dismissHistory = () => {
    if (!observed || !historyTerminal || running.current || !privacy.isCurrent(context)) return;
    const currentStatus = client.getQueryState(options.status(observed).queryKey);
    if (currentStatus?.status !== 'success' || currentStatus.fetchStatus !== 'idle' || currentStatus.data !== progress) return;
    write(old => {
      // A history view owns only its selection, never a pending or uncertain mutation intent.
      if (old.intent || old.observedLaunch !== observed) return old;
      returningToComposer.current = true;
      const { observedLaunch: _launch, ...rest } = old; return rest;
    });
  };
  const state = saved?.intent?.phase === 'unknown' || status.isError ? 'degraded'
    : progress?.execution_state === 'CANCELLED' ? 'cancelled'
    : progress?.failure ? 'error' : progress?.execution_state === 'ENGINE_COMPLETED' ? 'useful'
    : launch || busy ? 'loading' : 'empty';
  const announcement = usePaneAnnouncement(busy ? text.working
    : inputError ? text.input
    : saved?.intent?.phase === 'unknown' ? text.unknown
    : status.isError ? text.statusUnavailable
    : progress?.failure ? text.runFailed
    : progress?.execution_state === 'CANCELLED' ? text.cancelled
    : progress?.execution_state === 'ENGINE_COMPLETED' ? text.runComplete
    : progress ? text.runRead : history.isError ? text.unavailable : history.data ? text.historyLoaded : '');
  if (saved?.artifact) return <ReportPanel key={`${saved.artifact.id}:${saved.artifact.revision}`} locale={locale} apis={apis} privacy={privacy} context={context} artifactRef={saved.artifact}
    onOpenDraft={artifact => write(old => ({ ...old, artifact }))}
    onClose={() => { if (privacy.isCurrent(context)) { returningFromReport.current = true; write(old => { const { artifact: _artifact, ...rest } = old; return rest; }); } }} />;
  return <>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
    {/* An empty selection needs no notice: the Sources pane's checkboxes and the composer's source
        count already say it. A missing project or a stale selection still does. */}
    {!scopeCurrent && !saved?.intent && (projectId === undefined || scope.length > 0) && <p className="er-live-callout"><MaterialSymbol name="folder" /><span>{projectId === undefined ? text.noProject : text.scopeStale}</span> {projectId === undefined
      ? <WorkspaceLink className="er-shell-link" to="/projects">{text.projects}</WorkspaceLink>
      : <WorkspaceLink className="er-shell-link" to="/sources">{text.scope}</WorkspaceLink>}</p>}
    {configuration.isError || configuration.data?.run_readiness === 'blocked' ? <div className="er-live-callout">
      <Status>{text.blocked}</Status><div className="er-live-actions"><Button variant="tonal" disabled={configuration.isFetching} onClick={() => { void configuration.refetch(); }}>{text.check}</Button><WorkspaceLink className="er-shell-link" to="/connections">{text.connections}</WorkspaceLink></div>
    </div> : null}
    {inputError && <Status tone="error">{text.input}</Status>}
    <div ref={composer} className="er-live-research"><ResearchRunFeature key={saved?.intent?.key ?? 'next-question'} locale={locale} state={state}
      {...(cover ? { cover } : {})}
      scope={saved?.intent?.scope ?? scope} busy={busy}
      questionHeld={saved?.intent !== undefined || saved?.observedLaunch !== undefined}
      draftQuestion={nextQuestionDraft} onDraftQuestionChange={value => {
        if (mounted.current && privacy.isCurrent(context)) setHeldDraft({ context, text: value });
      }}
      {...(projectId !== undefined && wholeScope !== undefined ? { wholeScope } : {})}
      canSubmit={!saved?.intent && !saved?.observedLaunch && projectId !== undefined && (scope.length === 0 || scopeCurrent) && !configuration.isError && !configuration.isFetching && configuration.data !== undefined && configuration.data.run_readiness !== 'blocked'}
      {...(saved?.intent ? { question: saved.intent.question } : {})}
      {...(progress ? { progress, ...(progress.failure ? { firstCause: progress.failure } : {}) } : {})}
      onAsk={ask} {...(launch ? { onReadStatus: () => { void status.refetch(); } } : {})}
      {...(saved?.intent?.phase === 'unknown' ? { onRecover: reconcile } : {})}
      answerActions={(terminal || historyTerminal || progress?.answer.availability === 'draft') ? <div className="er-live-actions">
        {progress?.answer.availability === 'draft' && <><Button variant="primary" onClick={() => { if (privacy.isCurrent(context) && progress.answer.availability === 'draft') { const artifact = progress.answer.artifact_ref; write(old => ({ ...old, artifact })); } }}>{text.report}</Button></>}
        {terminal && <Button variant="text" onClick={() => {
          if (privacy.isCurrent(context) && !running.current) write(old => {
            if (old.intent?.key !== saved?.intent?.key) return old;
            returningToComposer.current = true;
            const { intent: _intent, observedLaunch: _launch, ...rest } = old; return rest;
          });
        }}>{text.next}</Button>}
        {historyTerminal && <Button variant="text" onClick={dismissHistory}>{text.next}</Button>}
        </div> : undefined}
      conversation={<>
        {saved?.intent?.phase === 'unknown' && <div className="er-live-callout er-live-callout--attention"><Status>{text.unknown}</Status><p>{text.same}</p>
          <Button variant="tonal" disabled={busy} onClick={reconcile}>{text.recover}</Button></div>}
        <section className="er-live-history" aria-label={text.history}><div className="er-live-history-heading"><h2 ref={historyHeading} tabIndex={-1}>{text.history}</h2>
          <Button variant="text" disabled={history.isFetching} onClick={() => { void history.refetch(); }}>{text.readHistory}</Button></div>
          {history.isError ? <Status>{text.unavailable}</Status> : history.data?.runs.length === 0 && history.data.saved_drafts.length === 0 ? <p>{text.noRuns}</p> : null}
          <ul>{!history.isError && history.data?.runs.map(entry => <li key={entry.status.workflow_instance_id}>
            <time dateTime={entry.created_at}>{displayTime(entry.created_at)}</time>
            {entry.query !== undefined && <p className="er-live-history-question">{entry.query}</p>}
            <span className="er-live-history-state" data-status={entry.status.engine_status}>{researchEngineLabel(locale, entry.status.engine_status)}</span>
            <Button variant="text" disabled={saved?.intent !== undefined} onClick={() => {
              const observed = entry.status; write(old => ({ ...old, observedLaunch: { workflow_instance_id: observed.workflow_instance_id, investigation_ref: observed.investigation_ref, deployment_generation: observed.deployment_generation } }));
            }}>{text.openRun}</Button>
            {entry.status.answer.availability === 'draft' && <Button variant="tonal" onClick={() => {
              if (entry.status.answer.availability === 'draft') { const artifact = entry.status.answer.artifact_ref; write(old => ({ ...old, artifact })); }
            }}>{text.report}</Button>}
          </li>)}</ul>
          <ul>{!history.isError && history.data?.saved_drafts.map(draft => <li key={`${draft.artifact_ref.id}:${draft.artifact_ref.revision}`}>
            <time dateTime={draft.created_at}>{displayTime(draft.created_at)}</time><Button variant="tonal" onClick={() => write(old => ({ ...old, artifact: draft.artifact_ref }))}>{text.report}</Button>
          </li>)}</ul>
        </section>
      </>} /></div>
  </>;
}
