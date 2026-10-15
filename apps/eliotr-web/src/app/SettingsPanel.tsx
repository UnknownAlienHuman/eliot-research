import { useLayoutEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Field, Status } from "@eliotr/ui";
import type { ServiceModelProviderConnection, ServiceModelProviderCreateRequest, ServiceModelCatalogPage } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "./privacy";
import type { BoundWorkspaceApis } from "./runtime";
import { protectedQueryKey, runProtectedRead } from "../query/client";
import { serviceModelSettingsQueryOptions, configureGlobalModelProviderOnce, readGlobalModelProviderOperation,
  GlobalModelSettingsClosedError, GlobalModelProviderRefusedError } from "../query/globalModelSettings";

const copy = {
  en: { title: "Settings", intro: "Provider connections apply throughout Eliot Research.", cloudflare: "Cloudflare",
    builtin: "Built in · used by default", defaultModel: "Default model", indexing: "Source indexing: Cloudflare AI Search",
    unavailable: "External provider setup is unavailable on this server. Cloudflare remains built in.",
    bindingMissing: "Workers AI is unavailable in this deployment.", catalog: "Cloudflare model catalog",
    external: "External providers", connect: "Connect provider", name: "Connection name", provider: "Provider",
    compatible: "OpenAI-compatible provider", base: "API base URL", model: "Models (comma-separated IDs)", key: "API key",
    reading: "Reading settings…", failed: "Settings could not be read.", noConnections: "No external provider is connected.",
    configured: "Key stored in Cloudflare. Model availability has not been checked.", unknown: "The connection outcome is unknown. Read its saved status before submitting again.",
    invalid: "Check the provider, URL, model and key fields.", rejected: "Provider setup was rejected before a key was saved.",
    checking: "Reading saved status…", check: "Read saved status", saving: "Connecting…", truncated: "Some older connections are not shown.",
  },
  ru: { title: "Настройки", intro: "Подключения провайдеров действуют для всего Eliot Research.", cloudflare: "Cloudflare",
    builtin: "Встроен · используется по умолчанию", defaultModel: "Модель по умолчанию", indexing: "Индексация источников: Cloudflare AI Search",
    unavailable: "Подключение внешних провайдеров на сервере пока недоступно. Встроенные Cloudflare-модели остаются подключены.",
    bindingMissing: "В этом развёртывании Workers AI недоступен.", catalog: "Каталог моделей Cloudflare",
    external: "Внешние провайдеры", connect: "Подключить провайдера", name: "Название подключения", provider: "Провайдер",
    compatible: "Совместимый с OpenAI", base: "Базовый URL API", model: "Модели (идентификаторы через запятую)", key: "Ключ API",
    reading: "Читаем настройки…", failed: "Не удалось прочитать настройки.", noConnections: "Внешние провайдеры не подключены.",
    configured: "Ключ сохранён в Cloudflare. Доступность моделей пока не проверена.", unknown: "Результат подключения неизвестен. Проверьте сохранённый статус перед новой отправкой.",
    invalid: "Проверьте провайдера, URL, модели и ключ.", rejected: "Настройка отклонена до сохранения ключа.",
    checking: "Проверяем сохранённый статус…", check: "Проверить статус", saving: "Подключаем…", truncated: "Часть старых подключений не показана.",
  },
} as const;
type Feedback = "idle" | "saving" | "checking" | "configured" | "unknown" | "invalid" | "unavailable" | "rejected";
type ProviderKind = "openrouter" | "openai" | "anthropic" | "compatible";

