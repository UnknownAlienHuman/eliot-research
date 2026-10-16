import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Status } from "@eliotr/ui";
import { readAiUsageObservation } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { protectedQueryKey, runProtectedRead } from "../query/client";

export function AiUsagePanel({ apis, privacy, context, locale }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController;
  readonly context: SessionContext; readonly locale: "en" | "ru";
}) {
  const heading = useId();
  const query = useQuery({ queryKey: protectedQueryKey(context, "ai-usage"), staleTime: 60_000,
    queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, readSignal =>
      readAiUsageObservation(apis.http, context.deploymentGeneration, readSignal)) });
  const value = query.data, ru = locale === "ru";
  const number = (count: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(count);
  return <section className="er-live-callout" aria-labelledby={heading}>
    <h2 id={heading}>Cloudflare Workers AI</h2>
    {query.isPending ? <Status>{ru ? "Читается расход нейронов…" : "Reading neuron usage…"}</Status>
      : query.isError || value?.status !== "available" ? <Status>{ru
        ? "Расход пока недоступен. Проверьте подключение к Cloudflare Analytics."
        : "Usage is unavailable. Check the Cloudflare Analytics connection."}</Status>
        : <dl>
          <dt>{ru ? "Использовано сегодня (UTC)" : "Used today (UTC)"}</dt><dd>{number(value.usage_neurons ?? 0)} {ru ? "нейронов" : "neurons"}</dd>
          <dt>{ru ? "Бесплатная дневная квота" : "Daily free allocation"}</dt><dd>{number(value.free_allocation_neurons)}</dd>
          <dt>{ru ? "Осталось бесплатных нейронов" : "Free neurons remaining"}</dt><dd>{number(value.remaining_neurons ?? 0)}</dd>
        </dl>}
    <p>{ru ? "Данные аккаунта из Cloudflare Analytics. Бесплатная квота обновляется в 00:00 UTC; платное использование может её превышать."
      : "Account usage from Cloudflare Analytics. The free allocation resets at 00:00 UTC; paid usage can exceed it."}</p>
    {value && <p>{ru ? "Обновлено: " : "Updated: "}<time dateTime={value.observed_at}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value.observed_at))}</time></p>}
    <Button variant="text" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{ru ? "Обновить" : "Refresh"}</Button>
  </section>;
}
