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
  readonly pendingActions?: Partial<Record<FeatureAction, boolean>>;
  readonly onSignIn?: () => void;
  readonly onRequestAccess?: () => void;
  readonly onRetry?: () => void;
  readonly onRetryRow?: (row: RowId) => void;
  readonly onOpenDiagnostics?: () => void;
}

/** A row's facts with its query state, ready for projection. */
export type ConnectionsRowInput = Omit<ConnectionsFeatureProps, "locale" | "queries">;

type FeatureAction = "signIn" | "requestAccess" | "retry" | "diagnostics" | "refresh";

const ROW_IDS: readonly RowId[] =
  ["health", "session", "grant", "providerConfig", "projectModel",
    "providerModelUse", "researchReadiness", "googleTransport", "diagnostic"];

/**
 * A state that reads as connected while nothing was performed is a false connection, so
 * every finish the decoder admits is mapped to words that claim only what happened.
 */
const TRANSPORT_TEXT: Record<ConnectionsGoogleTransport, Record<"en" | "ru", string>> = {
  "disabled": { en: "No Google routing is enabled on this deployment", ru: "Маршрутизация Google отключена в этом развёртывании" },
  "gemini-mcp": { en: "Google routing uses the Gemini MCP service", ru: "Маршрутизация Google использует сервис Gemini MCP" },
  "drive-exchange": { en: "Google routing uses Google Drive Exchange", ru: "Маршрутизация Google использует обмен с Google Drive" },
};

/** The session client classes the decoder admits, described without asserting trust. */
const CLIENT_CLASS_TEXT: Record<string, Record<"en" | "ru", string>> = {
  owner_pwa: { en: "Owner web application", ru: "Веб-приложение владельца" },
  named_api_client: { en: "Named API client", ru: "Именованный API-клиент" },
  trusted_agent: { en: "Trusted agent", ru: "Доверенный агент" },
  federation_client: { en: "Federation client", ru: "Федеративный клиент" },
};

/** Grant lifecycle from the contract. REVOKED is stated as revoked, never as missing. */
const GRANT_STATE_TEXT: Record<ConnectionsGrantState, Record<"en" | "ru", string>> = {
  ACTIVE: { en: "Active", ru: "Действует" },
  REVOKED: { en: "Revoked", ru: "Отозвано" },
};

const PROVIDER_STATUS_TEXT: Record<ConnectionsProviderStatus, Record<"en" | "ru", string>> = {
  pending: { en: "Configuration started, still being written", ru: "Настройка начата, ещё записывается" },
  configured_not_qualified: { en: "Configured, not yet qualified", ru: "Настроено, ещё не квалифицировано" },
  outcome_unknown: { en: "Configuration outcome is not confirmed", ru: "Результат настройки не подтверждён" },
  not_configured: { en: "No provider key configured", ru: "Ключ поставщика не настроен" },
};

const MODEL_USE_STATE_TEXT: Record<ConnectionsModelUseState, Record<"en" | "ru", string>> = {
  accepted: { en: "Operation accepted, work has not finished", ru: "Операция принята, работа не завершена" },
  preparing: { en: "Preparation in progress", ru: "Идёт подготовка" },
  qualifying: { en: "Qualification in progress", ru: "Идёт квалификация" },
  importing: { en: "Configuration import in progress", ru: "Идёт импорт настройки" },
  selected: { en: "Configuration selected", ru: "Настройка выбрана" },
  blocked: { en: "Operation blocked", ru: "Операция заблокирована" },
  uncertain: { en: "Operation outcome is not confirmed", ru: "Результат операции не подтверждён" },
  conflict: { en: "Operation conflicted with a newer selection", ru: "Операция конфликтует с более новой выборкой" },
};

const MODEL_USE_PHASE_TEXT: Record<ConnectionsModelUsePhase, Record<"en" | "ru", string>> = {
  intent: { en: "Requested", ru: "Запрошено" },
  native_prepare: { en: "Preparing the provider service", ru: "Подготовка сервиса поставщика" },
  free_price_check: { en: "Checking the price is free", ru: "Проверяем, что стоимость нулевая" },
  native_qualify: { en: "Qualifying the provider service", ru: "Квалификация сервиса поставщика" },
  configuration_import: { en: "Importing the configuration", ru: "Импорт настройки" },
  selection_readback: { en: "Reading the selection back", ru: "Читаем выбранную настройку" },
  complete: { en: "Finished", ru: "Завершено" },
};

const QUALIFICATION_TEXT: Record<ConnectionsQualificationState, Record<"en" | "ru", string>> = {
  qualified: { en: "Model qualified", ru: "Модель квалифицирована" },
  qualification_required: { en: "Qualification required", ru: "Требуется квалификация" },
};

const DIAGNOSTIC_STATUS_TEXT: Record<ConnectionsDiagnosticStatus, Record<"en" | "ru", string>> = {
  CONFIRMED: { en: "Client call observed, checked ", ru: "Вызов клиента зафиксирован, проверено " },
  EXPIRED: { en: "Observation expired", ru: "Наблюдение истекло" },
  ISSUED: { en: "Challenge issued, awaiting callback", ru: "Вызов выдан, ожидается ответ" },
};

