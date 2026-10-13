import { useEffect, useRef, useState } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, ERASURE_COPY, ErasureFeature, Status } from "@eliotr/ui";
import type { ErasurePrepareView, ErasureStatusView, LibraryPage } from "@eliotr/owner-api-client";
import { classifyMutationOutcome } from "@eliotr/owner-api-client";
import { useCanonicalCommitReport } from "./canonicalCommit";
import type { BoundWorkspaceApis } from "./runtime";
import { isWorkspaceRequestError } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { protectedQueryKey } from "../query/client";
import { OperationFeedback } from "./OperationFeedback";
import { erasureActions, isErasureComplete } from "../query/erasure";

const copy = {
  en: { preparing: "Reading the deletion review.", confirming: "Checking the original deletion request.", readingStatus: "Reading saved deletion status.", ready: "Deletion review loaded. Confirm only after reviewing it.", unknown: "The deletion request is unresolved. Read its saved status.", blocked: "Deletion is blocked. Review the affected locations.", manage: "Manage selected source", requests: "Deletion requests in this session", open: "Review deletion", resume: "Check deletion request", close: "Back to sources", failed: "The deletion review could not be read. Try again with the same request.", retry: "Read review again", completed: "Deletion confirmed by the saved server receipt.", refresh: "Refresh status" },
  ru: { preparing: "Читаем сведения об удалении.", confirming: "Проверяем исходный запрос удаления.", readingStatus: "Читаем сохранённый статус удаления.", ready: "Сведения об удалении прочитаны. Подтвердите после проверки.", unknown: "Исход запроса удаления не определён. Прочитайте сохранённый статус.", blocked: "Удаление заблокировано. Проверьте затронутые расположения.", manage: "Управление выбранным источником", requests: "Запросы удаления в этом сеансе", open: "Проверить удаление", resume: "Проверить запрос удаления", close: "Вернуться к источникам", failed: "Не удалось прочитать сведения об удалении. Повторите чтение того же запроса.", retry: "Прочитать сведения снова", completed: "Удаление подтверждено сохранённой квитанцией сервера.", refresh: "Обновить статус" },
} as const;

interface Props {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly locale: "en" | "ru"; readonly selectedSourceId?: string | undefined;
  readonly page?: LibraryPage | undefined; readonly currentLibrary: () => LibraryPage | undefined;
  /** Invoked only on a canonically verified COMPLETE, at most once per exact erasure tuple. */
  readonly onErasureComplete?: (sourceId: string, status: ErasureStatusView) => void;
}
interface LocalIntent { readonly key: string; readonly submitted: boolean; readonly rejected?: boolean }

/** This catalog contains only locally initiated source IDs, not a guessed server activity list. */
export function ErasurePanel(props: Props) {
  const client = useQueryClient();
  const catalogKey = [...protectedQueryKey(props.context, "erasure"), "local-intents"];
  const catalog = useQuery<readonly string[]>({ queryKey: catalogKey, queryFn: skipToken, gcTime: Infinity });
  const savedIds = catalog.data ?? [];
  const ids = [...new Set([...savedIds, ...(props.selectedSourceId ? [props.selectedSourceId] : [])])];
  if (!ids.length) return null;
  const text = copy[props.locale];
  return <section className="er-live-erasure" aria-label={text.requests}>
    {ids.map(sourceId => <ErasureReview key={sourceId} {...props} sourceId={sourceId}
      selected={sourceId === props.selectedSourceId} onIntent={() => {
        if (props.privacy.isCurrent(props.context)) client.setQueryData<readonly string[]>(catalogKey,
          old => old?.includes(sourceId) ? old : [...(old ?? []), sourceId]);
      }} />)}
  </section>;
}

