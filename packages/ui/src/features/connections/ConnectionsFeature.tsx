import { useId, useState } from "react";
import { Button, type StatusTone } from "../../primitives/primitives";
import "./connections.css";

/**
 * Read-only Connections feature. Pure props: no transport, query, store, factory, SDK,
 * environment or global effect is imported or acquired here. The root binds data and actions.
 *
 * Every row projects an accepted DTO by Pick or indexed access, so no status, phase or
 * transport literal is restated in this file. Each row carries its own query state, so a
 * single global loading or failure flag can never collapse the rows into one answer.
 *
 * Row to DTO mapping:
 *   health          <- SystemHealth
 *   session         <- OwnerSession
 *   grant           <- ProjectClientGrant (state only)
 *   providerConfig  <- ResearchProviderKeyConfigurationEntry (status, failure_code)
 *   projectModel    <- ResearchProjectModelConfigurationSelection
 *   providerModelUse<- ResearchProviderKeyModelUseReceipt (state, phase, failure_code)
 *   googleTransport <- SystemHealth.google_external_transport
 *   diagnostic      <- McpDiagnosticLatestStatus (status, observed_at)
 */

import type {
  OwnerSession,
  ResearchProjectModelConfiguration,
  SystemHealth,
  ResearchModelConfigurationRevision,
  ResearchConfigurationView,
} from "@eliotr/owner-api-client";
import type {
  createClientGrantApi,
  createMcpDiagnosticApi,
  createProviderKeyApi,
  createProviderModelUseApi,
  createResearchModelConfigurationApi,
} from "@eliotr/owner-api-client";

export type ConnectionsRowQuery = "idle" | "loading" | "loaded" | "failed";
export type ConnectionsGoogleTransport = NonNullable<SystemHealth["google_external_transport"]>;
export type ConnectionsQualificationState = ResearchModelConfigurationRevision["qualification_state"];

/**
 * DTOs whose type names are not re-exported by the accepted owner-api-client barrel are
 * derived from the exported factory return types. No field is restated or duplicated.
 */
type GrantApi = ReturnType<typeof createClientGrantApi>;
type ProviderKeyApi = ReturnType<typeof createProviderKeyApi>;
type ModelUseApi = ReturnType<typeof createProviderModelUseApi>;
type DiagnosticApi = ReturnType<typeof createMcpDiagnosticApi>;
type ModelsApi = ReturnType<typeof createResearchModelConfigurationApi>;

export type ConnectionsGrant = Awaited<ReturnType<GrantApi["readClientGrants"]>>["grants"][number];
export type ConnectionsProviderConfig = Awaited<ReturnType<ProviderKeyApi["readResearchProviderKeyConfigurations"]>>["configurations"][number];
export type ConnectionsModelSelection = Awaited<ReturnType<ModelsApi["readResearchProjectModelConfiguration"]>>;
export type ConnectionsProviderModelUse = Awaited<ReturnType<ModelUseApi["readResearchProviderKeyModelUse"]>>;
export type ConnectionsDiagnostic = NonNullable<Awaited<ReturnType<DiagnosticApi["getLatestMcpClientDiagnostic"]>>>;
export type ConnectionsDiagnosticState = ConnectionsDiagnostic["status"];

/** Research readiness, projected from the accepted ResearchConfigurationView. */
export type ConnectionsReadiness = Pick<ResearchConfigurationView,
  "run_readiness" | "readiness_reason" | "missing_fields" | "invalid_fields">;
export type ConnectionsRunReadiness = ResearchConfigurationView["run_readiness"];
export type ConnectionsReadinessReason = ResearchConfigurationView["readiness_reason"];

export type ConnectionsGrantState = ConnectionsGrant["state"];
export type ConnectionsDiagnosticStatus = ConnectionsDiagnostic["status"];
export type ConnectionsProviderStatus = ConnectionsProviderConfig["status"];
export type ConnectionsModelUseState = ConnectionsProviderModelUse["state"];
export type ConnectionsModelUsePhase = ConnectionsProviderModelUse["phase"];
export type ConnectionsProjectModel = ResearchProjectModelConfiguration;
export type ConnectionsModelRevision = ResearchProjectModelConfiguration["selected"];
export type ConnectionsHealth = Pick<SystemHealth, "ready" | "checked_at" | "google_external_transport">;
export type ConnectionsSession = Pick<OwnerSession, "client_class" | "expires_at">;