const READINESS_REASON_TEXT: Record<ConnectionsReadinessReason, Record<"en" | "ru", string>> = {
  CONFIGURATION_NOT_READY: { en: "the configuration is incomplete", ru: "настройка неполная" },
  MODEL_TRANSPORT_UNAVAILABLE: { en: "the model transport is unavailable", ru: "транспорт модели недоступен" },
  QUALIFICATION_PROOFS_CURRENT: { en: "the qualification proofs are current", ru: "свидетельства квалификации актуальны" },
  QUALIFICATION_RENEWAL_AT_RUN: { en: "qualification is renewed at the moment the run starts", ru: "квалификация обновляется в момент запуска" },
  QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED: { en: "renewal needs a read token that was not supplied", ru: "для обновления нужен токен чтения, который не передан" },
  QUALIFICATION_UNAVAILABLE: { en: "qualification is unavailable", ru: "квалификация недоступна" },
};

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
    return { id, label: LABEL[locale][id], detail: text.idle, tone: "neutral", action: null };
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
  const described = CLIENT_CLASS_TEXT[session.client_class];
  // The client class names who is signed in. An unknown class is stated as unrecognised rather
  // than described as the owner client, because a wrong identity claim is a false connection.
  return described === undefined
    ? en(locale, "Signed in, client type not recognised", "Выполнен вход, тип клиента не распознан")
    : en(locale, "Signed in from " + described.en, "Выполнен вход из " + described.ru);
}

function projectGrants(locale: "en" | "ru", grants: readonly ConnectionsGrant[] | undefined): string | null {
  if (grants === undefined) return null;
  // Both lifecycle states are counted, so a REVOKED grant is never merged into a missing one.
  const active = grants.filter(function (grant) { return grant.state === "ACTIVE"; }).length;
  const revoked = grants.length - active;
  return en(locale,
    GRANT_STATE_TEXT.ACTIVE.en + ": " + active + ", " + GRANT_STATE_TEXT.REVOKED.en + ": " + revoked,
    GRANT_STATE_TEXT.ACTIVE.ru + ": " + active + ", " + GRANT_STATE_TEXT.REVOKED.ru + ": " + revoked);
}

function projectProviderConfig(locale: "en" | "ru", config: ConnectionsProviderConfig | undefined): string | null {
  if (config === undefined) return null;
  return PROVIDER_STATUS_TEXT[config.status][locale];
}

function projectProjectModel(locale: "en" | "ru", model: ConnectionsProjectModel | undefined): string | null {
  if (model === undefined) return null;
  if (model.selected === null) {
    return en(locale, "No model selected", "Модель не выбрана");
  }
  return QUALIFICATION_TEXT[model.selected.qualification_state][locale];
}

function projectProviderModelUse(locale: "en" | "ru", use: ConnectionsProviderModelUse | undefined): string | null {
  if (use === undefined) return null;
  // State and phase are separate facts: a selected operation still reports its phase, so the
  // row never collapses two values into one ambiguous word.
  const state = MODEL_USE_STATE_TEXT[use.state][locale];
  const phase = MODEL_USE_PHASE_TEXT[use.phase][locale];
  if (use.state === "selected" && use.phase === "complete") {
    return state;
  }
  return state + en(locale, ", stage: ", ", этап: ") + phase;
}

/**
 * Research readiness keeps the accepted three-state enum distinct: lazy_renewal permits a
 * run after renewal and is not the same as blocked. The six-value reason names the cause, and
 * the field lists say which configuration is missing or invalid.
 */
function projectReadiness(locale: "en" | "ru", readiness: ConnectionsReadiness | undefined): string | null {
  if (readiness === undefined) return null;
  const reason = READINESS_REASON_TEXT[readiness.readiness_reason][locale];
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
  return TRANSPORT_TEXT[transport][locale];
}

function projectDiagnostic(locale: "en" | "ru", diagnostic: ConnectionsDiagnostic | undefined): string | null {
  if (diagnostic === undefined) return null;
  const label = DIAGNOSTIC_STATUS_TEXT[diagnostic.status][locale];
  return diagnostic.status === "CONFIRMED" ? label + diagnostic.observed_at : label;
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
  pendingActions,
  onSignIn,
  onRequestAccess,
  onRetry,
  onRetryRow,
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
  const primaryAction = ACTION_ORDER.find(action => handlers[action] !== undefined);
  const rowAction = function (action: RowAction, id: RowId): (() => void) | undefined {
    if (action === "signIn") return onSignIn;
    if (action === "requestAccess") return onRequestAccess;
    if (action === "retry") return queries[id] === "failed" ? onRetryRow ? () => onRetryRow(id) : onRetry : undefined;
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
              {entry.action === null || rowAction(entry.action, entry.id) === undefined ? null : (
                <Button
                  variant="text"
                  onClick={rowAction(entry.action, entry.id)}
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
            <Button key={action} variant={action === primaryAction ? "primary" : "tonal"} loading={pendingActions?.[action] ?? false} onClick={run}>
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
