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
  const messages = ru ? {
    EMPTY: "Добавьте источники, чтобы создать путеводитель по проекту.", MISSING: "Готовим путеводитель по источникам проекта.",
    BLOCKED: "Для путеводителя нужна доступная квалифицированная модель проекта.", PENDING: "Исследуем источники для путеводителя.",
    UNKNOWN: "Запуск путеводителя пока не подтверждён. Проверяется тот же запрос.", FAILED: "Исследование для путеводителя завершилось с ошибкой.",
    STALE: "Источники путеводителя изменились. Сохранённый отчёт не является текущим обзором проекта.",
    INVALID: "Сохранённый результат не содержит проверенного обзора и 3–5 вопросов по источникам.", PARTIAL: "Частичный путеводитель", READY: "",
  } : {
    EMPTY: "Add sources to create this project's guide.", MISSING: "Preparing a guide to this project's sources.",
    BLOCKED: "The guide needs an available qualified project model.", PENDING: "Researching the sources for your project guide.",
    UNKNOWN: "The guide launch is not confirmed. The same request is being checked.", FAILED: "The guide research ended with an error.",
    STALE: "The guide's sources changed. Its saved report is not a current project overview.",
    INVALID: "The saved result does not contain a verified summary and 3–5 source-derived questions.", PARTIAL: "Partial guide", READY: "",
  };
  return <section aria-label={ru ? "Путеводитель по проекту" : "Project source guide"}>
    <h3>{ru ? "Об источниках проекта" : "About this project's sources"}</h3>
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
        ? ru ? "Путеводитель сейчас недоступен. Вы можете продолжить исследование ниже." : "The guide is unavailable. You can continue with your question below."
        : view ? messages[view.state] : ru ? "Читаем путеводитель проекта." : "Reading the project guide."}</Status>
      <Button variant="text" disabled={query.isFetching} onClick={() => { setAdmissionFailed(false); void query.refetch(); }}>
        {ru ? "Проверить путеводитель" : "Check guide"}</Button>
      {current && !query.isError && view?.artifact_ref && <Button variant="text" onClick={() => {
        if (view.artifact_ref && connection.privacy.isCurrent(connection.context) && connection.isProjectCurrent()) connection.onOpenReport(view.artifact_ref);
      }}>{ru ? "Открыть сохранённый отчёт" : "Open saved report"}</Button>}
    </>}
  </section>;
}
