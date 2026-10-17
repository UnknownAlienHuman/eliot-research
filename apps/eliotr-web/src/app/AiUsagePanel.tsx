import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Status } from "@eliotr/ui";
import { readAiUsageObservation } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { protectedQueryKey, runProtectedRead } from "../query/client";
import { aiUsagePresentation } from "../query/aiUsagePresentation";
import "./settings.css";

export function AiUsagePanel({ apis, privacy, context, locale }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController;
  readonly context: SessionContext; readonly locale: "en" | "ru";
}) {
  const heading = useId();
  const query = useQuery({ queryKey: protectedQueryKey(context, "ai-usage"), staleTime: 60_000,
    queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, readSignal =>
      readAiUsageObservation(apis.http, context.deploymentGeneration, readSignal)) });
  const value = query.data, ru = locale === "ru";
  const usage = aiUsagePresentation(value, query.isError);
  const number = (count: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(count);
  const unavailable = ru ? "нет данных" : "no data";
  const neurons = (count: number) => `${number(count)} ${ru ? "нейронов" : "neurons"}`;
  const measured = usage.used !== null && usage.remaining !== null && usage.freeAllocation !== undefined;
  // The answer first (how much is left today), then the three numbers behind it, then when it resets.
  return <section className="er-settings-card er-ai-usage" aria-labelledby={heading}>
    <div className="er-settings-card__head">
      <h2 id={heading}>{ru ? "Квота Cloudflare Workers AI" : "Cloudflare Workers AI quota"}</h2>
      <Button variant="text" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{ru ? "Обновить" : "Refresh"}</Button>
    </div>
    {query.isPending ? <Status>{ru ? "Читаем расход нейронов…" : "Reading neuron usage…"}</Status>
      : measured ? <>
        <p className="er-ai-usage__headline"><strong>{number(usage.remaining ?? 0)}</strong> {ru
          ? `из ${neurons(usage.freeAllocation ?? 0)} осталось сегодня` : `of ${neurons(usage.freeAllocation ?? 0)} left today`}</p>
        <meter className="er-ai-usage__meter" min={0} max={usage.freeAllocation} value={Math.min(usage.used ?? 0, usage.freeAllocation ?? 0)}
          low={(usage.freeAllocation ?? 0) * 0.7} high={(usage.freeAllocation ?? 0) * 0.9} optimum={0}
          aria-label={ru ? "Израсходовано сегодня" : "Used today"} />
      </> : <Status>{ru
        ? "Расход пока не виден: серверу нужен доступ на чтение Cloudflare Analytics."
        : "Usage isn't visible yet: the server needs read access to Cloudflare Analytics."}</Status>}
    {(value || usage.freeAllocation !== undefined) && <dl className="er-ai-usage__facts">
      <div><dt>{ru ? "Бесплатно в день" : "Free per day"}</dt>
        <dd>{usage.freeAllocation === undefined ? unavailable : neurons(usage.freeAllocation)}</dd></div>
      <div><dt>{ru ? "Израсходовано сегодня" : "Used today"}</dt>
        <dd>{usage.used === null ? unavailable : neurons(usage.used)}</dd></div>
      <div><dt>{ru ? "Осталось" : "Remaining"}</dt>
        <dd>{usage.remaining === null ? unavailable : neurons(usage.remaining)}</dd></div>
    </dl>}
    <p className="er-settings-card__note">{ru ? "Квота обновляется в 00:00 UTC; сверх неё расход платный."
      : "The free allocation resets at 00:00 UTC; usage beyond it is paid."}
      {usage.observedAt && <> {ru ? "Обновлено " : "Updated "}<time dateTime={usage.observedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(usage.observedAt))}</time>.</>}</p>
  </section>;
}
