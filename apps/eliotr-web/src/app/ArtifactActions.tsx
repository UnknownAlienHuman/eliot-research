import { useEffect, useRef, useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Status } from '@eliotr/ui';
import type { ArtifactPublicationView, ArtifactRevision, ArtifactSectionRevisionView, VersionedRef } from '@eliotr/owner-api-client';
import type { BoundWorkspaceApis } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import { protectedQueryKey, runProtectedRead } from '../query/client';

const sameRef = (a: VersionedRef, b: VersionedRef) => a.id === b.id && a.revision === b.revision;
interface Intent {
  readonly kind: 'accept' | 'revise';
  readonly artifact_ref: VersionedRef;
  readonly expected_publication_revision: number | null;
  readonly section_id?: string;
  readonly phase: 'pending' | 'unknown';
}
interface Memory {
  readonly intent?: Intent;
  readonly artifact_ref?: VersionedRef;
  readonly publication?: ArtifactPublicationView | null;
  readonly revision?: ArtifactSectionRevisionView;
}
const copy = {
  en: { title: 'Review and acceptance', review: 'Read acceptance status', accept: 'Accept this report',
    confirm: 'Confirm owner acceptance', cancel: 'Cancel', revise: 'Revise this section',
    recover: 'Reconcile the original action', pending: 'The previous action is unresolved. Its original request is preserved.',
    elsewhere: 'An action on another report is unresolved. Return to that report to reconcile it.',
    accepted: 'Owner acceptance is confirmed for this revision.', none: 'No acceptance is recorded for this revision.',
    error: 'The action could not be confirmed. Read its status before continuing.',
    conflict: 'The publication head changed. The original acceptance request was preserved and was not sent again.',
    revised: 'A new section revision was saved. The previous revision is preserved.',
    cancelled: 'The section revision was cancelled.', details: 'Acceptance receipt',
    caution: 'Accepting records your decision for this exact revision. The server checks its evidence before accepting it.' },
  ru: { title: 'Проверка и принятие', review: 'Прочитать состояние принятия', accept: 'Принять этот отчёт',
    confirm: 'Подтвердить принятие владельцем', cancel: 'Отмена', revise: 'Пересмотреть этот раздел',
    recover: 'Сверить исходное действие', pending: 'Предыдущее действие не завершено. Исходный запрос сохранён.',
    elsewhere: 'Действие с другим отчётом не завершено. Вернитесь к нему для сверки.',
    accepted: 'Принятие владельцем подтверждено для этой версии.', none: 'Для этой версии принятие не записано.',
    error: 'Не удалось подтвердить действие. Прочитайте его состояние перед продолжением.',
    conflict: 'Текущая публикация изменилась. Исходный запрос принятия сохранён и не отправлен повторно.',
    revised: 'Новая версия раздела сохранена. Предыдущая версия сохранена.',
    cancelled: 'Пересмотр раздела отменён.', details: 'Квитанция принятия',
    caution: 'Принятие записывает ваше решение для этой версии. Сервер проверит её доказательства перед принятием.' },
} as const;

export interface ArtifactActionsProps {
  readonly apis: BoundWorkspaceApis;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly locale: 'en' | 'ru';
  readonly artifact: ArtifactRevision;
  readonly currentArtifact: () => ArtifactRevision | undefined;
  /** Exact declared section contract, never the section reference ID or title. */
  readonly sectionId?: string;
  readonly onOpenDraft: (ref: VersionedRef) => void;
}

