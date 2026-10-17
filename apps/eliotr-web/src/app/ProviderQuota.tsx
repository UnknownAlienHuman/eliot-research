import "./settings.css";

/**
 * One provider's usage, in the shape the OpenCodex donor reads from provider APIs: rolling windows
 * (OpenCode Go `/zen/go/v1/usage`: rolling 5 h, weekly, monthly) and credit balances (OpenRouter
 * `/api/v1/key`). Presentation only: the server reads the provider with its stored key.
 */
export interface ProviderQuotaView {
  readonly state: "available" | "unsupported" | "unavailable";
  readonly observed_at?: string;
  readonly windows: readonly {
    readonly label: string;
    readonly used_percent: number;
    readonly resets_at?: string;
  }[];
  readonly credits?: { readonly used: number; readonly limit: number; readonly remaining: number; readonly currency: string };
}

const WINDOW = {
  en: { five_hour: "5 h", week: "Week", month: "Month" },
  ru: { five_hour: "5 ч", week: "Неделя", month: "Месяц" },
} as const;

function windowLabel(locale: "en" | "ru", label: string): string {
  return label === "five_hour" || label === "week" || label === "month" ? WINDOW[locale][label] : label;
}

function resetIn(locale: "en" | "ru", at: string | undefined, now: number): string | undefined {
  if (at === undefined || !Number.isFinite(Date.parse(at))) return undefined;
  const minutes = Math.max(0, Math.round((Date.parse(at) - now) / 60_000));
  const value = minutes < 60 ? { amount: minutes, unit: "minute" as const }
    : minutes < 48 * 60 ? { amount: Math.round(minutes / 60), unit: "hour" as const }
      : { amount: Math.round(minutes / 1440), unit: "day" as const };
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value.amount, value.unit);
  return locale === "ru" ? `сброс ${relative}` : `resets ${relative}`;
}

/** Compact bars beside a provider's name: how much of each window is used, and when it resets. */
export function ProviderQuota({ locale, quota, now = Date.now() }: {
  readonly locale: "en" | "ru"; readonly quota: ProviderQuotaView | undefined; readonly now?: number;
}) {
  if (quota === undefined || quota.state === "unsupported") return null;
  const ru = locale === "ru";
  if (quota.state === "unavailable") {
    return <p className="er-provider-quota er-provider-quota--quiet">{ru ? "Квота сейчас не читается" : "Quota is not readable right now"}</p>;
  }
  const money = (value: number, currency: string) => new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  return <ul className="er-provider-quota" aria-label={ru ? "Квота провайдера" : "Provider quota"}>
    {quota.windows.map(window => {
      const used = Math.min(100, Math.max(0, window.used_percent));
      const reset = resetIn(locale, window.resets_at, now);
      return <li key={window.label}>
        <span className="er-provider-quota__label">{windowLabel(locale, window.label)}</span>
        <meter min={0} max={100} value={used} low={70} high={90} optimum={0}
          aria-label={`${windowLabel(locale, window.label)}: ${Math.round(used)}%`} />
        <span className="er-provider-quota__value">{Math.round(used)}%{reset ? ` · ${reset}` : ""}</span>
      </li>;
    })}
    {quota.credits && <li>
      <span className="er-provider-quota__label">{ru ? "Кредиты" : "Credits"}</span>
      <meter min={0} max={quota.credits.limit} value={Math.min(quota.credits.used, quota.credits.limit)}
        low={quota.credits.limit * 0.7} high={quota.credits.limit * 0.9} optimum={0}
        aria-label={ru ? "Израсходовано кредитов" : "Credits used"} />
      <span className="er-provider-quota__value">{ru
        ? `осталось ${money(quota.credits.remaining, quota.credits.currency)} из ${money(quota.credits.limit, quota.credits.currency)}`
        : `${money(quota.credits.remaining, quota.credits.currency)} of ${money(quota.credits.limit, quota.credits.currency)} left`}</span>
    </li>}
  </ul>;
}