export type RowId =
  | "health" | "session" | "grant" | "providerConfig"
  | "projectModel" | "providerModelUse" | "researchReadiness"
  | "googleTransport" | "diagnostic";

/** Every row is answered by its own query. No row is inferred from another row. */
export type ConnectionsRowQueries = Record<RowId, ConnectionsRowQuery>;

export interface ConnectionsFeatureProps {
  readonly locale?: "en" | "ru";
  readonly queries: ConnectionsRowQueries;
  readonly health?: ConnectionsHealth | undefined;
  readonly session?: ConnectionsSession | undefined;
  readonly grants?: readonly ConnectionsGrant[] | undefined;
  readonly providerConfig?: ConnectionsProviderConfig | undefined;
  readonly providerConfigurations?: readonly ConnectionsProviderConfig[] | undefined;
  readonly projectModel?: ConnectionsProjectModel | undefined;
  readonly providerModelUse?: ConnectionsProviderModelUse | undefined;
  readonly readiness?: ConnectionsReadiness | undefined;
  readonly diagnostic?: ConnectionsDiagnostic | undefined;
  readonly onRefresh?: () => void;
  readonly onSignIn?: () => void;
  readonly onRequestAccess?: () => void;
  readonly onRetry?: () => void;
  readonly onOpenDiagnostics?: () => void;
}

/** A row's facts with its query state, ready for projection. */
export type ConnectionsRowInput = Omit<ConnectionsFeatureProps, "locale" | "queries">;

type FeatureAction = "signIn" | "requestAccess" | "retry" | "diagnostics" | "refresh";

const ROW_IDS: readonly RowId[] =
  ["health", "session", "grant", "providerConfig", "projectModel",
    "providerModelUse", "researchReadiness", "googleTransport", "diagnostic"];

export const IDLE_QUERIES: ConnectionsRowQueries = {
  health: "idle",
  session: "idle",
  grant: "idle",
  providerConfig: "idle",
  projectModel: "idle",
  providerModelUse: "idle",
  researchReadiness: "idle",
  googleTransport: "idle",
  diagnostic: "idle",
};

const LABEL: Record<"en" | "ru", Record<RowId, string>> = {
  en: {
    health: "Server and API",
    session: "Owner session",
    grant: "Project permission",
    providerConfig: "Model provider configuration",
    projectModel: "Selected model",
    providerModelUse: "Provider-key operation",
    researchReadiness: "Research configuration readiness",
    googleTransport: "Google transport routing",
    diagnostic: "Observed client call",
  },
  ru: {
    health: "Сервер и интерфейс",
    session: "Сеанс владельца",
    grant: "Разрешение проекта",
    providerConfig: "Настройка поставщика модели",
    projectModel: "Выбранная модель",
    providerModelUse: "Операция ключа поставщика",
    researchReadiness: "Готовность конфигурации исследования",
    googleTransport: "Маршрутизация транспорта Google",
    diagnostic: "Зафиксированный вызов клиента",
  },
};

const TEXT: Record<"en" | "ru", {
  title: string;
  note: string;
  idle: string;
  loading: string;
  failed: string;
  unknown: string;
}> = {
  en: {
    title: "Connections",
    note: "Review your access and the services available for research.",
    idle: "Not checked yet",
    loading: "Checking",
    failed: "Check could not complete",
    unknown: "Unknown",
  },
  ru: {
    title: "Подключения",
    note: "Проверьте доступ и сервисы, доступные для исследования.",
    idle: "Ещё не проверено",
    loading: "Выполняется проверка",
    failed: "Проверка не завершилась",
    unknown: "Неизвестно",
  },
};

const ACTION_LABEL: Record<"en" | "ru", Record<FeatureAction, string>> = {
  en: {
    refresh: "Refresh",
    signIn: "Sign in again",
    requestAccess: "Request project access",
    retry: "Check again",
    diagnostics: "Show diagnostics",
  },
  ru: {
    refresh: "Обновить",
    signIn: "Войти снова",
    requestAccess: "Запросить доступ к проекту",
    retry: "Проверить снова",
    diagnostics: "Показать диагностику",
  },
};
type RowAction = FeatureAction | null;

