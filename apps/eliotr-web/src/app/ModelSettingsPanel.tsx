import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { skipToken, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { researchModelCatalogAdapterForRouteProvider, type ProjectListView } from "@eliotr/owner-api-client";
import { Button, Field, Status } from "@eliotr/ui";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { bindModelSettingsSecretLifetime, configureProviderKeyOnceAndReadBack, ModelSettingsProviderKeyUnavailableError } from "../query/modelSettingsLifecycle";
import { modelCatalogQueryOptions } from "../query/modelSettings";

type ProjectModelConfiguration = Awaited<ReturnType<BoundWorkspaceApis["connections"]["models"]["readResearchProjectModelConfiguration"]>>;
type ProviderKeyPage = Awaited<ReturnType<BoundWorkspaceApis["connections"]["providers"]["readResearchProviderKeyConfigurations"]>>;
type ProviderKeyConfiguration = ProviderKeyPage["configurations"][number];
type ModelRevision = ProjectModelConfiguration["revisions"][number];
type ModelCatalogPage = Awaited<ReturnType<BoundWorkspaceApis["connections"]["models"]["readResearchModelCatalog"]>>;
type ModelCatalogEntry = ModelCatalogPage["models"][number];
type ModelSource = "workers-ai" | "external";

type KeyFeedback =
  | { readonly kind: "idle" }
  | { readonly kind: "invalid" }
  | { readonly kind: "saving" }
  | { readonly kind: "unknown"; readonly operationId: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "readback"; readonly configuration: ProviderKeyConfiguration };
type SelectionFeedback =
  | { readonly kind: "idle" }
  | { readonly kind: "saving"; readonly configurationRef: string }
  | { readonly kind: "unknown"; readonly configurationRef: string }
  | { readonly kind: "confirmed"; readonly configurationRef: string };

const WORKERS_AI_ROUTE_PROVIDER_ID = "workers-ai";
const OPENROUTER_PROVIDER_ID: ProviderKeyPage["provider_id"] = "openrouter";

const copy = {
  en: {
    title: "Model settings",
    intro: "Workers AI remains the tests and default path. External models are configured for heavier work. Only a saved configuration marked qualified can be selected.",
    source: "Model path",
    workers: "Workers AI · tests and default",
    external: "External model · heavier work",
    keyTitle: "OpenRouter key",
    keyHint: "The key is sent once to the owner service, then cleared from this form. It is not shown again.",
    keyLabel: "API key",
    saveKey: "Save key",
    savingKey: "Saving key…",
    checkKey: "Check saved status",
    keyNotConfigured: "No OpenRouter key is configured for this project.",
    keyInputInvalid: "Enter a valid provider key.",
    keyConfigured: "Key configured; model qualification is separate.",
    keyReading: "Reading provider key status…",
    keyReadFailed: "Provider key status could not be read; configuration is unknown.",
    keyPending: "Key setup is pending. Check its saved status before trying again.",
    keyUnknown: "Key setup outcome is unknown. Check the saved status; the write will not be repeated.",
    keyUnavailable: "The server does not accept provider keys yet. Configure the server management connection, then save the key again.",
    keyInvalid: "The saved key was rejected. Check the key and submit it again.",
    keyPreflight: "The provider check did not confirm this key. The model remains unavailable.",
    keyAlias: "Key setup needs reconciliation. Check the saved status.",
    keyHttp: "Provider check returned HTTP",
    keyIncomplete: "The provider status list is incomplete, so configuration is unknown.",
    catalogTitle: "Model catalog",
    catalogIntro: "Catalog presence does not prove account access or qualification.",
    loadCatalog: "Load catalog",
    loadingCatalog: "Loading catalog…",
    catalogLoading: "Loading the selected model catalog.",
    catalogFailed: "The model catalog could not be read.",
    catalogEmpty: "No models were returned for this catalog page.",
    listedUnverified: "Listed · account access unverified",
    listedUnknown: "Listed · account access unknown",
    moreModels: "Next catalog page",
    configurationsTitle: "Saved model configurations",
    configurationsLoading: "Reading saved model configurations.",
    configurationsFailed: "Saved model configurations could not be read.",
    noConfigurations: "No saved configurations are available for this path.",
    qualified: "Qualified",
    qualificationRequired: "Not qualified",
    selected: "Selected",
    select: "Use this configuration",
    selecting: "Saving selection…",
    checkSelection: "Check selection status",
    selectionUnknown: "Selection is not confirmed. Read the saved configuration before trying again.",
    selectionConfirmed: "Selection confirmed by saved configuration readback.",
    selectionFailed: "Selection could not be confirmed. Review the saved configuration status.",
    requiresKey: "Configure an OpenRouter key before selecting an external configuration.",
    unqualifiedGap: "This model is listed, but no qualified saved configuration is available. Qualification is unavailable through the current model API.",
    noMatch: "This catalog entry has no matching saved qualified configuration, so it cannot be selected yet.",
    stages: "Research stages",
    modelMore: "More saved configurations are available; this page shows the current bounded result.",
    providerStatus: "Provider status",
  },
  ru: {
    title: "Настройки моделей",
    intro: "Workers AI остаётся путём для тестов и настроек по умолчанию. Внешние модели предназначены для более тяжёлых задач. Выбрать можно только сохранённую конфигурацию со статусом «квалифицирована».",
    source: "Путь модели",
    workers: "Workers AI · тесты и настройки по умолчанию",
    external: "Внешняя модель · сложные задачи",
    keyTitle: "Ключ OpenRouter",
    keyHint: "Ключ отправляется один раз в сервис владельца, затем поле очищается. Повторно ключ не показывается.",
    keyLabel: "Ключ API",
    saveKey: "Сохранить ключ",
    savingKey: "Сохранение ключа…",
    checkKey: "Проверить сохранённый статус",
    keyNotConfigured: "Для этого проекта ключ OpenRouter не настроен.",
    keyInputInvalid: "Введите корректный ключ провайдера.",
    keyConfigured: "Ключ настроен; квалификация модели выполняется отдельно.",
    keyReading: "Читается статус ключа провайдера…",
    keyReadFailed: "Не удалось прочитать статус ключа провайдера; настройка неизвестна.",
    keyPending: "Настройка ключа ожидает завершения. Проверьте статус перед новой попыткой.",
    keyUnknown: "Результат настройки ключа неизвестен. Проверьте сохранённый статус; запись не будет повторена.",
    keyUnavailable: "Сервер пока не принимает ключи провайдера. Настройте серверное подключение управления и сохраните ключ снова.",
    keyInvalid: "Сохранённый ключ отклонён. Проверьте его и отправьте снова.",
    keyPreflight: "Проверка провайдера не подтвердила ключ. Модель недоступна.",
    keyAlias: "Настройка ключа требует сверки. Проверьте сохранённый статус.",
    keyHttp: "Проверка провайдера вернула HTTP",
    keyIncomplete: "Список статусов провайдера неполон, поэтому настройка неизвестна.",
    catalogTitle: "Каталог моделей",
    catalogIntro: "Наличие в каталоге не подтверждает доступ к аккаунту или квалификацию.",
    loadCatalog: "Загрузить каталог",
    loadingCatalog: "Загрузка каталога…",
    catalogLoading: "Загружается выбранный каталог моделей.",
    catalogFailed: "Не удалось прочитать каталог моделей.",
    catalogEmpty: "На этой странице каталога нет моделей.",
    listedUnverified: "В каталоге · доступ аккаунта не проверен",
    listedUnknown: "В каталоге · доступ аккаунта неизвестен",
    moreModels: "Следующая страница каталога",
    configurationsTitle: "Сохранённые конфигурации моделей",
    configurationsLoading: "Читаются сохранённые конфигурации моделей.",
    configurationsFailed: "Не удалось прочитать сохранённые конфигурации моделей.",
    noConfigurations: "Для этого пути нет сохранённых конфигураций.",
    qualified: "Квалифицирована",
    qualificationRequired: "Не квалифицирована",
    selected: "Выбрана",
    select: "Использовать эту конфигурацию",
    selecting: "Сохранение выбора…",
    checkSelection: "Проверить статус выбора",
    selectionUnknown: "Выбор не подтверждён. Прочитайте сохранённую конфигурацию перед новой попыткой.",
    selectionConfirmed: "Выбор подтверждён чтением сохранённой конфигурации.",
    selectionFailed: "Не удалось подтвердить выбор. Проверьте статус сохранённой конфигурации.",
    requiresKey: "Перед выбором внешней конфигурации настройте ключ OpenRouter.",
    unqualifiedGap: "Модель есть в каталоге, но сохранённой квалифицированной конфигурации нет. Текущий API моделей не поддерживает её квалификацию.",
    noMatch: "Для этой записи каталога нет сохранённой квалифицированной конфигурации, поэтому выбрать её пока нельзя.",
    stages: "Этапы исследования",
    modelMore: "Есть другие сохранённые конфигурации; показан текущий ограниченный результат.",
    providerStatus: "Статус провайдера",
  },
} as const;

function keyConfigurationFromPage(page: ProviderKeyPage | undefined): ProviderKeyConfiguration | undefined {
  return page?.configurations.filter(configuration => configuration.status === "configured_not_qualified")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
}

function keyStatusText(locale: "en" | "ru", query: UseQueryResult<ProviderKeyPage, Error>, feedback: KeyFeedback): string {
  const text = copy[locale];
  if (feedback.kind === "invalid") return text.keyInputInvalid;
  if (feedback.kind === "saving") return text.savingKey;
  if (feedback.kind === "unavailable") return text.keyUnavailable;
  if (feedback.kind === "unknown") return text.keyUnknown;
  if (feedback.kind === "readback") {
    const { configuration } = feedback;
    if (configuration.status === "configured_not_qualified") return text.keyConfigured;
    if (configuration.status === "pending") return text.keyPending;
    if (configuration.status === "outcome_unknown") return text.keyUnknown;
    if (configuration.failure_code === "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID") return text.keyInvalid;
    if (configuration.failure_code === "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT") return text.keyAlias;
    if (configuration.provider_http_status !== null) return `${text.keyHttp} ${configuration.provider_http_status}.`;
    return text.keyPreflight;
  }
  if (query.isPending) return text.keyReading;
  if (query.isError || query.data === undefined) return text.keyReadFailed;
  const page = query.data;
  if (keyConfigurationFromPage(page)) return text.keyConfigured;
  if (page?.configurations.some(configuration => configuration.status === "pending")) return text.keyPending;
  if (page?.configurations.some(configuration => configuration.status === "outcome_unknown")) return text.keyUnknown;
  if (page?.truncated) return text.keyIncomplete;
  if (page?.configurations.some(configuration => configuration.failure_code === "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID")) return text.keyInvalid;
  if (page?.configurations.some(configuration => configuration.failure_code === "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT")) return text.keyAlias;
  const latestFailure = page?.configurations.filter(configuration => configuration.status === "not_configured")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
  if (latestFailure?.provider_http_status !== null && latestFailure?.provider_http_status !== undefined) {
    return `${text.keyHttp} ${latestFailure.provider_http_status}.`;
  }
  if (latestFailure) return text.keyPreflight;
  return text.keyNotConfigured;
}

function hasExternalModel(revision: ModelRevision): boolean {
  return revision.model_selections.some(selection => selection.provider_id !== WORKERS_AI_ROUTE_PROVIDER_ID);
}

function revisionsForSource(revisions: readonly ModelRevision[], source: ModelSource): readonly ModelRevision[] {
  return revisions.filter(revision => source === "external" ? hasExternalModel(revision) : !hasExternalModel(revision));
}

function matchingRevisions(revisions: readonly ModelRevision[], entry: ModelCatalogEntry, source: ModelSource): readonly ModelRevision[] {
  return revisionsForSource(revisions, source).filter(revision =>
    revision.model_selections.some(selection => selection.model_id === entry.model_id &&
      researchModelCatalogAdapterForRouteProvider(selection.provider_id) === entry.provider_id));
}

export function ModelSettingsPanel({
  locale, apis, privacy, context, projectPage, projectId, projectQueryKey, providers, models,
}: {
  readonly locale: "en" | "ru";
  readonly apis: BoundWorkspaceApis;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly projectPage: ProjectListView;
  readonly projectId: string;
  readonly projectQueryKey: readonly unknown[];
  readonly providers: UseQueryResult<ProviderKeyPage, Error>;
  readonly models: UseQueryResult<ProjectModelConfiguration, Error>;
}) {
  const text = copy[locale];
  const queryClient = useQueryClient();
  const currentProjects = () => queryClient.getQueryData<ProjectListView>(projectQueryKey);
  const sourceId = useId();
  const formRef = useRef<HTMLFormElement | null>(null);
  const keyController = useRef<AbortController | null>(null);
  const selectionController = useRef<AbortController | null>(null);
  const [source, setSource] = useState<ModelSource>("workers-ai");
  const [catalogRequested, setCatalogRequested] = useState(false);
  const [catalogPage, setCatalogPage] = useState(1);
  const [keyFeedback, setKeyFeedback] = useState<KeyFeedback>({ kind: "idle" });
  const [selectionFeedback, setSelectionFeedback] = useState<SelectionFeedback>({ kind: "idle" });
  const active = projectPage.projects.some(project => project.project_id === projectId) &&
    projectPage.deployment_generation === context.deploymentGeneration;
  const providerId = source === "workers-ai" ? WORKERS_AI_ROUTE_PROVIDER_ID
    : providers.data?.provider_id ?? OPENROUTER_PROVIDER_ID;
  const catalogOptions = modelCatalogQueryOptions(apis.connections.models, privacy, context,
    currentProjects, projectPage, projectId, providerId, catalogPage);
  const catalog = useQuery(catalogRequested && active ? catalogOptions : {
    queryKey: catalogOptions.queryKey,
    queryFn: skipToken,
  });
  const configuredExternalKey = !providers.isError && (keyConfigurationFromPage(providers.data) !== undefined ||
    (keyFeedback.kind === "readback" && keyFeedback.configuration.status === "configured_not_qualified"));
  const providerOperationPending = providers.data?.configurations.some(configuration =>
    configuration.status === "pending" || configuration.status === "outcome_unknown") === true;
  const keyWriteBlocked = providers.isPending || providers.isError || providers.data?.truncated === true || providerOperationPending ||
    keyFeedback.kind === "saving" || keyFeedback.kind === "unknown" ||
    keyFeedback.kind === "readback" && ["pending", "outcome_unknown"].includes(keyFeedback.configuration.status);
  const keyNeedsReadback = keyFeedback.kind === "unknown" || providers.isError || providerOperationPending ||
    keyFeedback.kind === "readback" && ["pending", "outcome_unknown"].includes(keyFeedback.configuration.status) ||
    providers.data?.configurations.some(configuration => configuration.status === "pending" || configuration.status === "outcome_unknown") === true;
  const currentSelectionRevision = models.data?.selection_revision ?? null;
  const revisions = models.data?.revisions ?? [];
  const visibleRevisions = revisionsForSource(revisions, source);
  const canAct = active && privacy.isCurrent(context);

  useEffect(() => bindModelSettingsSecretLifetime(privacy, context,
    () => {
      formRef.current?.reset();
      setKeyFeedback({ kind: "idle" });
      setSelectionFeedback({ kind: "idle" });
      setCatalogRequested(false);
    },
    () => {
      keyController.current?.abort();
      selectionController.current?.abort();
      keyController.current = null;
      selectionController.current = null;
    }), [privacy, context]);

  function changeSource(value: string) {
    if (value !== "workers-ai" && value !== "external") return;
    setSource(value);
    setCatalogRequested(false);
    setCatalogPage(1);
    if (selectionFeedback.kind !== "unknown" && selectionFeedback.kind !== "saving") setSelectionFeedback({ kind: "idle" });
  }

  async function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAct || keyController.current !== null) return;
    const form = event.currentTarget;
    const submitted = new FormData(form).get("provider_key");
    if (typeof submitted !== "string" || !apis.connections.providers.isResearchProviderKeyInputValid(submitted)) {
      form.reset();
      setKeyFeedback({ kind: "invalid" });
      return;
    }

    const operationId = crypto.randomUUID();
    const controller = new AbortController();
    keyController.current = controller;
    form.reset();
    setKeyFeedback({ kind: "saving" });
    try {
      const configuration = await configureProviderKeyOnceAndReadBack({
        providers: apis.connections.providers,
        projectId,
        deploymentGeneration: context.deploymentGeneration,
        operationId,
        providerKey: submitted,
        signal: controller.signal,
        isCurrent: () => privacy.isCurrent(context) && currentProjects() === projectPage && active,
      });
      if (!controller.signal.aborted && privacy.isCurrent(context) && currentProjects() === projectPage) {
        setKeyFeedback(configuration === undefined ? { kind: "unknown", operationId } : { kind: "readback", configuration });
        await providers.refetch();
      }
    } catch (error) {
      if (!controller.signal.aborted && privacy.isCurrent(context) && currentProjects() === projectPage) {
        setKeyFeedback(error instanceof ModelSettingsProviderKeyUnavailableError ? { kind: "unavailable" } : { kind: "unknown", operationId });
      }
    } finally {
      if (keyController.current === controller) keyController.current = null;
    }
  }

  async function checkKeyStatus() {
    if (!canAct || keyController.current !== null) return;
    if (keyFeedback.kind !== "unknown") {
      await providers.refetch();
      return;
    }
    const operationId = keyFeedback.operationId;
    const controller = new AbortController();
    keyController.current = controller;
    try {
      const page = await apis.connections.providers.readResearchProviderKeyConfigurations(projectId,
        context.deploymentGeneration, controller.signal, operationId);
      if (privacy.isCurrent(context) && currentProjects() === projectPage) {
        const configuration = page.configurations.find(item => item.operation_id === operationId);
        setKeyFeedback(configuration ? { kind: "readback", configuration } : { kind: "unknown", operationId });
        await providers.refetch();
      }
    } catch {
      if (!controller.signal.aborted && privacy.isCurrent(context) && currentProjects() === projectPage) {
        setKeyFeedback({ kind: "unknown", operationId });
      }
    } finally {
      if (keyController.current === controller) keyController.current = null;
    }
  }

  async function selectConfiguration(revision: ModelRevision) {
    if (!canAct || revision.qualification_state !== "qualified" || selectionController.current !== null || selectionFeedback.kind === "unknown" ||
        (source === "external" && !configuredExternalKey)) return;
    const controller = new AbortController();
    const configurationRef = revision.configuration_ref;
    const operationId = crypto.randomUUID();
    selectionController.current = controller;
    setSelectionFeedback({ kind: "saving", configurationRef });
    try {
      const receipt = await apis.connections.models.selectResearchProjectModelConfiguration(projectId,
        context.deploymentGeneration, currentSelectionRevision, configurationRef, operationId, controller.signal);
      if (controller.signal.aborted || !privacy.isCurrent(context) || currentProjects() !== projectPage) return;
      const readback = await models.refetch();
      if (controller.signal.aborted || !privacy.isCurrent(context) || currentProjects() !== projectPage) return;
      const observed = readback.data;
      setSelectionFeedback(observed?.selection_revision === receipt.selection_revision &&
        observed.selected?.configuration_ref === configurationRef && observed.selected?.qualification_state === "qualified"
        ? { kind: "confirmed", configurationRef }
        : { kind: "unknown", configurationRef });
    } catch {
      if (controller.signal.aborted || !privacy.isCurrent(context) || currentProjects() !== projectPage) return;
      const readback = await models.refetch();
      if (controller.signal.aborted || !privacy.isCurrent(context) || currentProjects() !== projectPage) return;
      setSelectionFeedback(readback.data?.selected?.configuration_ref === configurationRef &&
        readback.data?.selected?.qualification_state === "qualified"
        ? { kind: "confirmed", configurationRef }
        : { kind: "unknown", configurationRef });
    } finally {
      if (selectionController.current === controller) selectionController.current = null;
    }
  }

  async function checkSelectionStatus() {
    if (!canAct || selectionFeedback.kind !== "unknown") return;
    const configurationRef = selectionFeedback.configurationRef;
    const readback = await models.refetch();
    if (!privacy.isCurrent(context) || currentProjects() !== projectPage) return;
    setSelectionFeedback(readback.data?.selected?.configuration_ref === configurationRef &&
      readback.data?.selected?.qualification_state === "qualified"
      ? { kind: "confirmed", configurationRef }
      : { kind: "unknown", configurationRef });
  }

  function configurationLabel(revision: ModelRevision): string {
    return revision.model_selections.map(selection => `${selection.stage.replaceAll("_", " ")}: ${selection.model_id}`).join(" · ");
  }

  const selected = models.data?.selected;
  const catalogEntries = catalog.data?.models ?? [];
  const nextCatalogPage = catalog.data?.pagination.next_page ?? null;
  const candidateHasQualifiedConfiguration = (entry: ModelCatalogEntry) => matchingRevisions(revisions, entry, source)
    .some(revision => revision.qualification_state === "qualified");
  const candidateHasUnqualifiedConfiguration = (entry: ModelCatalogEntry) => matchingRevisions(revisions, entry, source)
    .some(revision => revision.qualification_state === "qualification_required");

  return <section aria-labelledby={`${sourceId}-title`}>
    <h2 id={`${sourceId}-title`}>{text.title}</h2>
    <p>{text.intro}</p>
    <div className="er-field">
      <label className="er-field__label" htmlFor={`${sourceId}-source`}>{text.source}</label>
      <select id={`${sourceId}-source`} className="er-field__control" value={source} onChange={event => changeSource(event.target.value)}>
        <option value="workers-ai">{text.workers}</option>
        <option value="external">{text.external} (OpenRouter)</option>
      </select>
    </div>

    {source === "external" && <section aria-labelledby={`${sourceId}-key-title`}>
      <h3 id={`${sourceId}-key-title`}>{text.keyTitle}</h3>
      <p>{text.keyHint}</p>
      <Status tone={keyFeedback.kind === "invalid" || keyFeedback.kind === "unavailable" || providers.isError ? "error" : "neutral"} announce>{`${text.providerStatus}: ${keyStatusText(locale, providers, keyFeedback)}`}</Status>
      {keyNeedsReadback && <Button variant="text" onClick={() => { void checkKeyStatus(); }} disabled={!canAct}>{text.checkKey}</Button>}
      <form ref={formRef} method="post" onSubmit={event => { void saveKey(event); }}>
        <Field label={text.keyLabel} type="password" name="provider_key" autoComplete="new-password" maxLength={4096}
          required disabled={!canAct || keyWriteBlocked}
          onChange={() => { if (keyFeedback.kind === "invalid") setKeyFeedback({ kind: "idle" }); }} />
        <Button variant="tonal" type="submit" loading={keyFeedback.kind === "saving"} disabled={!canAct || keyWriteBlocked}>{keyFeedback.kind === "saving" ? text.savingKey : text.saveKey}</Button>
      </form>
    </section>}

    <section aria-labelledby={`${sourceId}-catalog-title`}>
      <h3 id={`${sourceId}-catalog-title`}>{text.catalogTitle}</h3>
      <p>{text.catalogIntro}</p>
      {!catalogRequested && <Button variant="text" onClick={() => { setCatalogRequested(true); setCatalogPage(1); }} disabled={!canAct}>{text.loadCatalog}</Button>}
      {catalogRequested && catalog.isPending && <Status announce>{text.loadingCatalog}</Status>}
      {catalogRequested && catalog.isError && <Status tone="error" announce>{text.catalogFailed}</Status>}
      {catalogRequested && catalog.data && <>
        {catalog.data.models.length === 0 && <p>{text.catalogEmpty}</p>}
        <ul>
          {catalogEntries.map(entry => {
            const hasQualified = candidateHasQualifiedConfiguration(entry);
            const hasUnqualified = candidateHasUnqualifiedConfiguration(entry);
            return <li key={`${entry.provider_id}:${entry.model_id}`}>
              <strong>{entry.name}</strong>
              <span> — {entry.description}</span>
              <Status>{entry.account_availability === "unverified" ? text.listedUnverified : text.listedUnknown}</Status>
              {hasQualified ? <Status>{text.qualified}</Status>
                : <Status>{hasUnqualified ? text.unqualifiedGap : text.noMatch}</Status>}
            </li>;
          })}
        </ul>
        {nextCatalogPage !== null && <Button variant="text" onClick={() => setCatalogPage(nextCatalogPage)} disabled={!canAct}>{text.moreModels}</Button>}
      </>}
    </section>

    <section aria-labelledby={`${sourceId}-config-title`}>
      <h3 id={`${sourceId}-config-title`}>{text.configurationsTitle}</h3>
      {models.isPending && <Status announce>{text.configurationsLoading}</Status>}
      {models.isError && <Status tone="error" announce>{text.configurationsFailed}</Status>}
      {models.data && visibleRevisions.length === 0 && <p>{text.noConfigurations}</p>}
      {selected && <p><Status announce>{selected.qualification_state === "qualified" ? text.selected : text.qualificationRequired}</Status> {selected.model_selections.map(item => item.model_id).join(" · ")}</p>}
      {models.data && <ul>
        {visibleRevisions.map(revision => {
          const isSelected = selected?.configuration_ref === revision.configuration_ref &&
            models.data?.selection_revision !== null;
          const isBusy = selectionFeedback.kind === "saving" && selectionFeedback.configurationRef === revision.configuration_ref;
          const canSelect = revision.qualification_state === "qualified" && !isSelected &&
            (source !== "external" || configuredExternalKey);
          return <li key={revision.configuration_ref}>
            <Status announce={isSelected}>{isSelected ? text.selected : revision.qualification_state === "qualified" ? text.qualified : text.qualificationRequired}</Status>
            <p>{text.stages}: {configurationLabel(revision)}</p>
            {canSelect && <Button variant="tonal" onClick={() => { void selectConfiguration(revision); }} loading={isBusy} disabled={!canAct || selectionController.current !== null || selectionFeedback.kind === "unknown"}>{isBusy ? text.selecting : text.select}</Button>}
            {source === "external" && !configuredExternalKey && revision.qualification_state === "qualified" && <p>{text.requiresKey}</p>}
          </li>;
        })}
      </ul>}
      {models.data?.next_cursor && <p>{text.modelMore}</p>}
      {selectionFeedback.kind === "unknown" && <>
        <Status tone="error" announce>{text.selectionUnknown}</Status>
        <Button variant="text" onClick={() => { void checkSelectionStatus(); }} disabled={!canAct}>{text.checkSelection}</Button>
      </>}
      {selectionFeedback.kind === "confirmed" && <Status announce>{text.selectionConfirmed}</Status>}
    </section>
  </section>;
}
