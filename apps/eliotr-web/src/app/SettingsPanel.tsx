import { useLayoutEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Field, MaterialSymbol, Status } from "@eliotr/ui";
import type { PrivacyController, SessionContext } from "./privacy";
import type { BoundWorkspaceApis } from "./runtime";
import { ProviderModelCatalogSettings } from "./ProviderModelCatalogSettings";
import "./settings.css";
import { configureCatalogManagedProviderOnce, readGlobalCatalogManagedProviderOperation,
  serviceModelProvidersV2QueryOptions, serviceModelSettingsQueryOptions, GlobalModelProviderRefusedError,
  GlobalModelSettingsClosedError, type ServiceModelCatalogConnectRequest,
  type ServiceModelProviderConnectionV2 } from "../query/globalModelSettings";

const copy = {
  en: { title: "Settings", intro: "Provider connections apply throughout Eliot Research.", cloudflare: "Cloudflare",
    builtin: "Built in · used by default", defaultModel: "Default model", bindingMissing: "Workers AI is unavailable in this deployment.",
    catalog: "Cloudflare model catalog", external: "External providers", connect: "Connect provider", name: "Connection name",
    provider: "Provider", compatible: "OpenAI-compatible provider", base: "API base URL", key: "API key",
    keyHint: "Stored by the owner service; it is never shown again.", indexingLabel: "Source indexing", indexingValue: "Cloudflare AI Search",
    models: "Models", catalogManaged: "Models discovered from the provider catalog", explicitModels: "Explicit model list",
    connected: "Connected", pending: "Not confirmed", failedState: "Not connected", newProvider: "Connect a provider",
    reading: "Reading settings…", failed: "Settings could not be read.", providersFailed: "Provider connections could not be read.",
    noConnections: "No external provider is connected.", unavailable: "External provider setup is unavailable on this server. Cloudflare remains built in.",
    configured: "Provider connection is configured. Catalog listing does not establish account entitlement.",
    unknown: "The connection outcome is unknown. Read its saved status before submitting again.",
    invalid: "Check the provider, URL, name and key fields.", rejected: "Provider setup was rejected before a key was saved.",
    checking: "Reading saved status…", check: "Read saved status", saving: "Connecting and discovering models…",
    truncated: "Some older connections are not shown.",
  },
  ru: { title: "Настройки", intro: "Подключения провайдеров действуют для всего Eliot Research.", cloudflare: "Cloudflare",
    builtin: "Встроен · используется по умолчанию", defaultModel: "Модель по умолчанию", bindingMissing: "В этом развёртывании Workers AI недоступен.",
    catalog: "Каталог моделей Cloudflare", external: "Внешние провайдеры", connect: "Подключить провайдера", name: "Название подключения",
    provider: "Провайдер", compatible: "Совместимый с OpenAI", base: "Базовый URL API", key: "Ключ API",
    keyHint: "Хранится в сервисе владельца и больше не показывается.", indexingLabel: "Индексация источников", indexingValue: "Cloudflare AI Search",
    models: "Модели", catalogManaged: "Модели обнаруживаются в каталоге провайдера", explicitModels: "Явный список моделей",
    connected: "Подключён", pending: "Не подтверждён", failedState: "Не подключён", newProvider: "Подключить провайдера",
    reading: "Читаем настройки…", failed: "Не удалось прочитать настройки.", providersFailed: "Не удалось прочитать подключения провайдеров.",
    noConnections: "Внешние провайдеры не подключены.", unavailable: "Подключение внешних провайдеров на сервере пока недоступно. Встроенные Cloudflare-модели остаются подключены.",
    configured: "Подключение настроено. Запись в каталоге не подтверждает доступ аккаунта.",
    unknown: "Результат подключения неизвестен. Проверьте сохранённый статус перед новой попыткой.",
    invalid: "Проверьте провайдера, URL, название и ключ.", rejected: "Настройка отклонена до сохранения ключа.",
    checking: "Проверяем сохранённый статус…", check: "Проверить статус", saving: "Подключаем и обнаруживаем модели…",
    truncated: "Часть старых подключений не показана.",
  },
} as const;
type Feedback = "idle" | "saving" | "checking" | "configured" | "unknown" | "invalid" | "unavailable" | "rejected";
type ProviderKind = "openrouter" | "openai" | "anthropic" | "opencode-go" | "opencode-zen" | "compatible";