function ErasureReview({ sourceId, selected, onIntent, ...props }: Props & {
  readonly sourceId: string; readonly selected: boolean; readonly onIntent: () => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false), [disclosure, setDisclosure] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const key = protectedQueryKey(props.context, "erasure");
  const intentKey = [...key, "intent", sourceId];
  const intent = useQuery<LocalIntent>({ queryKey: intentKey, queryFn: skipToken, gcTime: Infinity });
  const preparedKey = [...key, "prepared", sourceId, intent.data?.key ?? null];
  const prepared = useQuery<ErasurePrepareView>({ queryKey: preparedKey, queryFn: skipToken, gcTime: Infinity });
  const actions = erasureActions(props.apis.sources.erasure, props.privacy, props.context, {
    library: props.currentLibrary, prepared: () => client.getQueryData(preparedKey),
  });
  const status = useQuery(prepared.data ? { ...actions.status(prepared.data), enabled: false, gcTime: Infinity }
    : { queryKey: [...key, "status-unselected", sourceId], queryFn: skipToken, gcTime: Infinity });
  const text = copy[props.locale];
  const refusedText = props.locale === "ru"
    ? "Запрос удаления отклонён до выполнения. Прочитайте актуальные сведения перед новым подтверждением."
    : "The deletion request was refused before execution. Read a fresh review before confirming again.";
  // The shared classifier is consulted first, before this component touches its protected intent or
  // query-cache state. Authorization and session loss are owned by the privacy controller and apply
  // to every operation, so an unclassified response must never reach a blocked-intent lookup that
  // would read or rewrite a fence the owner still needs.
  const classifyErasureRefusal = (error: unknown) => {
    if (!isWorkspaceRequestError(error)) return false;
    try {
      return classifyMutationOutcome({
        operation: "erasure.execute", code: error.code, status: error.status, dispatched: true,
      }).clearsIntent;
    } catch { return false; }
  };
  const prepare = useMutation({ retry: false,
    mutationFn: ({ page, intent: identity, signal }: { readonly page: LibraryPage; readonly intent: string; readonly signal: AbortSignal }) =>
      actions.prepare(page, sourceId, identity, signal),
    onSuccess: (result, variables) => {
      const current = client.getQueryData<LocalIntent>(intentKey);
      if (props.privacy.isCurrent(props.context) && current?.key === variables.intent && !current.submitted) {
        const resultKey = actions.preparedKey(sourceId, variables.intent);
        client.setQueryDefaults(resultKey, { gcTime: Infinity });
        client.setQueryData(resultKey, result);
      }
    },
  });
  const confirm = useMutation({ retry: false,
    mutationFn: ({ review, signal }: { readonly review: ErasurePrepareView; readonly intent: string; readonly signal: AbortSignal }) => actions.confirm(review, signal),
    onSuccess: (_receipt, variables) => {
      if (props.privacy.isCurrent(props.context) && client.getQueryData(preparedKey) === variables.review) {
        void client.fetchQuery(actions.status(variables.review)).catch(() => undefined);
      }
    },
    onError: (_error, variables) => {
      if (classifyErasureRefusal(_error) === false) return;
      const current = client.getQueryData<LocalIntent>(intentKey);
      if (!props.privacy.isCurrent(props.context) || current?.key !== variables.intent ||
        client.getQueryData(preparedKey) !== variables.review) return;
      // Preserve the refusal for review; a new execution needs a fresh owner-selected review.
      client.setQueryData<LocalIntent>(intentKey, { ...current, submitted: false, rejected: true });
    },
  });
  useEffect(() => () => { controller.current?.abort(); }, []);
  const review = () => {
    if (!props.privacy.isCurrent(props.context) || !props.page?.sources.some(source => source.id === sourceId)) return;
    const current = client.getQueryData<LocalIntent>(intentKey);
    if (current?.submitted || prepare.isPending) return;
    // A refusal consumed this request identity. A new execution needs a fresh owner-selected review
    // and a fresh idempotency identity, never a replay of the refused one.
    const identity = current?.rejected ? props.apis.sources.mintIntent() : current?.key ?? props.apis.sources.mintIntent();
    client.setQueryData<LocalIntent>(intentKey, { key: identity, submitted: false });
    onIntent(); controller.current?.abort(); controller.current = new AbortController();
    prepare.mutate({ page: props.page, intent: identity, signal: controller.current.signal });
  };
  const submit = () => {
    const current = client.getQueryData<LocalIntent>(intentKey);
    const value = client.getQueryData<ErasurePrepareView>(preparedKey);
    if (!props.privacy.isCurrent(props.context) || !current || current.submitted || current.rejected || !value || confirm.isPending) return;
    // Mark the gesture before dispatch, so two clicks cannot submit twice even before React renders.
    client.setQueryData<LocalIntent>(intentKey, { ...current, submitted: true });
    controller.current?.abort(); controller.current = new AbortController();
    confirm.mutate({ review: value, intent: current.key, signal: controller.current.signal });
  };
  const close = () => {
    // Closing the reader never cancels work or discards an uncertain operation identity.
    if (!client.getQueryData<LocalIntent>(intentKey)?.submitted) controller.current?.abort();
    setOpen(false);
  };
  const refresh = () => {
    const value = client.getQueryData<ErasurePrepareView>(preparedKey);
    if (value && props.privacy.isCurrent(props.context)) void status.refetch();
  };
  const submitted = intent.data?.submitted === true;
  const completed = prepared.data !== undefined && isErasureComplete(prepared.data, status.data, props.privacy, props.context);
  // The exact erasure tuple is the dedupe identity. An execute receipt, a repeated status read or a
  // reconciliation of the same canonical tuple reports once; no uncertain, BLOCKED, rejected or
  // aborted outcome reports at all, so the consumer can never observe a fabricated completion.
  // isErasureComplete already established a canonical COMPLETE receipt whose erasure ref matches the
  // prepared request; this narrowing only makes that guarantee visible to the type checker.
  const verifiedStatus = completed ? status.data : null;
  const completedKey = verifiedStatus !== null && verifiedStatus !== undefined
    ? "erasure:" + verifiedStatus.erasure_ref.id + ":" + verifiedStatus.erasure_ref.revision
    : undefined;
  const reportErasureComplete = useCanonicalCommitReport(
    completedKey === undefined ? undefined : () => {
      const verified = status.data;
      if (verified !== undefined && verified !== null) props.onErasureComplete?.(sourceId, verified);
    },
  );
  useEffect(() => {
    if (completedKey !== undefined) reportErasureComplete(completedKey);
  }, [completedKey, reportErasureComplete]);
  const pending = prepare.isPending || confirm.isPending || (status.data === undefined && status.isFetching);
  const operationMessage = prepare.isPending ? text.preparing : confirm.isPending ? text.confirming
    : status.isFetching ? text.readingStatus : completed ? text.completed : intent.data?.rejected ? refusedText
    : prepare.isError || status.isError ? text.failed
    : submitted ? status.data?.state === "BLOCKED" ? text.blocked : text.unknown
    : prepared.data ? text.ready : '';
  const title = prepared.data?.source_title ?? props.page?.sources.find(source => source.id === sourceId)?.title ?? text.resume;
  const trigger = <Button variant="text" onClick={() => {
    setOpen(true);
    if (!submitted && !prepared.data) review();
  }}>{submitted ? text.resume : text.open}</Button>;
  return <>
    {selected ? <details><summary>{text.manage}</summary>{trigger}</details> : submitted ? trigger : null}
    <Dialog open={open} title={title} onClose={close}>
      {open && <OperationFeedback message={operationMessage} />}
      {completed ? <><Status icon="check">{text.completed}</Status><Button variant="tonal" onClick={refresh}>{text.refresh}</Button></>
        : intent.data?.rejected ? <><Status tone="error">{refusedText}</Status><Button variant="tonal" onClick={review}>{text.retry}</Button></>
        : !prepared.data && prepare.isError ? <><Status tone="error">{text.failed}</Status><Button variant="tonal" onClick={review}>{text.retry}</Button></>
        : <ErasureFeature locale={props.locale} copy={ERASURE_COPY[props.locale]}
          state={pending ? "loading" : submitted ? status.data?.state === "BLOCKED" || status.isError ? "error" : "degraded" : "useful"}
          {...(prepared.data ? { prepared: prepared.data } : {})}
          {...(status.data ? { status: status.data } : {})}
          hasSavedStatus={submitted} completeVerified={false} reviewOpen={disclosure}
          onReview={review} onConfirm={submit} onCancel={close} onRefresh={refresh} onToggleDisclosure={() => setDisclosure(value => !value)} />}
      <Button variant="text" onClick={close}>{text.close}</Button>
    </Dialog>
  </>;
}