/** Native labelled facts; state is readable text rather than a repeated alert banner. */
interface RowView {
  readonly id: RowId;
  readonly label: string;
  readonly detail: string;
  readonly tone: StatusTone;
  readonly action: RowAction;
}

function en(locale: "en" | "ru", english: string, russian: string): string {
  return locale === "en" ? english : russian;
}

const PENDING_USE: readonly ConnectionsModelUseState[] =
  ["accepted", "preparing", "qualifying", "importing"];

/** Project one row from its own query state and its own fact. */
function project(
  locale: "en" | "ru",
  id: RowId,
  query: ConnectionsRowQuery,
  detail: string | null,
  tone: StatusTone,
  action: RowAction,
): RowView {
  const text = TEXT[locale];
  if (query === "idle") {
    return { id, label: LABEL[locale][id], detail: text.idle, tone: "neutral", action: "retry" };
  }
  if (query === "loading") {
    return { id, label: LABEL[locale][id], detail: text.loading, tone: "neutral", action: null };
  }
  if (query === "failed" || detail === null) {
    return { id, label: LABEL[locale][id], detail: text.failed, tone: "error", action: "retry" };
  }
  return { id, label: LABEL[locale][id], detail, tone, action };
}

function projectHealth(locale: "en" | "ru", health: ConnectionsHealth | undefined): string | null {
  if (health === undefined) return null;
  return en(locale,
    health.ready ? "Server answered" : "Server did not answer",
    health.ready ? "Сервер ответил" : "Сервер не ответил");
}

function projectSession(locale: "en" | "ru", session: ConnectionsSession | undefined): string | null {
  if (session === undefined) return null;
  return en(locale, "Signed in as owner", "Вход выполнен");
}

function projectGrants(locale: "en" | "ru", grants: readonly ConnectionsGrant[] | undefined): string | null {
  if (grants === undefined) return null;
  const active = grants.filter(function (grant) { return grant.state === "ACTIVE"; }).length;
  return en(locale,
    "Active grants: " + active,
    "Активных разрешений: " + active);
}

function projectProviderConfig(locale: "en" | "ru", config: ConnectionsProviderConfig | undefined): string | null {
  if (config === undefined) return null;
  if (config.status === "pending") {
    return en(locale, "Configuration pending", "Настройка ожидается");
  }
  if (config.status === "configured_not_qualified") {
    return en(locale, "Configured, not yet qualified", "Настроено, ещё не квалифицировано");
  }
  if (config.status === "outcome_unknown") {
    return en(locale, "Configuration outcome unknown", "Результат настройки неизвестен");
  }
  return en(locale, "Not configured", "Не настроено");
}

function projectProjectModel(locale: "en" | "ru", model: ConnectionsProjectModel | undefined): string | null {
  if (model === undefined) return null;
  if (model.selected === null) {
    return en(locale, "No model selected", "Модель не выбрана");
  }
  if (model.selected.qualification_state === "qualified") {
    return en(locale, "Model qualified", "Модель квалифицирована");
  }
  if (model.selected.qualification_state === "qualification_required") {
    return en(locale, "Qualification required", "Требуется квалификация");
  }
  return en(locale, "Model selected, qualification unknown", "Модель выбрана, квалификация неизвестна");
}

function projectProviderModelUse(locale: "en" | "ru", use: ConnectionsProviderModelUse | undefined): string | null {
  if (use === undefined) return null;
  if (use.state === "selected" && use.phase === "complete") {
    return en(locale, "Operation complete", "Операция завершена");
  }
  if (use.state === "blocked" || use.state === "conflict") {
    return en(locale, "Operation blocked", "Операция заблокирована");
  }
  if (use.state === "uncertain") {
    return en(locale, "Operation outcome uncertain", "Результат операции неизвестен");
  }
  if (PENDING_USE.indexOf(use.state) >= 0) {
    return en(locale, "Operation in progress", "Операция выполняется");
  }
  return en(locale, "Operation accepted", "Операция принята");
}

