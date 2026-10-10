import { useEffect, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, OperationAnnouncement, Status, StudioFeature, STUDIO_COPY } from '@eliotr/ui';
import type { VersionedRef, WikiProposalReadView, WikiProposalFromRunView, WikiPublicationView } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from './runtime';
import { isWorkspaceRequestError } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import { protectedQueryKey, runProtectedRead } from '../query/client';
import { studioQueryOptions } from '../query/studio';
import { researchQueryOptions } from '../query/research';
import { ReportPanel } from './ReportPanel';
import { usePaneAnnouncement } from './usePaneAnnouncement';

type StudioIntent = ({ readonly kind: 'edit'; readonly base: WikiProposalReadView; readonly title: string; readonly body: string; readonly note: string }
  | { readonly kind: 'publish'; readonly base: WikiProposalReadView; readonly expectedHead: number })
  & { readonly key: string; readonly phase: 'pending' | 'unknown' | 'input-error' };
interface StudioMemory {
  readonly selected?: VersionedRef; readonly artifact?: VersionedRef; readonly intent?: StudioIntent;
  readonly edited?: WikiProposalFromRunView; readonly published?: WikiPublicationView;
}
const sameRef = (left: VersionedRef, right: VersionedRef) => left.id === right.id && left.revision === right.revision;
const copy = {
  en: { working: 'Checking the current action.', reading: 'Reading saved work.', loaded: 'Saved work loaded.', drafts: 'Wiki drafts', read: 'Refresh saved work', previous: 'Previous page', next: 'More drafts', recent: 'Saved reports', report: 'Open saved report', unknown: 'The last action has no confirmed outcome. Its original draft, content and request identity are preserved.', recover: 'Check the same action', inputs: 'The edit could not be prepared. Review its title and text.', review: 'Review the edit again', published: 'Publication confirmed for this Wiki page.', edited: 'A new draft revision was returned. The previous page was preserved.', failed: 'The selected draft could not be read. No saved text is shown.', reread: 'Read the selected draft again' },
  ru: { working: 'Проверяется текущее действие.', reading: 'Читаются сохранённые материалы.', loaded: 'Сохранённые материалы прочитаны.', drafts: 'Черновики Wiki', read: 'Обновить сохранённые материалы', previous: 'Предыдущая страница', next: 'Другие черновики', recent: 'Сохранённые отчёты', report: 'Открыть сохранённый отчёт', unknown: 'Исход последнего действия не подтверждён. Исходный черновик, текст и идентификатор запроса сохранены.', recover: 'Проверить то же действие', inputs: 'Не удалось подготовить правку. Проверьте заголовок и текст.', review: 'Проверить правку ещё раз', published: 'Публикация этой страницы Wiki подтверждена.', edited: 'Получена новая версия черновика. Предыдущая страница сохранена.', failed: 'Не удалось прочитать выбранный черновик. Сохранённый текст не показывается.', reread: 'Прочитать выбранный черновик снова' },
} as const;