/** Author-path only. One protected intent blocks new mutations across reports and routes. */
export function ArtifactActions(props: ArtifactActionsProps) {
  const client = useQueryClient(), text = copy[props.locale];
  const memoryKey = [...protectedQueryKey(props.context, 'artifact-actions'), 'local-intent'];
  const memory = useQuery<Memory>({ queryKey: memoryKey, queryFn: skipToken, gcTime: Infinity });
  const [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<'error' | 'conflict'>();
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const read = () => client.getQueryData<Memory>(memoryKey) ?? {};
  const write = (update: (old: Memory) => Memory) => {
    if (props.privacy.isCurrent(props.context)) client.setQueryData<Memory>(memoryKey, old => update(old ?? {}));
  };
  const heldResult = memory.data?.artifact_ref && sameRef(memory.data.artifact_ref, props.artifact.artifact_ref) ? memory.data : undefined;
  const intent = memory.data?.intent;
  const sameIntent = intent !== undefined && sameRef(intent.artifact_ref, props.artifact.artifact_ref);
  const accepted = heldResult?.publication?.revision.status === 'ACCEPTED';
  const live = () => props.privacy.isCurrent(props.context) ? props.currentArtifact() : undefined;
  const exact = (held: ArtifactRevision) => live() === held;
  const section = (held: ArtifactRevision) => props.sectionId !== undefined &&
    held.sections.some(row => row.contract_id === props.sectionId) ? props.sectionId : undefined;
  const generation = props.context.deploymentGeneration;
  const publication = (ref: VersionedRef, signal: AbortSignal, current = false) => runProtectedRead(
    props.privacy, props.context, signal, s => props.apis.studio.artifact.readArtifactPublication(ref, generation, s, current));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (props.privacy.isCurrent(props.context)) client.setQueryData<Memory>(memoryKey, old =>
        old?.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    };
  }, [client, props.context, props.privacy]);

  const run = (action: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || !props.privacy.isCurrent(props.context)) return;
    running.current = true;
    controller.current = new AbortController();
    setBusy(true); setNotice(undefined);
    void action(controller.current.signal).catch(() => {
      write(old => old.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
      if (mounted.current) setNotice('error');
    }).finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  };

  const execute = async (pending: Intent, held: ArtifactRevision, signal: AbortSignal) => {
    if (!exact(held) || !sameRef(held.artifact_ref, pending.artifact_ref) || signal.aborted) return;
    if (pending.kind === 'accept') {
      const result = await runProtectedRead(props.privacy, props.context, signal, s =>
        props.apis.studio.artifact.acceptArtifact(pending.artifact_ref, pending.expected_publication_revision, generation, s));
      write(() => ({ artifact_ref: pending.artifact_ref, publication: result }));
      return;
    }
    const sectionId = pending.section_id;
    if (sectionId === undefined || !held.sections.some(row => row.contract_id === sectionId)) return;
    const result = await runProtectedRead(props.privacy, props.context, signal, s =>
      props.apis.studio.artifact.reviseArtifactSection(pending.artifact_ref, sectionId, generation, s));
    const previous = read().revision;
    if (previous && (previous.operation_id !== result.operation_id || previous.attempt_ref !== result.attempt_ref)) throw Error('Revision identity changed');
    const terminal = result.state === 'COMMITTED' || result.state === 'CANCELLED';
    write(() => ({ artifact_ref: pending.artifact_ref, revision: result,
      ...(terminal ? {} : { intent: { ...pending, phase: 'unknown' as const } }) }));
    if (result.state === 'COMMITTED' && result.draft && exact(held)) props.onOpenDraft(result.draft.artifact_ref);
  };

  const start = (kind: Intent['kind']) => run(async signal => {
    const held = live();
    if (!held || held !== props.artifact || held.status !== 'DRAFT' || read().intent || accepted) return;
    const sectionId = kind === 'revise' ? section(held) : undefined;
    if (kind === 'revise' && sectionId === undefined) return;
    const head = kind === 'accept' ? await publication(held.artifact_ref, signal, true) : null;
    if (!exact(held) || signal.aborted || read().intent) return;
    const pending: Intent = { kind, artifact_ref: held.artifact_ref,
      expected_publication_revision: head?.receipt.publication_revision ?? null,
      ...(sectionId === undefined ? {} : { section_id: sectionId }), phase: 'pending' };
    write(() => ({ intent: pending })); setConfirming(false);
    await execute(pending, held, signal);
  });

  const recover = () => run(async signal => {
    const pending = read().intent, held = live();
    if (!pending || !held || !sameRef(held.artifact_ref, pending.artifact_ref)) return;
    if (pending.kind === 'accept') {
      const saved = await publication(pending.artifact_ref, signal);
      if (!exact(held) || signal.aborted) return;
      if (saved?.revision.status === 'ACCEPTED') {
        write(() => ({ artifact_ref: pending.artifact_ref, publication: saved })); return;
      }
      const head = await publication(pending.artifact_ref, signal, true);
      if (!exact(held) || signal.aborted) return;
      if ((head?.receipt.publication_revision ?? null) !== pending.expected_publication_revision) {
        setNotice('conflict'); return;
      }
    }
    // No read-only section status method exists on this client. Explicit recovery preserves its
    // deterministic request identity; nonterminal results keep the original intent.
    await execute(pending, held, signal);
  });
  const review = () => run(async signal => {
    const held = live();
    const pending = read().intent;
    if (!held || held !== props.artifact || (pending && !sameRef(pending.artifact_ref, held.artifact_ref))) return;
    const result = await publication(held.artifact_ref, signal);
    if (exact(held) && !signal.aborted) write(old => ({
      ...(old.artifact_ref && sameRef(old.artifact_ref, held.artifact_ref)
        ? old : old.intent ? { intent: old.intent } : {}),
      artifact_ref: held.artifact_ref,
      publication: result,
    }));
  });

  return <section aria-label={text.title} aria-busy={busy}>
    <h3>{text.title}</h3>
    <div className="er-live-actions">
      <Button variant="text" disabled={busy || (intent !== undefined && !sameIntent)} onClick={review}>{text.review}</Button>
      {props.artifact.status === 'DRAFT' && !accepted && !intent && (confirming ? <>
        <Button variant="primary" disabled={busy} onClick={() => start('accept')}>{text.confirm}</Button>
        <Button variant="text" disabled={busy} onClick={() => setConfirming(false)}>{text.cancel}</Button>
      </> : <Button variant="tonal" disabled={busy} onClick={() => setConfirming(true)}>{text.accept}</Button>)}
      {props.artifact.status === 'DRAFT' && section(props.artifact) !== undefined && !accepted && !intent &&
        <Button variant="tonal" disabled={busy} onClick={() => start('revise')}>{text.revise}</Button>}
    </div>
    {confirming && <p>{text.caution}</p>}
    {accepted && <Status>{text.accepted}</Status>}
    {heldResult?.publication === null && <p>{text.none}</p>}
    {heldResult?.revision?.state === 'COMMITTED' && <Status>{text.revised}</Status>}
    {heldResult?.revision?.state === 'CANCELLED' && <Status>{text.cancelled}</Status>}
    {intent && <Status>{sameIntent ? text.pending : text.elsewhere}</Status>}
    {sameIntent && <Button variant="tonal" disabled={busy} onClick={recover}>{text.recover}</Button>}
    {notice && <Status tone="error">{text[notice]}</Status>}
    {heldResult?.publication && <details><summary>{text.details}</summary>
      <p>{heldResult.publication.receipt.publication_ref}</p>
      <p>{heldResult.publication.receipt.artifact_ref.id}:{heldResult.publication.receipt.artifact_ref.revision}</p>
    </details>}
  </section>;
}