/**
 * Research readiness keeps the accepted three-state enum distinct: lazy_renewal permits a
 * run after renewal and is not the same as blocked. The six-value reason names the cause, and
 * the field lists say which configuration is missing or invalid.
 */
function projectReadiness(locale: "en" | "ru", readiness: ConnectionsReadiness | undefined): string | null {
  if (readiness === undefined) return null;
  const reason = readiness.readiness_reason;
  if (readiness.run_readiness === "ready") {
    return en(locale, "Ready to run", "Готово к запуску");
  }
  if (readiness.run_readiness === "lazy_renewal") {
    return en(locale,
      "Renewal at run: " + reason,
      "Обновление при запуске: " + reason);
  }
  const fields = readiness.missing_fields.length + readiness.invalid_fields.length;
  return en(locale,
    "Blocked, " + reason + ", fields: " + fields,
    "Заблокировано, " + reason + ", полей: " + fields);
}

/**
 * Google transport is the routing value carried by SystemHealth. A configured transport is
 * not a performed Google action, and an OAuth authorization URL is an action intent, never a
 * fact of authentication or connection. No URL or secret is rendered.
 */
function projectGoogleTransport(locale: "en" | "ru", input: ConnectionsRowInput): string | null {
  if (input.health === undefined) return null;
  const transport = input.health.google_external_transport;
  if (transport === undefined) {
    return en(locale, "Routing unknown", "Маршрутизация неизвестна");
  }
  if (transport === "disabled") {
    return en(locale, "Routing disabled", "Маршрутизация отключена");
  }
  return en(locale, "Routing: " + transport, "Маршрутизация: " + transport);
}

function projectDiagnostic(locale: "en" | "ru", diagnostic: ConnectionsDiagnostic | undefined): string | null {
  if (diagnostic === undefined) return null;
  if (diagnostic.status === "CONFIRMED") {
    return en(locale,
      "Client call observed, checked " + diagnostic.observed_at,
      "Вызов клиента зафиксирован, проверено " + diagnostic.observed_at);
  }
  if (diagnostic.status === "EXPIRED") {
    return en(locale, "Observation expired", "Наблюдение истекло");
  }
  return en(locale, "Challenge issued, awaiting callback", "Вызов выдан, ожидается ответ");
}

function deriveRows(locale: "en" | "ru", queries: ConnectionsRowQueries, input: ConnectionsRowInput): readonly RowView[] {
  const activeGrants = (input.grants ?? []).filter(function (grant) { return grant.state === "ACTIVE"; }).length;
  return ROW_IDS.map(function (id) {
    if (id === "health") {
      return project(locale, id, queries.health, projectHealth(locale, input.health),
        input.health?.ready === true ? "neutral" : "error", null);
    }
    if (id === "session") {
      return project(locale, id, queries.session, projectSession(locale, input.session), "neutral", null);
    }
    if (id === "grant") {
      return project(locale, id, queries.grant, projectGrants(locale, input.grants),
        activeGrants > 0 ? "neutral" : "error", activeGrants > 0 ? null : "requestAccess");
    }
    if (id === "providerConfig") {
      const configurations = input.providerConfigurations;
      const failed = configurations === undefined
        ? input.providerConfig?.status === "outcome_unknown" || input.providerConfig?.status === "not_configured"
        : configurations.some(config => config.status === "outcome_unknown");
      const detail = configurations === undefined ? projectProviderConfig(locale, input.providerConfig)
        : configurations.length === 0 ? en(locale, "Not configured", "Не настроено")
        : configurations.map(config => projectProviderConfig(locale, config)).join(" · ");
      return project(locale, id, queries.providerConfig, detail,
        failed ? "error" : "neutral", null);
    }
    if (id === "projectModel") {
      return project(locale, id, queries.projectModel, projectProjectModel(locale, input.projectModel),
        input.projectModel?.selected?.qualification_state === "qualified" ? "neutral" : "error", null);
    }
    if (id === "providerModelUse") {
      const state = input.providerModelUse?.state;
      const failed = state === "blocked" || state === "uncertain" || state === "conflict";
      return project(locale, id, queries.providerModelUse, projectProviderModelUse(locale, input.providerModelUse),
        failed ? "error" : "neutral", null);
    }
    if (id === "researchReadiness") {
      const readiness = input.readiness;
      const failed = readiness !== undefined && readiness.run_readiness === "blocked";
      return project(locale, id, queries.researchReadiness, projectReadiness(locale, readiness),
        failed ? "error" : "neutral", null);
    }
    if (id === "googleTransport") {
      // An explicit disabled routing is a valid configuration fact, not a failure. Only an
      // unknown routing value, or one that is not configured, is reported as a problem.
      const transport = input.health?.google_external_transport;
      const configured = transport !== undefined;
      return project(locale, id, queries.googleTransport, projectGoogleTransport(locale, input),
        configured ? "neutral" : "error", null);
    }
    return project(locale, id, queries.diagnostic, projectDiagnostic(locale, input.diagnostic), "neutral", "diagnostics");
  });
}
const ACTION_ORDER: readonly FeatureAction[] = ["refresh", "signIn", "requestAccess", "retry", "diagnostics"];