/** Read, copy-on-write edit and publication use only the accepted owner client. */
export function StudioPanel({ apis, privacy, context, locale }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext; readonly locale: 'en' | 'ru';
}) {
  const client = useQueryClient(), text = copy[locale];
  const memoryKey = [...protectedQueryKey(context, 'studio'), 'local-intent'];
  const memory = useQuery<StudioMemory>({ queryKey: memoryKey, queryFn: skipToken, gcTime: Infinity });
  let proposalKey: (string | number)[] = [];
  const options = studioQueryOptions(apis.studio, privacy, context, () => client.getQueryData<WikiProposalReadView>(proposalKey));
  const proposals = useQuery(options.proposals());
  const selectedOptions = memory.data?.selected ? options.proposal(memory.data.selected) : undefined;
  proposalKey = selectedOptions?.queryKey ?? [...protectedQueryKey(context, 'studio'), 'proposal-unselected'];
  const selected = useQuery(selectedOptions ?? { queryKey: proposalKey, queryFn: skipToken });
  const view = selected.isError ? undefined : selected.data;
  const body = useQuery(view ? options.body(view) : { queryKey: [...protectedQueryKey(context, 'studio'), 'body-unselected'], queryFn: skipToken });
  const research = researchQueryOptions({ ...apis.research, configuration: apis.connections.configuration }, privacy, context);
  const history = useQuery(research.history());
  const [busy, setBusy] = useState(false);
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const read = () => client.getQueryData<StudioMemory>(memoryKey) ?? {};
  const write = (update: (old: StudioMemory) => StudioMemory) => {
    if (privacy.isCurrent(context)) client.setQueryData<StudioMemory>(memoryKey, old => update(old ?? {}));
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; controller.current?.abort();
      if (running.current && privacy.isCurrent(context)) client.setQueryData<StudioMemory>(memoryKey, old =>
        old?.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    };
  }, [client, context, privacy]);
  const run = (action: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || !privacy.isCurrent(context)) return;
    running.current = true; controller.current = new AbortController(); setBusy(true);
    const signal = controller.current.signal;
    void action(signal).catch(error => write(old => old.intent ? { ...old, intent: { ...old.intent,
      phase: isWorkspaceRequestError(error) && error.status === 400 && error.code === 'WIKI_INPUT_INVALID' ? 'input-error' : 'unknown',
    } } : old)).finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  };
  const execute = async (intent: StudioIntent, signal: AbortSignal) => {
    if (intent.kind === 'edit') {
      const result = await runProtectedRead(privacy, context, signal, readSignal => apis.studio.create.createWikiEditProposal(
        intent.base.proposal_ref, intent.base.page.page_ref, intent.base.page.page_ref.revision, intent.title,
        intent.body, intent.note, context.deploymentGeneration, intent.key, readSignal));
      write(old => { const { intent: _intent, ...rest } = old; return { ...rest, selected: result.proposal_ref, edited: result }; });
    } else {
      const result = await runProtectedRead(privacy, context, signal, readSignal => apis.studio.publish.publishWikiProposal(
        intent.base.proposal_ref, intent.base.page.page_ref, intent.expectedHead, intent.key, context.deploymentGeneration, readSignal));
      write(old => { const { intent: _intent, ...rest } = old; return { ...rest, published: result }; });
      await client.fetchQuery(options.proposal(intent.base.proposal_ref));
    }
    void proposals.refetch();
  };
  const currentView = () => privacy.isCurrent(context) && view && !selected.isError && !selected.isFetching &&
    client.getQueryData(proposalKey) === view ? view : undefined;
  let expectedPublishHead: number | undefined;
  if (view?.state === 'PROPOSED' && view.page.status === 'DRAFT') {
    try { expectedPublishHead = apis.studio.publish.expectedWikiHeadRevision(view.page); } catch { expectedPublishHead = undefined; }
  }
  const reconcile = () => {
    const intent = read().intent; if (!intent || intent.phase === 'pending') return;
    run(async signal => {
      if (intent.kind === 'publish') {
        const fresh = await client.fetchQuery(options.proposal(intent.base.proposal_ref));
        if (signal.aborted || !privacy.isCurrent(context) || !sameRef(fresh.page.page_ref, intent.base.page.page_ref)) return;
        if (fresh.state === 'PUBLISHED') {
          write(old => { const { intent: _intent, ...rest } = old; return rest; }); return;
        }
      } else {
        await client.fetchQuery(options.proposals());
        if (signal.aborted || !privacy.isCurrent(context)) return;
      }
      // No new base, body, compare-and-swap target or request key is chosen during recovery.
      await execute(intent, signal);
    });
  };
  const saved = memory.data, blocked = busy || saved?.intent !== undefined;
  const featureCopy = { ...STUDIO_COPY[locale], title: text.drafts };
  const currentProposals = proposals.data && !proposals.isError ? { ...proposals.data,
    items: proposals.data.items.map(proposal => view && sameRef(proposal.proposal_ref, view.proposal_ref)
      ? { ...proposal, state: view.state } : proposal),
  } : undefined;
  const announcement = usePaneAnnouncement(busy ? text.working
    : saved?.intent?.phase === 'unknown' ? text.unknown
    : saved?.intent?.phase === 'input-error' ? text.inputs
    : selected.isError || body.isError ? text.failed
    : proposals.isError ? featureCopy.error
    : selected.isFetching || body.isFetching || proposals.isFetching ? text.reading
    : view?.state === 'PUBLISHED' ? text.published
    : view && saved?.edited && sameRef(view.proposal_ref, saved.edited.proposal_ref) ? text.edited : proposals.data ? text.loaded : '');
  if (saved?.artifact) return <ReportPanel key={`${saved.artifact.id}:${saved.artifact.revision}`} locale={locale} apis={apis} privacy={privacy} context={context} artifactRef={saved.artifact}
    onOpenDraft={artifact => write(old => ({ ...old, artifact }))}
    onClose={() => write(old => { const { artifact: _artifact, ...rest } = old; return rest; })} />;
  return <>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
    <div className="er-live-actions"><Button variant="tonal" disabled={proposals.isFetching || busy} onClick={() => { void proposals.refetch(); void history.refetch(); }}>{text.read}</Button></div>
    {saved?.intent?.phase === 'unknown' && <div><Status>{text.unknown}</Status><Button variant="tonal" disabled={busy} onClick={reconcile}>{text.recover}</Button></div>}
    {saved?.intent?.phase === 'input-error' && <div><Status tone="error">{text.inputs}</Status><Button variant="text" onClick={() => write(old => { const { intent: _intent, ...rest } = old; return rest; })}>{text.review}</Button></div>}
    {view?.state === 'PUBLISHED' && <Status>{text.published}</Status>}
    {view && view.state !== 'PUBLISHED' && saved?.edited && sameRef(view.proposal_ref, saved.edited.proposal_ref) && <Status>{text.edited}</Status>}
    {selected.isError || body.isError ? <div><Status tone="error">{text.failed}</Status><Button variant="tonal" disabled={selected.isFetching || body.isFetching} onClick={() => { void selected.refetch(); if (view) void body.refetch(); }}>{text.reread}</Button></div> : null}
    <fieldset className="er-live-plain-fieldset" disabled={blocked} aria-label={text.drafts}>
      <StudioFeature key={view ? `${view.proposal_ref.id}:${view.proposal_ref.revision}` : 'list'} locale={locale} copy={featureCopy}
        state={proposals.isPending ? 'loading' : proposals.isError ? 'error' : !proposals.data?.items.length ? 'empty' : 'useful'}
        {...(currentProposals ? { proposals: currentProposals } : {})}
        {...(view ? { selected: view } : {})}
        {...(body.data && !body.isError && !selected.isError ? { body: body.data } : {})}
        {...(expectedPublishHead !== undefined && !body.isError && body.data ? { expectedPublishHead } : {})}
        cowVerified={expectedPublishHead !== undefined && body.data !== undefined && !body.isError && view !== undefined && body.data.body_sha256 === view.page.body_sha256}
        onOpenProposal={summary => {
          if (privacy.isCurrent(context) && client.getQueryData(options.proposals().queryKey) === proposals.data &&
            proposals.data?.items.some(row => sameRef(row.proposal_ref, summary.proposal_ref))) write(old => ({ ...old, selected: summary.proposal_ref }));
        }}
        onCreateEdit={input => {
          const base = currentView();
          if (!base || read().intent || running.current || !body.data || body.isError ||
            !sameRef(input.baseProposalRef, base.proposal_ref) || !sameRef(input.basePageRef, base.page.page_ref) ||
            input.expectedHeadRevision !== base.page.page_ref.revision || !input.title.trim() || !input.bodyText.trim()) return;
          const intent: StudioIntent = Object.freeze({ kind: 'edit', base, title: input.title, body: input.bodyText,
            note: input.editNote, key: apis.sources.mintIntent(), phase: 'pending' });
          write(old => ({ ...old, intent })); run(signal => execute(intent, signal));
        }}
        onPublish={input => {
          const base = currentView();
          if (!base || read().intent || running.current || expectedPublishHead === undefined || !body.data || body.isError ||
            !sameRef(input.proposalRef, base.proposal_ref) || !sameRef(input.pageRef, base.page.page_ref) ||
            input.expectedHeadRevision !== expectedPublishHead) return;
          const intent: StudioIntent = Object.freeze({ kind: 'publish', base, expectedHead: expectedPublishHead,
            key: apis.sources.mintIntent(), phase: 'pending' });
          write(old => ({ ...old, intent })); run(signal => execute(intent, signal));
        }}
        onBack={() => write(old => { const { selected: _selected, ...rest } = old; return rest; })} />
    </fieldset>
    {!history.isError && history.data && history.data.saved_drafts.length > 0 && <section className="er-live-history" aria-label={text.recent}><h2>{text.recent}</h2><ul>{history.data.saved_drafts.map(draft => <li key={`${draft.artifact_ref.id}:${draft.artifact_ref.revision}`}>
      <span>{draft.created_at}</span><Button variant="tonal" onClick={() => write(old => ({ ...old, artifact: draft.artifact_ref }))}>{text.report}</Button>
    </li>)}</ul></section>}
  </>;
}
