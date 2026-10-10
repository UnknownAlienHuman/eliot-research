import { useEffect, useRef, useState } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, ERASURE_COPY, ErasureFeature, Status } from "@eliotr/ui";
import type { ErasurePrepareView, LibraryPage } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { protectedQueryKey } from "../query/client";
import { erasureActions, isErasureComplete } from "../query/erasure";

const copy = {
  en: { manage: "Manage selected source", requests: "Deletion requests in this session", open: "Review deletion", resume: "Check deletion request", close: "Back to sources", failed: "The deletion review could not be read. Try again with the same request.", retry: "Read review again", completed: "Deletion confirmed by the saved server receipt.", refresh: "Refresh status" },
  ru: { manage: "Управление выбранным источником", requests: "Запросы удаления в этом сеансе", open: "Проверить удаление", resume: "Проверить запрос удаления", close: "Вернуться к источникам", failed: "Не удалось прочитать сведения об удалении. Повторите чтение того же запроса.", retry: "Прочитать сведения снова", completed: "Удаление подтверждено сохранённой квитанцией сервера.", refresh: "Обновить статус" },
} as const;

interface Props {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly locale: "en" | "ru"; readonly selectedSourceId?: string | undefined;
  readonly page?: LibraryPage | undefined; readonly currentLibrary: () => LibraryPage | undefined;
}
interface LocalIntent { readonly key: string; readonly submitted: boolean }

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
    mutationFn: ({ review, signal }: { readonly review: ErasurePrepareView; readonly signal: AbortSignal }) => actions.confirm(review, signal),
    onSuccess: (_receipt, variables) => {
      if (props.privacy.isCurrent(props.context) && client.getQueryData(preparedKey) === variables.review) {
        void client.fetchQuery(actions.status(variables.review)).catch(() => undefined);
      }
    },
  });
  useEffect(() => () => { controller.current?.abort(); }, []);
  const review = () => {
    if (!props.privacy.isCurrent(props.context) || !props.page?.sources.some(source => source.id === sourceId)) return;
    const current = client.getQueryData<LocalIntent>(intentKey);
    if (current?.submitted || prepare.isPending) return;
    const identity = current?.key ?? props.apis.sources.mintIntent();
    client.setQueryData<LocalIntent>(intentKey, { key: identity, submitted: false });
    onIntent(); controller.current?.abort(); controller.current = new AbortController();
    prepare.mutate({ page: props.page, intent: identity, signal: controller.current.signal });
  };
  const submit = () => {
    const current = client.getQueryData<LocalIntent>(intentKey);
    const value = client.getQueryData<ErasurePrepareView>(preparedKey);
    if (!props.privacy.isCurrent(props.context) || !current || current.submitted || !value || confirm.isPending) return;
    // Mark the gesture before dispatch, so two clicks cannot submit twice even before React renders.
    client.setQueryData<LocalIntent>(intentKey, { ...current, submitted: true });
    controller.current?.abort(); controller.current = new AbortController();
    confirm.mutate({ review: value, signal: controller.current.signal });
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
  const pending = prepare.isPending || confirm.isPending || (status.data === undefined && status.isFetching);
  const title = prepared.data?.source_title ?? props.page?.sources.find(source => source.id === sourceId)?.title ?? text.resume;
  const trigger = <Button variant="text" onClick={() => {
    setOpen(true);
    if (!submitted && !prepared.data) review();
  }}>{submitted ? text.resume : text.open}</Button>;
  return <>
    {selected ? <details><summary>{text.manage}</summary>{trigger}</details> : submitted ? trigger : null}
    <Dialog open={open} title={title} onClose={close}>
      {completed ? <><Status icon="check">{text.completed}</Status><Button variant="tonal" onClick={refresh}>{text.refresh}</Button></>
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