/** Settings has only owner authority; no project selection or content grant participates. */
export function SettingsPanel({ locale, apis, privacy, context }: { readonly locale: "en" | "ru";
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext }) {
  const text = copy[locale], id = useId(), api = apis.settings.models;
  const settings = useQuery(serviceModelSettingsQueryOptions(api, privacy, context));
  const data = settings.data;
  const [providerKind, setProviderKind] = useState<ProviderKind>("openrouter");
  const [feedback, setFeedback] = useState<Feedback>("idle"), [busy, setBusy] = useState(false);
  const [heldOperation, setHeldOperation] = useState<string>();
  const [showCatalog, setShowCatalog] = useState(false);
  const formRef = useRef<HTMLFormElement>(null), controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false), running = useRef(false), held = useRef<string | undefined>(undefined);
  const current = () => mounted.current && privacy.isCurrent(context);
  const hold = (operation: string | undefined) => { held.current = operation; if (mounted.current) setHeldOperation(operation); };
  const catalog = useQuery<ServiceModelCatalogPage>({
    queryKey: [...protectedQueryKey(context, "service-model-catalog"), "cloudflare"],
    enabled: showCatalog && privacy.isCurrent(context),
    queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, readSignal =>
      apis.connections.models.readServiceModelCatalog(context.deploymentGeneration, {}, readSignal)),
  });

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

  function settle(connection: ServiceModelProviderConnection | undefined, operation: string) {
    if (!current()) return;
    if (connection?.status === "configured" || connection?.status === "failed_no_effect") {
      if (held.current === operation) hold(undefined);
      setFeedback(connection.status === "configured" ? "configured" : "rejected");
      void settings.refetch();
    } else setFeedback("unknown");
  }

  async function check(operation: string) {
    if (!current() || running.current) return;
    running.current = true; setBusy(true); setFeedback("checking");
    const selected = new AbortController(); controller.current = selected;
    try { settle(await readGlobalModelProviderOperation({ api, operationId: operation,
      generation: context.deploymentGeneration, signal: selected.signal, isCurrent: current }), operation); }
    catch (error) { if (!(error instanceof GlobalModelSettingsClosedError) && current()) setFeedback("unknown"); }
    finally { if (controller.current === selected) { controller.current = undefined; running.current = false; if (current()) setBusy(false); } }
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || running.current || held.current !== undefined || data?.external.management_available !== true ||
      data.external.state !== "ready") return;
    running.current = true; setBusy(true);
    const form = event.currentTarget, values = new FormData(form);
    const key = values.get("api_key"), name = values.get("display_name"), base = values.get("base_url"), models = values.get("model_ids");
    form.reset();
    const selected = new AbortController(); controller.current = selected;
    try {
      if (typeof key !== "string" || typeof name !== "string" || typeof models !== "string" ||
        (base !== null && typeof base !== "string")) { setFeedback("invalid"); return; }
      const displayName = name.trim() || (providerKind === "compatible" ? "" : providerKind);
      const baseUrl = typeof base === "string" ? base.trim() : "";
      let providerId: string = providerKind;
      if (providerKind === "compatible") {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${displayName}\n${baseUrl}`));
        providerId = `compatible-${Array.from(new Uint8Array(digest), part => part.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
      }
      if (selected.signal.aborted || !current()) throw new GlobalModelSettingsClosedError();
      const unresolved = data.external.connections.find(item => item.provider_id === providerId && item.status === "uncertain");
      if (unresolved) { hold(unresolved.operation_id); setFeedback("unknown"); return; }
      const operation = crypto.randomUUID(); hold(operation); setFeedback("saving");
      const request: ServiceModelProviderCreateRequest = { protocol: "eliotr.service-model-provider-create.v1", operation_id: operation,
        provider_id: providerId, display_name: displayName, model_ids: [...new Set(models.split(",").map(model => model.trim()).filter(Boolean))],
        api_key: key, ...(baseUrl === "" ? {} : { base_url: baseUrl }) };
      settle(await configureGlobalModelProviderOnce({ api, request, generation: context.deploymentGeneration,
        signal: selected.signal, isCurrent: current }), operation);
    } catch (error) {
      if (!current() || error instanceof GlobalModelSettingsClosedError) return;
      if (error instanceof GlobalModelProviderRefusedError) { hold(undefined); setFeedback(error.reason); }
      else setFeedback(held.current === undefined ? "invalid" : "unknown");
    } finally { if (controller.current === selected) { controller.current = undefined; running.current = false; if (current()) setBusy(false); } }
  }

  const canConnect = privacy.isCurrent(context) && data?.external.management_available === true && data.external.state === "ready" &&
    !busy && heldOperation === undefined;
  return <section aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{text.title}</h2><p>{text.intro}</p>
    <section aria-labelledby={`${id}-cloudflare`}>
      <h3 id={`${id}-cloudflare`}>{text.cloudflare}</h3><p>{text.builtin}</p><p>{text.indexing}</p>
      {data && <p>{text.defaultModel}: <code>{data.cloudflare.default_model_id}</code></p>}
      {data && !data.cloudflare.binding_available && <Status tone="error">{text.bindingMissing}</Status>}
      {settings.isPending && <Status announce>{text.reading}</Status>}
      {settings.isError && <Status tone="error" announce>{text.failed}</Status>}
      <details onToggle={event => setShowCatalog(event.currentTarget.open)}><summary>{text.catalog}</summary>
        {catalog.isFetching && <Status announce>{text.reading}</Status>}
        {catalog.isError && <Status tone="error" announce>{text.failed}</Status>}
        {catalog.data && <ul>{catalog.data.models.map(model => <li key={model.model_id}>{model.name} · <code>{model.model_id}</code></li>)}</ul>}
      </details>
    </section>
    <section aria-labelledby={`${id}-external`}>
      <h3 id={`${id}-external`}>{text.external}</h3>
      {data && (!data.external.management_available || data.external.state === "unavailable") && <Status>{text.unavailable}</Status>}
      {data?.external.truncated && <p>{text.truncated}</p>}
      {data?.external.state === "ready" && data.external.connections.length === 0 && <p>{text.noConnections}</p>}
      {data && <ul>{data.external.connections.map(connection => <li key={connection.operation_id}>
        <strong>{connection.display_name}</strong><p>{connection.model_ids.join(", ")}</p>
        <Status>{connection.status === "configured" ? text.configured : connection.status === "uncertain" ? text.unknown : text.rejected}</Status>
        {connection.status === "uncertain" && <Button variant="text" disabled={busy} onClick={() => { void check(connection.operation_id); }}>{text.check}</Button>}
      </li>)}</ul>}
      <form ref={formRef} method="post" onSubmit={event => { void connect(event); }}>
        <div className="er-field"><label className="er-field__label" htmlFor={`${id}-provider`}>{text.provider}</label>
          <select id={`${id}-provider`} className="er-field__control" value={providerKind} disabled={!canConnect}
            onChange={event => setProviderKind(event.target.value as ProviderKind)}>
            <option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option><option value="compatible">{text.compatible}</option>
          </select></div>
        <Field label={text.name} name="display_name" maxLength={128} required={providerKind === "compatible"} disabled={!canConnect} />
        {providerKind === "compatible" && <Field label={text.base} type="url" name="base_url" maxLength={2048} required disabled={!canConnect} />}
        <Field label={text.model} name="model_ids" maxLength={4096} required disabled={!canConnect} />
        <Field label={text.key} type="password" name="api_key" autoComplete="new-password" maxLength={4096} required disabled={!canConnect} />
        <Button variant="tonal" type="submit" disabled={!canConnect} loading={feedback === "saving"}>{feedback === "saving" ? text.saving : text.connect}</Button>
      </form>
      {feedback !== "idle" && feedback !== "saving" && <Status announce tone={feedback === "configured" ? "neutral" : "error"}>
        {feedback === "checking" ? text.checking : feedback === "configured" ? text.configured : feedback === "unknown" ? text.unknown
          : feedback === "unavailable" ? text.unavailable : feedback === "invalid" ? text.invalid : text.rejected}</Status>}
      {heldOperation && <Button variant="text" disabled={busy} onClick={() => { void check(heldOperation); }}>{text.check}</Button>}
    </section>
  </section>;
}