const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/inference/openai/v1";
const needsBaseUrl = (kind: ProviderKind): boolean => kind === "compatible" || kind === "opencode-go" || kind === "opencode-zen";
const defaultDisplayName = (kind: ProviderKind): string => ({ openrouter: "OpenRouter", openai: "OpenAI", anthropic: "Anthropic",
  "opencode-go": "OpenCode Go", "opencode-zen": "OpenCode Zen", compatible: "" })[kind];

/** Settings has only owner authority; no project selection or content grant participates. */
export function SettingsPanel({ locale, apis, privacy, context }: { readonly locale: "en" | "ru";
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext }) {
  const text = copy[locale], id = useId(), api = apis.settings.models;
  const settings = useQuery(serviceModelSettingsQueryOptions(api, privacy, context));
  const providers = useQuery(serviceModelProvidersV2QueryOptions(api, privacy, context));
  const data = settings.data;
  const [providerKind, setProviderKind] = useState<ProviderKind>("openrouter");
  const [feedback, setFeedback] = useState<Feedback>("idle"), [busy, setBusy] = useState(false);
  const [heldOperation, setHeldOperation] = useState<string>();
  const [showCloudflareCatalog, setShowCloudflareCatalog] = useState(false);
  const formRef = useRef<HTMLFormElement>(null), controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false), running = useRef(false), held = useRef<string | undefined>(undefined);
  const current = () => mounted.current && privacy.isCurrent(context);
  const hold = (operation: string | undefined) => { held.current = operation; if (mounted.current) setHeldOperation(operation); };

  useLayoutEffect(() => {
    mounted.current = true;
    formRef.current?.reset(); running.current = false; held.current = undefined;
    setHeldOperation(undefined); setBusy(false); setFeedback("idle");
    const close = () => {
      formRef.current?.reset();
      const active = controller.current; controller.current = undefined; active?.abort();
      running.current = false; held.current = undefined;
      if (mounted.current) { setHeldOperation(undefined); setFeedback("idle"); setBusy(false); }
    };
    const unsubscribe = privacy.subscribe(() => { if (!privacy.isCurrent(context)) close(); });
    return () => { mounted.current = false; unsubscribe(); close(); };
  }, [privacy, context]);

  function settle(connection: ServiceModelProviderConnectionV2 | undefined, operation: string) {
    if (!current()) return;
    if (connection?.status === "configured" || connection?.status === "failed_no_effect") {
      if (held.current === operation) hold(undefined);
      setFeedback(connection.status === "configured" ? "configured" : "rejected");
      void settings.refetch(); void providers.refetch();
    } else setFeedback("unknown");
  }

  async function check(operation: string) {
    if (!current() || running.current) return;
    running.current = true; setBusy(true); setFeedback("checking");
    const selected = new AbortController(); controller.current = selected;
    try {
      settle(await readGlobalCatalogManagedProviderOperation({ api, operationId: operation,
        generation: context.deploymentGeneration, signal: selected.signal, isCurrent: current }), operation);
    } catch (error) {
      if (!(error instanceof GlobalModelSettingsClosedError) && current()) setFeedback("unknown");
    } finally {
      if (controller.current === selected) { controller.current = undefined; running.current = false; if (current()) setBusy(false); }
    }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || running.current || held.current !== undefined || providers.data === undefined ||
      data?.external.management_available !== true || data.external.state !== "ready") return;
    running.current = true; setBusy(true);
    const form = event.currentTarget, values = new FormData(form);
    const key = values.get("api_key"), name = values.get("display_name"), base = values.get("base_url");
    form.reset();
    const selected = new AbortController(); controller.current = selected;
    try {
      if (typeof key !== "string" || typeof name !== "string" || (base !== null && typeof base !== "string")) {
        setFeedback("invalid"); return;
      }
      const displayName = name.trim() || defaultDisplayName(providerKind);
      const baseUrl = typeof base === "string" ? base.trim() : "";
      const effectiveBaseUrl = baseUrl || (providerKind === "opencode-go" ? OPENCODE_GO_BASE_URL
        : providerKind === "opencode-zen" ? OPENCODE_ZEN_BASE_URL : "");
      let providerId: string = providerKind;
      if (providerKind === "compatible") {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${displayName}\n${baseUrl}`));
        providerId = `compatible-${Array.from(new Uint8Array(digest), part => part.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
      }
      if (selected.signal.aborted || !current()) throw new GlobalModelSettingsClosedError();
      const unresolved = providers.data.connections.find(item => item.provider_id === providerId && item.status === "uncertain");
      if (unresolved) { hold(unresolved.operation_id); setFeedback("unknown"); return; }
      const operation = crypto.randomUUID(); hold(operation); setFeedback("saving");
      const request: ServiceModelCatalogConnectRequest = {
        protocol: "eliotr.service-model-provider-catalog-connect.v2", operation_id: operation,
        provider_id: providerId, display_name: displayName, model_registration_mode: "catalog_managed", api_key: key,
        ...(effectiveBaseUrl === "" ? {} : { base_url: effectiveBaseUrl }),
      };
      settle(await configureCatalogManagedProviderOnce({ api, request, generation: context.deploymentGeneration,
        signal: selected.signal, isCurrent: current }), operation);
    } catch (error) {
      if (!current() || error instanceof GlobalModelSettingsClosedError) return;
      if (error instanceof GlobalModelProviderRefusedError) { hold(undefined); setFeedback(error.reason); }
      else setFeedback(held.current === undefined ? "invalid" : "unknown");
    } finally {
      if (controller.current === selected) { controller.current = undefined; running.current = false; if (current()) setBusy(false); }
    }
  }

  const canConnect = privacy.isCurrent(context) && providers.isSuccess && data?.external.management_available === true &&
    data.external.state === "ready" && !busy && heldOperation === undefined;
  const connections = providers.data?.connections ?? [];
  return <section className="er-settings" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="er-settings__title">{text.title}</h2>
    <p className="er-settings__lead">{text.intro}</p>
    {(settings.isPending || providers.isPending) && <Status announce>{text.reading}</Status>}
    {(settings.isError || providers.isError) && <Status tone="error" announce>{settings.isError ? text.failed : text.providersFailed}</Status>}
    <section className="er-settings__group" aria-labelledby={`${id}-cloudflare`}>
      <header className="er-settings__head">
        <span className="er-settings__glyph" aria-hidden="true"><MaterialSymbol name="spark" /></span>
        <h3 id={`${id}-cloudflare`}>{text.cloudflare}</h3>
        <span className="er-settings__chip">{text.builtin}</span>
      </header>
      <dl className="er-settings__facts">
        {data && <div><dt>{text.defaultModel}</dt><dd><code>{data.cloudflare.default_model_id}</code></dd></div>}
        <div><dt>{text.indexingLabel}</dt><dd>{text.indexingValue}</dd></div>
      </dl>
      {data && !data.cloudflare.binding_available && <Status tone="error">{text.bindingMissing}</Status>}
      <details className="er-settings__more" onToggle={event => setShowCloudflareCatalog(event.currentTarget.open)}>
        <summary>{text.catalog}</summary>
        {showCloudflareCatalog && <ProviderModelCatalogSettings key="cloudflare-workers-ai" locale={locale} apis={apis}
          privacy={privacy} context={context} providerId="cloudflare-workers-ai" catalogProviderId="workers-ai" />}
      </details>
    </section>
    <section className="er-settings__group" aria-labelledby={`${id}-external`}>
      <header className="er-settings__head">
        <span className="er-settings__glyph" data-tone="secondary" aria-hidden="true"><MaterialSymbol name="link" /></span>
        <h3 id={`${id}-external`}>{text.external}</h3>
      </header>
      {data && (!data.external.management_available || data.external.state === "unavailable") && <Status>{text.unavailable}</Status>}
      {providers.data?.truncated && <p className="er-settings__note">{text.truncated}</p>}
      {data?.external.state === "ready" && providers.isSuccess && connections.length === 0 && <p className="er-settings__note">{text.noConnections}</p>}
      {connections.length > 0 && <ul className="er-settings__providers">{connections.map(connection => <li key={connection.operation_id} data-status={connection.status}>
        <span className="er-settings__provider-text">
          <strong>{connection.display_name}</strong>
          <span>{connection.model_registration_mode === "catalog_managed" ? text.catalogManaged
            : `${text.explicitModels}: ${connection.model_ids.join(", ")}`}</span>
        </span>
        <span className="er-settings__chip" data-status={connection.status} title={connection.status === "configured" ? text.configured : connection.status === "uncertain" ? text.unknown : text.rejected}>
          {connection.status === "configured" ? text.connected : connection.status === "uncertain" ? text.pending : text.failedState}</span>
        {connection.status === "uncertain" && <Button variant="text" disabled={busy} onClick={() => { void check(connection.operation_id); }}>{text.check}</Button>}
        {connection.status === "configured" && <ProviderModelCatalogSettings key={connection.operation_id} locale={locale} apis={apis}
          privacy={privacy} context={context} providerId={connection.provider_id} />}
      </li>)}</ul>}
      <form ref={formRef} className="er-settings__form" method="post" aria-label={text.newProvider} onSubmit={event => { void connect(event); }}>
        <h4>{text.newProvider}</h4>
        <div className="er-field"><label className="er-field__label" htmlFor={`${id}-provider`}>{text.provider}</label>
          <select id={`${id}-provider`} className="er-field__control" value={providerKind} disabled={!canConnect}
            onChange={event => setProviderKind(event.target.value as ProviderKind)}>
            <option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option><option value="opencode-go">OpenCode Go</option>
            <option value="opencode-zen">OpenCode Zen</option><option value="compatible">{text.compatible}</option>
          </select></div>
        <Field key={`${providerKind}-name`} label={text.name} name="display_name" maxLength={128}
          required={providerKind === "compatible"} disabled={!canConnect} defaultValue={defaultDisplayName(providerKind)} />
        {needsBaseUrl(providerKind) && <Field key={`${providerKind}-base`} label={text.base} type="url" name="base_url" maxLength={2048}
          required disabled={!canConnect} defaultValue={providerKind === "opencode-go" ? OPENCODE_GO_BASE_URL
            : providerKind === "opencode-zen" ? OPENCODE_ZEN_BASE_URL : undefined} />}
        <Field label={text.key} placeholder={text.keyHint} type="password" name="api_key" autoComplete="new-password" maxLength={4096} required disabled={!canConnect} />
        <div className="er-settings__actions">
          <Button variant="primary" icon="add" type="submit" disabled={!canConnect} loading={feedback === "saving"}>
            {feedback === "saving" ? text.saving : text.connect}
          </Button>
        </div>
      </form>
      {feedback !== "idle" && feedback !== "saving" && <Status announce tone={feedback === "configured" ? "neutral" : "error"}>
        {feedback === "checking" ? text.checking : feedback === "configured" ? text.configured : feedback === "unknown" ? text.unknown
          : feedback === "unavailable" ? text.unavailable : feedback === "invalid" ? text.invalid : text.rejected}</Status>}
      {heldOperation && <Button variant="text" disabled={busy} onClick={() => { void check(heldOperation); }}>{text.check}</Button>}
    </section>
  </section>;
}
