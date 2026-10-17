import type { LibraryPage } from "@eliotr/owner-api-client";
import "./projects-library.css";

type Summary = LibraryPage["sources"][number]["readiness_summary"];
const COPY = {
  en: { ready: "Ready at last check", queued: "Indexing queued", attention: "Needs attention", unknown: "Readiness unknown",
    stale: "The last readiness check is out of date.", recorded: "Saved readiness; open the source for a current check.",
    missing: "No saved readiness check; the timestamp is when this source was listed." },
  ru: { ready: "Готов при последней проверке", queued: "В очереди на индексацию", attention: "Требует внимания", unknown: "Готовность неизвестна",
    stale: "Последняя проверка готовности устарела.", recorded: "Сохранённая готовность; откройте источник для текущей проверки.",
    missing: "Проверка готовности не сохранена; указано время чтения списка источников." },
} as const;

/** Recorded metadata is presentation only; it never authorizes search or source selection. */
export function SourceReadinessSummary({ summary, locale }: { readonly summary: Summary; readonly locale: "en" | "ru" }) {
  const text = COPY[locale], channels = summary?.channels ?? [];
  const stale = channels.some(channel => channel.state === "stale");
  const attention = summary?.quality_state === "unqualified" || summary?.quality_state === "degraded" || stale ||
    channels.some(channel => ["failed", "degraded", "redacted"].includes(channel.state));
  const queued = channels.some(channel => channel.state === "queued" || channel.state === "running");
  const ready = channels.length === 3 && channels.every(channel => channel.state === "ready");
  const state = attention ? "attention" : queued ? "queued" : ready ? "ready" : "unknown";
  // For a complete ready set, use the oldest check rather than making its age
  // appear as fresh as the most recently updated channel. No age TTL is invented.
  const dates = channels.map(channel => Date.parse(channel.observed_at));
  const instant = dates.length ? (state === "ready" ? Math.min(...dates) : Math.max(...dates))
    : summary === undefined ? undefined : Date.parse(summary.observed_at);
  const timestamp = instant === undefined ? undefined : new Date(instant).toISOString();
  const title = stale ? text.stale : dates.length ? text.recorded : text.missing;
  return <small className="er-source-readiness" data-state={stale ? "stale" : state} title={title}>
    {text[state]}{timestamp === undefined ? null : <> · <time dateTime={timestamp}>
      {new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-GB", {
        dateStyle: "short", timeStyle: "short", timeZone: "UTC",
      }).format(instant)} UTC
    </time></>}
  </small>;
}