export function ConnectionsFeature({
  locale = "en",
  queries,
  health,
  session,
  grants,
  providerConfig,
  providerConfigurations,
  projectModel,
  providerModelUse,
  readiness,
  diagnostic,
  onRefresh,
  onSignIn,
  onRequestAccess,
  onRetry,
  onOpenDiagnostics,
}: ConnectionsFeatureProps) {
  const [disclosed, setDisclosed] = useState<boolean>(false);
  const text = TEXT[locale];
  const rows = deriveRows(locale, queries, {
    health,
    session,
    grants,
    providerConfig,
    providerConfigurations,
    projectModel,
    providerModelUse,
    readiness,
    diagnostic,
  });
  const headingId = useId();
  const handlers: Record<FeatureAction, (() => void) | undefined> = {
    refresh: onRefresh,
    signIn: onSignIn,
    requestAccess: onRequestAccess,
    retry: onRetry,
    diagnostics: onOpenDiagnostics,
  };
  const rowAction = function (action: RowAction): (() => void) | undefined {
    if (action === "signIn") return onSignIn;
    if (action === "requestAccess") return onRequestAccess;
    if (action === "retry") return onRetry;
    if (action === "diagnostics") return onOpenDiagnostics;
    return undefined;
  };
  return (
    <section className="connections-feature" aria-labelledby={headingId}>
      <h2 className="connections-feature__title" id={headingId}>{text.title}</h2>
      <p className="connections-feature__note">{text.note}</p>
      <ul className="connections-feature__rows">
        {rows.map(function (entry) {
          return (
            <li className="connections-feature__row" key={entry.id}>
              <span className="connections-feature__label">{entry.label}</span>
              <div className="connections-feature__row-content">
              <p className="connections-feature__detail" data-tone={entry.tone}>{entry.detail}</p>
              {/* An unsupported action is omitted entirely, never a decorative disabled control. */}
              {entry.action === null || rowAction(entry.action) === undefined ? null : (
                <Button
                  variant="text"
                  onClick={rowAction(entry.action)}
                >
                  {ACTION_LABEL[locale][entry.action]}
                </Button>
              )}
              </div>
            </li>
          );
        })}
      </ul>
      {disclosed ? (
        <dl className="connections-feature__diagnostics">
          <dt>{en(locale, "Diagnostic state", "Состояние диагностики")}</dt>
          <dd className="connections-feature__diagnostic-value">
            {diagnostic === undefined ? text.unknown : en(locale,
              diagnostic.status === "CONFIRMED" ? "Confirmed" : "Not confirmed",
              diagnostic.status === "CONFIRMED" ? "Подтверждено" : "Не подтверждено")}
          </dd>
        </dl>
      ) : null}
      <div className="connections-feature__actions">
        {ACTION_ORDER.map(function (action) {
          const run = handlers[action];
          if (run === undefined) return null;
          return (
            <Button key={action} variant="primary" loading={queries.health === "loading"} onClick={run}>
              {ACTION_LABEL[locale][action]}
            </Button>
          );
        })}
        <Button variant="text" onClick={function () { setDisclosed(function (value) { return !value; }); }}>
          {en(locale, "Details", "Подробности")}
        </Button>
      </div>
    </section>
  );
}

export { ROW_IDS };
