import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Status } from "@eliotr/ui";
import { readAiUsageObservation } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { protectedQueryKey, runProtectedRead } from "../query/client";
import { aiUsagePresentation } from "../query/aiUsagePresentation";

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
  const unavailable = ru ? "Недоступно" : "Unavailable";
  return <section className="er-live-callout" aria-labelledby={heading}>
    <h2 id={heading}>Cloudflare Workers AI</h2>
    {query.isPending ? <Status>{ru ? "Читается расход нейронов…" : "Reading neuron usage…"}</Status>
      : (usage.used === null || usage.remaining === null) && <Status>{ru
        ? "Данные Cloudflare Analytics недоступны. Расход и остаток не определены."
        : "Cloudflare Analytics data is unavailable. Usage and remaining allocation are unknown."}</Status>}
    {(value || usage.freeAllocation !== undefined) && <dl>
      <dt>{ru ? "Бесплатная дневная квота" : "Daily free allocation"}</dt>
      <dd>{usage.freeAllocation === undefined ? unavailable : `${number(usage.freeAllocation)} ${ru ? "нейронов" : "neurons"}`}</dd>
      <dt>{ru ? "Использовано сегодня (UTC)" : "Used today (UTC)"}</dt>
      <dd>{usage.used === null ? unavailable : `${number(usage.used)} ${ru ? "нейронов" : "neurons"}`}</dd>
      <dt>{ru ? "Осталось бесплатных нейронов" : "Free neurons remaining"}</dt>
      <dd>{usage.remaining === null ? unavailable : `${number(usage.remaining)} ${ru ? "нейронов" : "neurons"}`}</dd>
    </dl>}
    <p>{ru ? "Данные аккаунта из Cloudflare Analytics. Бесплатная квота обновляется в 00:00 UTC; платное использование может её превышать."
      : "Account usage from Cloudflare Analytics. The free allocation resets at 00:00 UTC; paid usage can exceed it."}</p>
    {usage.observedAt && <p>{ru ? "Обновлено: " : "Updated: "}<time dateTime={usage.observedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(usage.observedAt))}</time></p>}
    <Button variant="text" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{ru ? "Обновить" : "Refresh"}</Button>
  </section>;
}
