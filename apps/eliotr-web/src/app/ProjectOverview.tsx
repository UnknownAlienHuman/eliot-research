import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, SafeMarkdown, Status } from "@eliotr/ui";
import type { VersionedRef } from "@eliotr/owner-api-client";
import { ensureProjectGuideOnOpen, projectGuideQueryOptions, type ProjectGuideConnection } from "../query/projectGuide";

export interface ProjectOverviewGuideConnection extends ProjectGuideConnection {
  readonly onOpenReport: (artifact: VersionedRef) => void;
}
/** Parent supplies project authority; its composer remains the sole owner of onSuggest. */
export function ProjectOverview({ locale, onSuggest, guide }: {
  readonly locale: "en" | "ru"; readonly onSuggest: (question: string) => void;
  readonly guide?: ProjectOverviewGuideConnection | undefined;
}) {
  if (guide === undefined) return null;
  return <ConnectedProjectGuide key={`${guide.context.cacheEpoch}:${guide.projectId}:${locale}`}
    connection={guide} locale={locale} onSuggest={onSuggest} />;
}
function ConnectedProjectGuide({ connection, locale, onSuggest }: {
  readonly connection: ProjectOverviewGuideConnection; readonly locale: "en" | "ru";
  readonly onSuggest: (question: string) => void;
}) {
  const ru = locale === "ru", client = useQueryClient(), options = projectGuideQueryOptions(connection, locale);
  const query = useQuery({ ...options, refetchInterval: current =>
    current.state.data?.state === "PENDING" || current.state.data?.state === "UNKNOWN" ? 5000 : false,
  refetchIntervalInBackground: false });
  const [admissionFailed, setAdmissionFailed] = useState(false);
  const latest = useRef(connection); latest.current = connection;
  useEffect(() => {
    if (query.data === undefined) return;
    const abort = new AbortController(), captured = query.data;
    // StrictMode's discarded effect closes before this open event dispatches.
    queueMicrotask(() => {
      if (abort.signal.aborted) return;
      const active = latest.current;
      const pending = ensureProjectGuideOnOpen(active, captured, abort.signal);
      if (pending !== undefined) void pending.then(view => {
        if (!abort.signal.aborted && active.privacy.isCurrent(active.context) && active.isProjectCurrent()) {
          client.setQueryData(projectGuideQueryOptions(active, locale).queryKey, view);
        }
      }, () => { if (!abort.signal.aborted) setAdmissionFailed(true); });
    });
    // Aborting transport is not cancellation of the admitted server workflow.
    return () => abort.abort();
  }, [client, connection.context, connection.projectId, locale, query.data]);
  const view = query.data;
  const live = () => connection.privacy.isCurrent(connection.context) && connection.isProjectCurrent();
  const current = live();
  const ready = current && !query.isError && (view?.state === "READY" || view?.state === "PARTIAL") && view.guide !== null ? view : undefined;
  // Plain words: the overview is being prepared, is not ready, or needs something from the owner.
  const messages = ru ? {
    EMPTY: "Добавьте источники — и здесь появится обзор проекта.", MISSING: "Готовим обзор источников проекта…",
    BLOCKED: "Для обзора нужна рабочая модель. Выберите её в Настройках.", PENDING: "Готовим обзор источников проекта…",
    UNKNOWN: "Обзор проекта пока не готов.", FAILED: "Не удалось подготовить обзор проекта.",
    STALE: "Источники изменились после прошлого обзора.",
    INVALID: "Не удалось подготовить обзор проекта.", PARTIAL: "Обзор по части источников", READY: "",
  } : {
    EMPTY: "Add sources and an overview of this project appears here.", MISSING: "Preparing an overview of this project's sources…",
    BLOCKED: "The overview needs a working model. Choose one in Settings.", PENDING: "Preparing an overview of this project's sources…",
    UNKNOWN: "The project overview isn't ready yet.", FAILED: "The project overview could not be prepared.",
    STALE: "Sources changed since the last overview.",
    INVALID: "The project overview could not be prepared.", PARTIAL: "Overview of some sources", READY: "",
  };
  const preparing = current && !query.isError && !admissionFailed && (view === undefined || view.state === "MISSING" || view.state === "PENDING");
  return <section aria-label={ru ? "Путеводитель по проекту" : "Project source guide"}>
    <h3>{ru ? "Обзор проекта" : "Project overview"}</h3>
    {!connection.hasSourceEvidence ? <p>{messages.EMPTY}</p> : ready?.guide ? <>
      {ready.state === "PARTIAL" && <Status>{messages.PARTIAL}</Status>}
      {ready.guide.summary.map(claim => <div key={claim.claim_ref.id}><SafeMarkdown text={claim.text} />
        {claim.label === "DERIVED_INFERENCE" && <small>{ru ? "Вывод на основе источников" : "Inference from sources"}</small>}</div>)}
      <p>{ru ? "В рассмотренных доказательствах представлены источники:" : "Sources represented in the reviewed evidence:"} {ready.guide.coverage.represented_source_refs.length}/{ready.source_count}.
        {ready.state === "PARTIAL" &&
          (ru ? " Охват ограничен; полнота корпуса не установлена." : " Coverage is limited; corpus completeness is not established.")}</p>
      <details><summary>{ru ? "Источники, использованные в путеводителе" : "Sources used for this guide"}</summary>
        <ul>{ready.guide.source_basis.map(source => <li key={source.source_revision_ref}>{source.title}</li>)}</ul>
        {ready.guide.coverage.budget_limitations.map((limit, index) => <p key={index}>{limit}</p>)}
        {ready.guide.coverage.unknown_coverage_reason && <p>{ready.guide.coverage.unknown_coverage_reason}</p>}
      </details>
      <h4>{ru ? "Что исследовать дальше" : "Questions arising from these sources"}</h4>
      <div className="er-live-actions">{ready.guide.questions.map(question => <Button key={question.claim_ref.id} variant="text"
        onClick={() => { if (live()) onSuggest(question.text); }}>{question.text}</Button>)}</div>
      {ready.artifact_ref && <Button variant="tonal" onClick={() => {
        if (live() && ready.artifact_ref) connection.onOpenReport(ready.artifact_ref);
      }}>{ru ? "Источники и доказательства путеводителя" : "Guide sources and evidence"}</Button>}
    </> : <>
      <Status>{!current || query.isError || admissionFailed
        ? ru ? "Обзор проекта сейчас недоступен — можно сразу задать вопрос." : "The project overview isn't available — you can ask your question right away."
        : view ? messages[view.state] : messages.MISSING}</Status>
      {!preparing && <Button variant="text" disabled={query.isFetching} onClick={() => { setAdmissionFailed(false); void query.refetch(); }}>
        {ru ? "Повторить" : "Try again"}</Button>}
      {current && !query.isError && view?.artifact_ref && <Button variant="text" onClick={() => {
        if (view.artifact_ref && connection.privacy.isCurrent(connection.context) && connection.isProjectCurrent()) connection.onOpenReport(view.artifact_ref);
      }}>{ru ? "Открыть прошлый обзор" : "Open the last overview"}</Button>}
    </>}
  </section>;
}
