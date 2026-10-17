import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { skipToken, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { WorkspaceLink } from '../routes/WorkspaceLink';
import { Button, MaterialSymbol, OperationAnnouncement, ResearchRunFeature, Status } from '@eliotr/ui';
import type { ResearchCatalogModelUseReceipt, ResearchProjectModelConfiguration, ResearchRunLaunchView, ResearchRunProjectConfigurationPinV4, ResearchRunV4Request, VersionedRef } from '@eliotr/owner-api-client';
import { chatCatalogProviderForRouteProvider } from '../query/chatModelProviderIdentity';
import type { BoundWorkspaceApis } from './runtime';
import type { PrivacyController, SessionContext } from './privacy';
import type { NextQuestionSource } from './NextQuestionScope';
import { matchesResearchRunLaunch, researchQueryOptions } from '../query/research';
import { protectedQueryKey, runProtectedRead } from '../query/client';
import { ChatModelPicker, type ChatModelQualificationState } from './ChatModelPicker';
import { serviceModelCatalogPreferencesQueryOptions, serviceModelCatalogQueryOptions,
  serviceModelProvidersV2QueryOptions, serviceModelSettingsQueryOptions,
  type ServiceModelProviderConnectionV2 } from '../query/globalModelSettings';
import { buildChatModelOptions, preferredChatModelIdentity,
  type ChatModelOption, type ChatModelCatalogSlice } from '../query/chatModelCatalog';
import { chatCatalogModelOperationQueryOptions, chatCurrentCatalogModelOperationQueryOptions, chatPreferredModelCatalogQueryOptions,
  chatProjectModelConfigurationQueryOptions } from '../query/chatModelQueries';
import { ChatModelSelectionClosedError,
  ChatModelSelectionUnconfirmedError, configurationMatchesChatModel, prepareChatModelRunV4 }
  from '../query/chatModelSelection';
import { catalogModelUseReceiptProblem, chatCatalogModelUseMatches, chatCatalogModelUseNeedsReadback, prepareCatalogChatModelSelection,
  readDiscoveredCatalogModelOperation, ChatCatalogModelUseDiscoveredError,
  ChatCatalogModelUseUnavailableError, type ChatCatalogModelUseIntent } from '../query/chatCatalogModelUse';
import { isModelCatalogEntryVisible, modelCatalogEntryKey } from '../query/modelCatalog';
import { researchLaunchFailureMessage, submitResearchLaunchOnce, type ResearchLaunchFailure } from '../query/researchLaunch';
import { ReportPanel } from './ReportPanel';
import { ProjectOverview } from './ProjectOverview';
import { usePaneAnnouncement } from './usePaneAnnouncement';
import { researchHistoryLabel } from './researchHistoryLabel';
import { canRequestResearchRecovery, recoverExistingResearchRun, researchRecoveryCopy, researchRecoveryFirstCause,
  canStopFailedResearchRun, hasCanonicalResearchCancellation, rememberFailedResearchRun, stopFailedResearchRun,
  type ResearchRunRecoveryMemory, type ResearchRunStopMemory } from '../query/researchRunRecovery';

interface ResearchIntent {
  readonly body: string; readonly key: string; readonly question: string;
  readonly scope: readonly { readonly id: string; readonly label: string }[];
  readonly wholeScope?: string;
  readonly phase: 'pending' | 'unknown' | 'admitted';
  readonly launch?: ResearchRunLaunchView;
  readonly launchFailure?: ResearchLaunchFailure;
}
interface ResearchMemory {
  readonly discoveredCatalogModelUse?: ResearchCatalogModelUseReceipt;
  readonly catalogModelUse?: ChatCatalogModelUseIntent;
  readonly recovery?: ResearchRunRecoveryMemory;
  readonly stop?: ResearchRunStopMemory;
  readonly intent?: ResearchIntent;
  readonly observedLaunch?: ResearchRunLaunchView;
  readonly artifact?: VersionedRef;
}
interface ChatCatalogTarget {
  readonly catalogProviderId: string;
  readonly preferenceProviderId: string;
  readonly builtin: boolean;
  readonly connection?: ServiceModelProviderConnectionV2;
}
const copy = {
  en: { statusUnavailable: 'The research status could not be read.', working: 'Researching your question.', runRead: 'Status updated.', runFailed: 'The research ended with an error.', runComplete: 'The engine finished. Review its result.', cancelled: 'Research cancelled.', historyLoaded: 'Recent research loaded.', scope: 'Choose sources', scopeStale: 'Review your selected sources again before asking a new question.', scopeEmpty: 'Choose the sources for your next question first.', noProject: 'Open a project to choose its sources.', projects: 'Open projects', blocked: 'Research settings need a check before you ask.', check: 'Check research readiness', connections: 'Review connections', history: 'Recent research', readHistory: 'Refresh recent research', openRun: 'Read this run', report: 'Open saved report', unknown: 'The launch outcome is unknown. The original question and request identity are preserved.', recover: 'Reconcile this question', same: 'If the research started, it opens; if not, the same request is sent again without a duplicate.', next: 'Ask another question', stopFailed: 'Stop and close failed run', checkStop: 'Check stop status', stopUnknown: 'The stop is not confirmed. The original run is still held.', input: 'The question could not be prepared. Review its text and source selection.', unavailable: 'Recent research could not be read. Refresh it.', noRuns: 'Your questions and saved reports will appear here.', incomplete: 'No draft report yet.', modelConfigurationReading: 'Checking model availability…', modelConfigurationFailed: 'Model availability could not be checked.', modelConfigurationsPartial: 'Some model options may be missing.', modelRunUnavailable: 'No model is currently available for this chat.', providerListIncomplete: 'Some provider connections could not be checked.' },
  ru: { statusUnavailable: 'Не удалось узнать статус исследования.', working: 'Исследую ваш вопрос.', runRead: 'Статус обновлён.', runFailed: 'Исследование завершилось с ошибкой.', runComplete: 'Исследование завершено. Посмотрите результат.', cancelled: 'Исследование отменено.', historyLoaded: 'Последние исследования прочитаны.', scope: 'Выбрать источники', scopeStale: 'Перед новым вопросом проверьте выбранные источники ещё раз.', scopeEmpty: 'Сначала выберите источники для следующего вопроса.', noProject: 'Откройте проект, чтобы выбрать его источники.', projects: 'Открыть проекты', blocked: 'Перед вопросом нужно проверить настройки исследования.', check: 'Проверить готовность исследования', connections: 'Проверить подключения', history: 'Последние исследования', readHistory: 'Обновить список', openRun: 'Открыть исследование', report: 'Открыть отчёт', unknown: 'Не удалось подтвердить запуск исследования. Вопрос сохранён.', recover: 'Проверить этот вопрос', same: 'Если исследование началось; если нет — тот же запрос уйдёт ещё раз, без дубликата.', next: 'Задать другой вопрос', stopFailed: 'Остановить и закрыть запуск', checkStop: 'Проверить остановку', stopUnknown: 'Остановка не подтверждена. Исходный запуск остаётся закреплённым.', input: 'Не удалось подготовить вопрос. Проверьте текст и выбранные источники.', unavailable: 'Не удалось загрузить последние исследования. Обновите список.', noRuns: 'Здесь появятся ваши вопросы и сохранённые отчёты.', incomplete: 'Черновика отчёта пока нет.', modelConfigurationReading: 'Проверяем доступность моделей…', modelConfigurationFailed: 'Не удалось проверить доступность моделей.', modelConfigurationsPartial: 'Некоторые варианты моделей могут отсутствовать.', modelRunUnavailable: 'Для этого чата сейчас нет доступных моделей.', providerListIncomplete: 'Не удалось проверить некоторые подключения провайдеров.' },
} as const;

/** One explicit intent owns admission. Polling, navigation and history never allocate a run. */
export function ResearchPanel({ apis, privacy, context, locale, scope, scopeCurrent, isScopeCurrent, projectId, isProjectCurrent,
  cover, wholeScope }: {
  readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly locale: 'en' | 'ru'; readonly scope: readonly NextQuestionSource[]; readonly scopeCurrent: boolean;
  readonly isScopeCurrent: () => boolean;
  readonly projectId: string | undefined; readonly isProjectCurrent: () => boolean;
  /** Names the whole-project scope used when no source is ticked ("All 3 sources"). */
  readonly wholeScope?: string | undefined;
  /** Presentation only: the open project's title and source count for the start cover. */
  readonly cover?: { readonly title: string; readonly meta?: string } | undefined;
}) {
  const client = useQueryClient(), text = copy[locale];
  const memoryKey = [...protectedQueryKey(context, 'research'), 'local-intent', projectId ?? null];
  const memory = useQuery<ResearchMemory>({ queryKey: memoryKey, queryFn: skipToken, gcTime: Infinity });
  const options = researchQueryOptions({ ...apis.research, configuration: apis.connections.configuration }, privacy, context,
    projectId === undefined ? undefined : { id: projectId, isCurrent: isProjectCurrent },
    { onRecentHistoryRead: event => {
      if (event.outcome !== 'resolved') console.warn(JSON.stringify(event));
    } });
  const configuration = useQuery(options.configuration());
  const history = useQuery({ ...options.history(), enabled: projectId !== undefined && isProjectCurrent() });
  const projectModelQuery = chatProjectModelConfigurationQueryOptions(apis.connections.models, privacy, context, projectId, isProjectCurrent);
  const projectModels = useQuery(projectModelQuery);
  const currentCatalogOperation = useQuery(chatCurrentCatalogModelOperationQueryOptions(apis.connections.catalogModelUse,
    privacy, context, projectId, isProjectCurrent));
  const providerSettings = useQuery(serviceModelSettingsQueryOptions(apis.settings.models, privacy, context));
  const serviceProviders = useQuery(serviceModelProvidersV2QueryOptions(apis.settings.models, privacy, context));
  const connectedProviders = serviceProviders.data?.connections.filter(connection => connection.status === "configured" &&
    connection.provider_id !== "cloudflare-workers-ai") ?? [];
  const catalogTargets: readonly ChatCatalogTarget[] = [
    { catalogProviderId: "workers-ai", preferenceProviderId: "cloudflare-workers-ai", builtin: true },
    ...connectedProviders.map(connection => ({ catalogProviderId: connection.provider_id,
      preferenceProviderId: connection.provider_id, connection, builtin: false })),
  ];
  const [modelSearch, setModelSearch] = useState("");
  const deferredModelSearch = useDeferredValue(modelSearch);
  const [modelCatalogPage, setModelCatalogPage] = useState(1);
  const catalogPreferences = useQueries({ queries: catalogTargets.map(target => ({
    ...serviceModelCatalogPreferencesQueryOptions(apis.settings.models, privacy, context, target.preferenceProviderId),
    enabled: projectId !== undefined && privacy.isCurrent(context) && isProjectCurrent(),
  })) });
  const modelCatalogs = useQueries({ queries: catalogTargets.map(target => ({
    ...serviceModelCatalogQueryOptions(apis.connections.models, privacy, context, {
      providerId: target.catalogProviderId, search: deferredModelSearch, page: modelCatalogPage,
    }),
    enabled: projectId !== undefined && privacy.isCurrent(context) && isProjectCurrent() && (target.builtin || serviceProviders.isSuccess),
  })) });
  const preferredModel = preferredChatModelIdentity(projectModels.isSuccess ? projectModels.data : undefined,
    providerSettings.data?.cloudflare.default_model_id);
  const preferredTargetIndex = preferredModel === undefined ? -1 : catalogTargets.findIndex(target =>
    chatCatalogProviderForRouteProvider(target.catalogProviderId) === preferredModel.provider_id);
  const preferredCatalog = useQuery({
    ...chatPreferredModelCatalogQueryOptions(apis.connections.models, privacy, context, preferredModel, isProjectCurrent, projectId),
    enabled: preferredModel !== undefined && preferredTargetIndex >= 0 && privacy.isCurrent(context) && isProjectCurrent(),
  });
  const catalogSlices = useMemo<readonly ChatModelCatalogSlice[]>(() => catalogTargets.map((target, index) => ({
    catalogProviderId: target.catalogProviderId,
    preferenceProviderId: target.preferenceProviderId,
    providerLabel: target.connection?.display_name ?? (target.builtin ? "Cloudflare Workers AI" : target.preferenceProviderId),
    ...(target.connection === undefined ? {} : { connection: target.connection }),
    ...(modelCatalogs[index]?.data === undefined ? {} : { catalog: modelCatalogs[index].data }),
    ...(catalogPreferences[index]?.data === undefined ? {} : { preferences: catalogPreferences[index].data }),
    ...(target.builtin ? { builtin: {
      bindingAvailable: providerSettings.data?.cloudflare.binding_available === true,
      defaultModelId: providerSettings.data?.cloudflare.default_model_id ?? "",
    } } : {}),
  })), [catalogTargets, modelCatalogs, catalogPreferences, providerSettings.data]);
  const chatModelOptions = useMemo(() => buildChatModelOptions({ slices: catalogSlices,
    ...(projectModels.data === undefined ? {} : { configuration: projectModels.data as ResearchProjectModelConfiguration }),
    ...(preferredModel === undefined || preferredCatalog.data === undefined ? {} : { preferred: { model: preferredModel, catalog: preferredCatalog.data } }),
  }), [catalogSlices, projectModels.data, preferredModel, preferredCatalog.data]);
  const modelCatalogLoading = serviceProviders.isPending || providerSettings.isPending ||
    catalogPreferences.some(query => query.isFetching) || modelCatalogs.some(query => query.isFetching) || preferredCatalog.isFetching;
  const modelCatalogFailed = serviceProviders.isError || providerSettings.isError ||
    catalogPreferences.some(query => query.isError) || modelCatalogs.some(query => query.isError) || preferredCatalog.isError;
  const modelCatalogHasMore = modelCatalogs.some(query => query.data?.pagination.has_more === true &&
    query.data.pagination.next_page !== null);
  const saved = memory.data, launch = saved?.intent?.launch ?? saved?.observedLaunch;
  const historyHeading = useRef<HTMLHeadingElement>(null), returningFromReport = useRef(false);
  const composer = useRef<HTMLDivElement>(null), returningToComposer = useRef(false);
  useLayoutEffect(() => {
    if (!saved?.artifact && returningFromReport.current) {
      returningFromReport.current = false;
      historyHeading.current?.focus();
    }
  }, [saved?.artifact]);
  useLayoutEffect(() => {
    if (returningToComposer.current && !saved?.intent && !saved?.observedLaunch && privacy.isCurrent(context)) {
      returningToComposer.current = false;
      composer.current?.querySelector('textarea')?.focus();
    }
  }, [saved?.intent, saved?.observedLaunch, privacy, context]);
  const displayTime = (iso: string) => {
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : iso;
  };
  const status = useQuery(launch ? { ...options.status(launch),
    refetchInterval: query => query.state.data?.execution_state === 'ACTIVE' ? 5000 : false,
    refetchIntervalInBackground: false,
  } : { queryKey: [...protectedQueryKey(context, 'research'), 'status-unselected'], queryFn: skipToken });
  const [busy, setBusy] = useState(false), [inputError, setInputError] = useState(false);
  const [selectedChatModelKey, setSelectedChatModelKey] = useState("");
  const [selectedChatModelIdentity, setSelectedChatModelIdentity] = useState<Pick<ChatModelOption["model"], "provider_id" | "model_id">>();
  const [modelQualificationState, setModelQualificationState] = useState<ChatModelQualificationState>("idle");
  const [modelSelectionUnknown, setModelSelectionUnknown] = useState(false);
  const [heldModelChoice, setHeldModelChoice] = useState<ChatModelOption>();
  const explicitChatSelection = useRef(false);
  const preparingModel = useRef(false);
  const [heldDraft, setHeldDraft] = useState<{ readonly context: SessionContext; readonly text: string } | undefined>(undefined);
  const nextQuestionDraft = heldDraft !== undefined && heldDraft.context === context && privacy.isCurrent(context)
    ? heldDraft.text : '';
  const selectedChatModel = chatModelOptions.find(choice => choice.key === selectedChatModelKey);
  const localCatalogModelUseHeld = chatCatalogModelUseNeedsReadback(saved?.catalogModelUse);
  const discoveredCatalogOperation = saved?.discoveredCatalogModelUse ?? currentCatalogOperation.data ?? undefined;
  const catalogOperationId = localCatalogModelUseHeld ? saved?.catalogModelUse?.request.operation_id : discoveredCatalogOperation?.operation_id;
  const catalogOperationReadback = useQuery({
    ...chatCatalogModelOperationQueryOptions(apis.connections.catalogModelUse, apis.connections.models,
      privacy, context, projectId, isProjectCurrent, catalogOperationId),
    enabled: !busy && projectId !== undefined && catalogOperationId !== undefined && privacy.isCurrent(context) && isProjectCurrent(),
  });
  const observedCatalogOperation = !catalogOperationReadback.isError && catalogOperationReadback.data?.receipt.operation_id === catalogOperationId
    ? catalogOperationReadback.data : undefined;
  const catalogOperationTerminal = observedCatalogOperation !== undefined && ['selected', 'blocked', 'conflict'].includes(observedCatalogOperation.receipt.state);
  const serverCatalogOperationHeld = catalogOperationId !== undefined && (!catalogOperationTerminal || catalogOperationReadback.isFetching);
  const catalogDiscoveryBlocked = projectId !== undefined && (!currentCatalogOperation.isSuccess || currentCatalogOperation.isFetching);
  const catalogModelUseHeld = localCatalogModelUseHeld || serverCatalogOperationHeld;
  const modelSelectionLocked = modelSelectionUnknown || catalogDiscoveryBlocked || serverCatalogOperationHeld ||
    (localCatalogModelUseHeld && !catalogOperationTerminal);
  const localCatalogModelProblem = saved?.catalogModelUse && selectedChatModel &&
    chatCatalogModelUseMatches(saved.catalogModelUse, selectedChatModel.model, selectedChatModel.providerOperationId ?? null)
      ? saved.catalogModelUse.problem : undefined;
  const serverCatalogModelProblem = observedCatalogOperation && ['blocked', 'conflict'].includes(observedCatalogOperation.receipt.state) &&
    observedCatalogOperation.receipt.provider_id === selectedChatModelIdentity?.provider_id &&
    observedCatalogOperation.receipt.model_id === selectedChatModelIdentity.model_id
      ? catalogModelUseReceiptProblem(observedCatalogOperation.receipt) : undefined;
  const catalogModelProblem = serverCatalogModelProblem ?? localCatalogModelProblem;
  const selectedCatalogIndex = selectedChatModelIdentity === undefined ? -1 :
    catalogTargets.findIndex(target => chatCatalogProviderForRouteProvider(target.catalogProviderId) === selectedChatModelIdentity.provider_id);
  const selectedUsesPreferred = selectedChatModelIdentity !== undefined && preferredModel !== undefined &&
    modelCatalogEntryKey(selectedChatModelIdentity) === modelCatalogEntryKey(preferredModel);
  const selectedCatalogRead = selectedUsesPreferred ? preferredCatalog : modelCatalogs[selectedCatalogIndex];
  const selectedCatalogMissing = selectedChatModelIdentity !== undefined && selectedChatModel === undefined;
  const selectedCatalogFailed = selectedChatModelIdentity !== undefined && (selectedCatalogIndex < 0 || selectedCatalogRead?.isError === true ||
    catalogPreferences[selectedCatalogIndex]?.isError === true || (selectedChatModelIdentity.provider_id === 'cloudflare-workers-ai'
      ? providerSettings.isError : serviceProviders.isError));
  const failedCatalogTargets = catalogTargets.flatMap((target, index) => catalogPreferences[index]?.isError || modelCatalogs[index]?.isError ||
    (preferredTargetIndex === index && preferredCatalog.isError) ? [{ index, label: target.connection?.display_name ??
      (target.builtin ? 'Cloudflare Workers AI' : target.preferenceProviderId) }] : []);
  const pickerCatalogFailed = currentCatalogOperation.isError || catalogOperationReadback.isError || selectedCatalogFailed ||
    (selectedChatModelIdentity === undefined && chatModelOptions.length === 0 && modelCatalogFailed);
  const pickerCatalogLoading = currentCatalogOperation.isFetching || catalogOperationReadback.isFetching ||
    (selectedChatModelIdentity === undefined ? modelCatalogLoading : selectedCatalogRead?.isFetching === true || catalogPreferences[selectedCatalogIndex]?.isFetching === true);
  const selectedModelQueriesPending = selectedChatModel === undefined || selectedCatalogIndex < 0 ||
    (selectedChatModel.builtin ? providerSettings.isFetching : serviceProviders.isFetching) ||
    catalogPreferences[selectedCatalogIndex]?.isFetching === true || selectedCatalogRead?.isFetching === true;
  const selectedModelQueriesFailed = selectedChatModel !== undefined && (selectedCatalogIndex < 0 ||
    (selectedChatModel.builtin ? providerSettings.isError : serviceProviders.isError) ||
    catalogPreferences[selectedCatalogIndex]?.isError === true || selectedCatalogRead?.isError === true);
  useEffect(() => {
    explicitChatSelection.current = false;
    preparingModel.current = false;
    setSelectedChatModelKey(""); setModelQualificationState("idle"); setModelSelectionUnknown(false);
    setSelectedChatModelIdentity(undefined); setHeldModelChoice(undefined);
  }, [projectId, context]);
  useEffect(() => {
    if (explicitChatSelection.current || selectedChatModelKey !== "") return;
    if (catalogDiscoveryBlocked) return;
    if (discoveredCatalogOperation) {
      explicitChatSelection.current = true;
      setSelectedChatModelKey(modelCatalogEntryKey(discoveredCatalogOperation));
      setSelectedChatModelIdentity(discoveredCatalogOperation);
      setModelQualificationState('unknown');
      return;
    }
    if (catalogModelUseHeld && saved?.catalogModelUse !== undefined && saved.catalogModelUse.projectId === projectId) {
      const held = saved.catalogModelUse.request;
      explicitChatSelection.current = true;
      setSelectedChatModelKey(modelCatalogEntryKey(held));
      setSelectedChatModelIdentity({ provider_id: held.provider_id, model_id: held.model_id });
      setModelQualificationState("unknown");
      return;
    }
    const preferences = catalogPreferences[preferredTargetIndex]?.data;
    if (preferredModel && preferences?.provider_id === preferredModel.provider_id &&
        isModelCatalogEntryVisible(preferences.visibility, preferredModel.model_id)) {
      setSelectedChatModelKey(modelCatalogEntryKey(preferredModel)); setSelectedChatModelIdentity(preferredModel);
    }
  }, [preferredModel, preferredTargetIndex, catalogPreferences, selectedChatModelKey, catalogModelUseHeld, saved?.catalogModelUse,
    projectId, catalogDiscoveryBlocked, discoveredCatalogOperation]);
  const running = useRef(false), mounted = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const recoveryInFlight = useRef(false);
  const read = () => client.getQueryData<ResearchMemory>(memoryKey) ?? {};
  const write = (update: (old: ResearchMemory) => ResearchMemory) => {
    if (privacy.isCurrent(context)) client.setQueryData<ResearchMemory>(memoryKey, old => update(old ?? {}));
  };
  const holdDiscoveredCatalogOperation = (receipt: ResearchCatalogModelUseReceipt) => {
    if (receipt.project_id !== projectId || !isProjectCurrent() || !privacy.isCurrent(context)) return;
    write(old => ({ ...old, discoveredCatalogModelUse: receipt }));
    explicitChatSelection.current = true;
    setSelectedChatModelKey(modelCatalogEntryKey(receipt)); setSelectedChatModelIdentity(receipt);
    setModelSelectionUnknown(true); setModelQualificationState('unknown');
  };
  const rememberCatalogOperation = (receipt: ResearchCatalogModelUseReceipt) => {
    write(old => {
      const local = old.catalogModelUse;
      const matching = local?.request.operation_id === receipt.operation_id &&
        chatCatalogModelUseMatches(local, receipt, receipt.provider_operation_id);
      const phase = receipt.state === 'selected' || receipt.state === 'blocked' || receipt.state === 'conflict' ? receipt.state : 'unknown';
      return { ...old, discoveredCatalogModelUse: receipt, ...(matching ? { catalogModelUse: { ...local, phase, receipt,
        ...(['blocked', 'conflict'].includes(receipt.state) ? { problem: catalogModelUseReceiptProblem(receipt) } : {}) } } : {}) };
    });
  };
  useEffect(() => {
    const receipt = currentCatalogOperation.data;
    if (receipt && privacy.isCurrent(context) && isProjectCurrent()) {
      write(old => ({ ...old, discoveredCatalogModelUse: receipt }));
    }
  }, [currentCatalogOperation.data, context, projectId]);
  useEffect(() => {
    if (!observedCatalogOperation || busy || !privacy.isCurrent(context) || !isProjectCurrent()) return;
    rememberCatalogOperation(observedCatalogOperation.receipt);
    if (['selected', 'blocked', 'conflict'].includes(observedCatalogOperation.receipt.state)) {
      setModelSelectionUnknown(false);
      setModelQualificationState(observedCatalogOperation.selection ? 'ready' : 'idle');
      if (observedCatalogOperation.selection) { void projectModels.refetch(); void configuration.refetch(); }
    }
  }, [observedCatalogOperation, context, projectId, busy]);
  useEffect(() => {
    mounted.current = true;
    const clearStaleDraft = () => {
      if (!privacy.isCurrent(context)) {
        controller.current?.abort();
        preparingModel.current = false;
        setHeldDraft(undefined); setSelectedChatModelKey(""); setSelectedChatModelIdentity(undefined); setModelQualificationState("idle");
        setModelSelectionUnknown(false); setHeldModelChoice(undefined);
      }
    };
    const unsubscribe = privacy.subscribe(clearStaleDraft);
    clearStaleDraft();
    return () => {
      unsubscribe();
      mounted.current = false; controller.current?.abort();
      if (running.current && privacy.isCurrent(context)) client.setQueryData<ResearchMemory>(memoryKey, old => {
        if (old === undefined) return old;
        let next = old;
        if (recoveryInFlight.current && old.recovery) next = { ...next, recovery: { ...old.recovery, phase: 'unknown' } };
        if (old.stop && (old.stop.phase === 'stopping' || old.stop.phase === 'reading')) {
          next = { ...next, stop: { ...old.stop, phase: 'unknown' } };
        }
        if (!recoveryInFlight.current && old.intent) next = { ...next, intent: { ...old.intent, phase: 'unknown' } };
        return next;
      });
    };
  }, [client, context, privacy, projectId]);
  const run = (action: (signal: AbortSignal) => Promise<void>, recovering = false) => {
    if (running.current || !privacy.isCurrent(context)) return;
    recoveryInFlight.current = recovering;
    running.current = true; controller.current = new AbortController(); setBusy(true);
    const signal = controller.current.signal;
    void action(signal).catch(() => {
      if (!recovering) write(old => old.intent ? { ...old, intent: { ...old.intent, phase: 'unknown' } } : old);
    }).finally(() => { running.current = false; if (mounted.current) setBusy(false); });
  };
  const admit = async (intent: ResearchIntent, signal: AbortSignal) => {
    const result = await submitResearchLaunchOnce({ runs: apis.research.runs, privacy, context, body: intent.body, key: intent.key,
      signal, isCurrent: () => mounted.current && isProjectCurrent() && read().intent?.key === intent.key });
    write(old => {
      if (old.intent?.key !== intent.key) return old;
      const { launchFailure: _failure, ...original } = intent;
      return { ...old, intent: result.phase === 'admitted' ? { ...original, phase: 'admitted', launch: result.launch }
        : { ...original, phase: 'unknown', launchFailure: result.failure } };
    });
  };
  const confirmModelSelection = async (selection: ResearchRunProjectConfigurationPinV4, model: Pick<ChatModelOption['model'], 'provider_id' | 'model_id'>,
    signal: AbortSignal, isCurrent: () => boolean) => {
    const refreshed = await projectModels.refetch(), selected = refreshed.data?.selected;
    if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
    if (refreshed.isError || !refreshed.data || refreshed.data.project_id !== projectId || !selected ||
        refreshed.data.selection_revision !== selection.selection_revision || selected.configuration_ref !== selection.configuration_ref ||
        selected.configuration_sha256 !== selection.configuration_sha256 || selected.qualification_state !== 'qualified' ||
        !configurationMatchesChatModel(selected, model)) throw new ChatModelSelectionUnconfirmedError();
    const readiness = await configuration.refetch();
    if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
    if (readiness.isError || !readiness.data || readiness.data.run_readiness === 'blocked') throw new ChatModelSelectionUnconfirmedError();
  };
  const prepareCatalogChoice = async (choice: ChatModelOption, signal: AbortSignal, isCurrent: () => boolean) => {
    if (projectId === undefined || signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
    if (choice.builtin) {
      const observed = await providerSettings.refetch();
      if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
      if (observed.isError || !observed.data?.cloudflare.binding_available) throw new ChatCatalogModelUseUnavailableError('unsupported');
    }
    if (choice.providerOperationId === undefined) throw new ChatCatalogModelUseUnavailableError('unavailable');
    const selection = await prepareCatalogChatModelSelection({ api: apis.connections.catalogModelUse, models: apis.connections.models,
      projectId, generation: context.deploymentGeneration, modelChoice: choice.model,
      providerOperationId: choice.providerOperationId, signal, isCurrent, mintOperationId: () => crypto.randomUUID(),
      readIntent: () => read().catalogModelUse, writeIntent: catalogModelUse => write(old => ({ ...old, catalogModelUse })) });
    await confirmModelSelection(selection, choice.model, signal, isCurrent);
    return selection;
  };
  const chooseChatModel = (choice: ChatModelOption | undefined) => {
    if (running.current || modelSelectionLocked || read().intent || read().observedLaunch || projectId === undefined ||
        !privacy.isCurrent(context) || !isProjectCurrent()) return;
    explicitChatSelection.current = true;
    setSelectedChatModelKey(choice?.key ?? ''); setSelectedChatModelIdentity(choice?.model);
    setModelQualificationState('idle'); setModelSelectionUnknown(false); setHeldModelChoice(undefined);
    write(old => { const { catalogModelUse: _modelUse, discoveredCatalogModelUse: _discovered, ...rest } = old; return rest; });
    if (!choice?.canRun || choice.candidate?.qualification_state === 'qualified' || (scope.length > 0 && (!scopeCurrent || !isScopeCurrent()))) return;
    const isCurrent = () => mounted.current && privacy.isCurrent(context) && isProjectCurrent() &&
      (scope.length === 0 || (scopeCurrent && isScopeCurrent()));
    setModelQualificationState('qualifying');
    run(async signal => {
      try {
        await prepareCatalogChoice(choice, signal, isCurrent);
        if (!isCurrent()) throw new ChatModelSelectionClosedError();
        setModelQualificationState('ready');
      } catch (error) {
        if (signal.aborted || !isCurrent()) return;
        if (error instanceof ChatCatalogModelUseDiscoveredError) { holdDiscoveredCatalogOperation(error.receipt); return; }
        setHeldModelChoice(choice);
        const unavailable = error instanceof ChatCatalogModelUseUnavailableError;
        setModelQualificationState(unavailable ? 'idle' : 'unknown'); setModelSelectionUnknown(!unavailable);
      }
    });
  };
  const ask = (question: string) => {
    // No ticked source asks the whole open project (a PROJECT scope); a selection must still be current.
    const wholeProject = scope.length === 0;
    if (read().intent || read().observedLaunch || running.current || projectId === undefined || !isProjectCurrent() ||
      (!wholeProject && (!scopeCurrent || !isScopeCurrent())) || !privacy.isCurrent(context) ||
      configuration.isError || configuration.isFetching || !configuration.data ||
      client.getQueryData(options.configuration().queryKey) !== configuration.data || configuration.data.run_readiness === 'blocked' ||
      projectModels.isError || projectModels.isFetching || !projectModels.data ||
      client.getQueryData(projectModelQuery.queryKey) !== projectModels.data || !selectedChatModel?.canRun ||
      modelSelectionLocked || catalogModelProblem !== undefined || selectedModelQueriesPending || selectedModelQueriesFailed) return;
    const selectedChoice = selectedChatModel;
    const scopeExpression: ResearchRunV4Request["scope_expression"] = wholeProject
      ? { kind: "PROJECT", project_id: projectId }
      : { kind: "INTERSECT", left: { kind: "PROJECT", project_id: projectId },
        right: { kind: "SELECTED_SOURCES", source_ids: scope.map(source => source.id) } };
    const isSelectionCurrent = () => mounted.current && privacy.isCurrent(context) && isProjectCurrent() &&
      (wholeProject || (scopeCurrent && isScopeCurrent()));
    preparingModel.current = true;
    setInputError(false); setHeldDraft({ context, text: question });
    setModelQualificationState("qualifying"); setModelSelectionUnknown(false);
    run(async signal => {
      let intentCommitted = false;
      try {
        const request = { query: question, scope_expression: scopeExpression, output_language: locale };
        let body: string;
        if (selectedChoice.candidate?.qualification_state === 'qualified') {
          const prepared = await prepareChatModelRunV4({ models: apis.connections.models, runs: apis.research.runs,
            projectId, generation: context.deploymentGeneration, candidate: selectedChoice.candidate,
            modelChoice: selectedChoice.model, request, signal, isCurrent: isSelectionCurrent,
            mintSelectionOperation: () => crypto.randomUUID(),
          });
          await confirmModelSelection(prepared.selection, selectedChoice.model, signal, isSelectionCurrent);
          body = prepared.body;
        } else {
          const selection = await prepareCatalogChoice(selectedChoice, signal, isSelectionCurrent);
          if (!isSelectionCurrent()) throw new ChatModelSelectionClosedError();
          body = apis.research.runs.researchRunBodyV4({ ...request, selection });
        }
        if (!isSelectionCurrent()) throw new ChatModelSelectionClosedError();
        const intent: ResearchIntent = Object.freeze({ body, key: apis.sources.mintIntent(), question,
          scope: Object.freeze(scope.map(source => Object.freeze({ id: source.id, label: source.label }))), phase: 'pending',
          ...(scope.length === 0 && wholeScope !== undefined ? { wholeScope } : {}) });
        write(old => ({ ...old, intent }));
        if (read().intent?.key !== intent.key) throw new ChatModelSelectionClosedError();
        intentCommitted = true;
        preparingModel.current = false;
        setModelQualificationState("ready"); setHeldModelChoice(undefined); setHeldDraft(undefined);
        await admit(intent, signal);
      } catch (error) {
        if (!intentCommitted) {
          preparingModel.current = false;
          if (signal.aborted || !isSelectionCurrent()) setModelQualificationState("idle");
        }
        if (!intentCommitted && !signal.aborted && isSelectionCurrent()) {
          if (error instanceof ChatCatalogModelUseDiscoveredError) { holdDiscoveredCatalogOperation(error.receipt); return; }
          setHeldModelChoice(selectedChoice);
          const unavailable = error instanceof ChatCatalogModelUseUnavailableError;
          setModelQualificationState(unavailable ? 'idle' : 'unknown'); setModelSelectionUnknown(!unavailable);
        }
        throw error;
      }
    });
  };
  const reconcile = () => {
    const intent = read().intent; if (!intent || intent.phase === 'pending') return;
    run(async signal => {
      // History has no request identity and is independent of same-key reconciliation.
      if (signal.aborted || !privacy.isCurrent(context)) return;
      if (intent.launch) {
        await client.fetchQuery(options.status(intent.launch));
        write(old => old.intent?.key === intent.key ? { ...old, intent: { ...intent, phase: 'admitted' } } : old);
      } else await admit(intent, signal);
    });
  };
  const checkModelSelection = () => {
    if ((!modelSelectionLocked && !modelCatalogFailed && !selectedCatalogMissing) || running.current || projectId === undefined ||
        !isProjectCurrent() || !privacy.isCurrent(context)) return;
    const isCurrent = () => mounted.current && privacy.isCurrent(context) && isProjectCurrent();
    run(async signal => {
      try {
        const discovery = await currentCatalogOperation.refetch();
        if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
        if (discovery.isError || discovery.data === undefined) throw new ChatModelSelectionUnconfirmedError();
        const local = read().catalogModelUse;
        const known = discovery.data ?? read().discoveredCatalogModelUse;
        const operationId = chatCatalogModelUseNeedsReadback(local) ? local?.request.operation_id : known?.operation_id;
        if (operationId !== undefined) {
          const query = chatCatalogModelOperationQueryOptions(apis.connections.catalogModelUse, apis.connections.models,
            privacy, context, projectId, isProjectCurrent, operationId);
          await client.cancelQueries({ queryKey: query.queryKey, exact: true });
          const result = await runProtectedRead(privacy, context, signal, readSignal => readDiscoveredCatalogModelOperation({
            api: apis.connections.catalogModelUse, models: apis.connections.models, projectId,
            generation: context.deploymentGeneration, operationId, signal: readSignal, isCurrent,
          }));
          if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
          client.setQueryData(query.queryKey, result);
          rememberCatalogOperation(result.receipt);
          if (result.selection === null) {
            if (['blocked', 'conflict'].includes(result.receipt.state)) throw new ChatCatalogModelUseUnavailableError(catalogModelUseReceiptProblem(result.receipt));
            throw new ChatModelSelectionUnconfirmedError();
          }
          await confirmModelSelection(result.selection, result.receipt, signal, isCurrent);
        } else if (modelSelectionUnknown) {
          const model = heldModelChoice?.model ?? selectedChatModel?.model;
          if (model) {
            const refreshed = await projectModels.refetch(), selected = refreshed.data?.selected;
            if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
            if (refreshed.isError || !refreshed.data || !selected || selected.qualification_state !== 'qualified' ||
                !configurationMatchesChatModel(selected, model) || (heldModelChoice?.candidate && (
                  selected.configuration_ref !== heldModelChoice.candidate.configuration_ref ||
                  selected.configuration_sha256 !== heldModelChoice.candidate.configuration_sha256))) {
              throw new ChatModelSelectionUnconfirmedError();
            }
          }
        }
        if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
        // Reconcile any held operation first. Metadata retry is GET-only and scoped to this provider.
        if (selectedCatalogIndex >= 0) {
          const preferences = await catalogPreferences[selectedCatalogIndex]?.refetch();
          const catalog = await selectedCatalogRead?.refetch();
          if (signal.aborted || !isCurrent()) throw new ChatModelSelectionClosedError();
          if (preferences?.isError || catalog?.isError) throw new ChatModelSelectionUnconfirmedError();
        }
        setHeldModelChoice(undefined); setModelSelectionUnknown(false); setModelQualificationState(operationId ? 'ready' : 'idle');
      } catch (error) {
        if (signal.aborted || !isCurrent()) return;
        const unavailable = error instanceof ChatCatalogModelUseUnavailableError;
        // A GET failure cannot create mutation uncertainty; any existing held intent still gates selection.
        setModelSelectionUnknown(previous => !unavailable && previous); setModelQualificationState(unavailable ? 'idle' : 'unknown');
      }
    });
  };
  const progress = status.isError ? undefined : status.data;
  const recovery = saved?.recovery?.workflowInstanceId === launch?.workflow_instance_id ? saved?.recovery : undefined;
  useEffect(() => {
    if (!launch || status.data === undefined || !privacy.isCurrent(context) || !isProjectCurrent() ||
        rememberFailedResearchRun(undefined, launch, status.data) === undefined) return;
    write(old => {
      const current = old.intent?.launch ?? old.observedLaunch;
      if (current === undefined || current.workflow_instance_id !== launch.workflow_instance_id ||
          current.investigation_ref.id !== launch.investigation_ref.id) return old;
      const held = old.recovery?.workflowInstanceId === launch.workflow_instance_id ? old.recovery : undefined;
      const next = rememberFailedResearchRun(held, launch, status.data);
      return next === undefined || next === held ? old : { ...old, recovery: next };
    });
  }, [status.data, launch, context, privacy, projectId]);
  const recoveryText = researchRecoveryCopy[locale];
  const displayedFailure = researchRecoveryFirstCause(recovery, progress);
  const recoveryHeld = recovery?.phase === 'unknown' || recovery?.phase === 'recovering' || recovery?.phase === 'reading';
  const stopMemory = saved?.stop?.workflowInstanceId === launch?.workflow_instance_id ? saved?.stop : undefined;
  const canStopRun = launch !== undefined && canStopFailedResearchRun(status.data, launch,
    recovery?.failedRunObserved === true);
  const canRetryFailedRun = launch !== undefined && saved?.intent !== undefined &&
    (canStopRun || hasCanonicalResearchCancellation(status.data, launch)) &&
    (!recoveryHeld || stopMemory?.cancel_dispatched === true || hasCanonicalResearchCancellation(status.data, launch));
  const recoveryMessage = recovery && recovery.phase !== 'observed' &&
    (recoveryHeld || launch && canRequestResearchRecovery(status.data, launch)) ? recoveryText[recovery.phase] : '';
  const recoverResearch = (action: 'recover' | 'readback') => {
    const selected = launch, currentStatus = status.data;
    if (!selected || !currentStatus || running.current || projectId === undefined || !isProjectCurrent() ||
        !privacy.isCurrent(context) || (action === 'recover' && (status.isFetching || status.isError ||
          !canRequestResearchRecovery(currentStatus, selected)))) return;
    const isRecoveryCurrent = () => {
      const current = read().intent?.launch ?? read().observedLaunch;
      return mounted.current && privacy.isCurrent(context) && isProjectCurrent() && current !== undefined &&
        current.workflow_instance_id === selected.workflow_instance_id &&
        current.investigation_ref.id === selected.investigation_ref.id;
    };
    run(async signal => {
      await recoverExistingResearchRun({ runs: apis.research.runs, privacy, context, launch: selected, status: currentStatus,
        action, signal, isCurrent: isRecoveryCurrent, readMemory: () => read().recovery,
        writeMemory: next => write(old => ({ ...old, recovery: next })),
        onStatus: async view => {
          await client.cancelQueries({ queryKey: options.status(selected).queryKey, exact: true });
          if (!signal.aborted && isRecoveryCurrent()) client.setQueryData(options.status(selected).queryKey, view);
        },
      });
    }, true);
  };
  const historyRefreshes = useRef(new Set<string>());
  const terminalObservation = progress && ['complete', 'errored', 'terminated'].includes(progress.engine_status)
    ? `${progress.workflow_instance_id}:${progress.engine_status}` : undefined;
  const refreshHistory = history.refetch;
  useEffect(() => {
    if (terminalObservation === undefined || !privacy.isCurrent(context) || historyRefreshes.current.has(terminalObservation)) return;
    historyRefreshes.current.add(terminalObservation);
    void refreshHistory();
  }, [terminalObservation, privacy, context, refreshHistory]);
  const displayedWholeScope = saved?.intent?.wholeScope ?? wholeScope;
  const retryFailedRun = () => {
    const original = read().intent;
    if (!launch || !original || !canRetryFailedRun || running.current || !privacy.isCurrent(context) || !isProjectCurrent()) return;
    const selected = launch;
    run(async signal => {
      const cancelled = await stopFailedResearchRun({ runs: apis.research.runs, privacy, context, launch: selected,
        ...(status.data === undefined ? {} : { status: status.data }),
        failedRunObserved: recovery?.failedRunObserved === true || canStopFailedResearchRun(status.data, selected,
          recovery?.failedRunObserved === true) || hasCanonicalResearchCancellation(status.data, selected),
        action: hasCanonicalResearchCancellation(status.data, selected) || stopMemory?.cancel_dispatched === true || stopMemory?.phase === 'unknown' ||
          stopMemory?.phase === 'stopping' || stopMemory?.phase === 'reading' ? 'readback' : 'stop',
        signal, isCurrent: () => {
          const current = read().intent?.launch ?? read().observedLaunch;
          return mounted.current && privacy.isCurrent(context) && isProjectCurrent() && current !== undefined &&
            current.workflow_instance_id === selected.workflow_instance_id &&
            current.investigation_ref.id === selected.investigation_ref.id;
        },
        readMemory: () => read().stop,
        writeMemory: next => write(old => old.intent?.launch?.workflow_instance_id === selected.workflow_instance_id ||
          old.observedLaunch?.workflow_instance_id === selected.workflow_instance_id ? { ...old, stop: next } : old),
        onStatus: async view => {
          await client.cancelQueries({ queryKey: options.status(selected).queryKey, exact: true });
          if (!signal.aborted) client.setQueryData(options.status(selected).queryKey, view);
        },
      });
      if (cancelled?.execution_state !== 'CANCELLED' ||
          cancelled.cancellation_receipt_ref !== `workflow-cancelled:${selected.workflow_instance_id}`) return;
      const { launch: _launch, ...request } = original;
      const next: ResearchIntent = { ...request, key: apis.sources.mintIntent(), phase: 'pending' };
      write(old => {
        if (old.intent?.key !== original.key) return old;
        const { stop: _stop, ...rest } = old;
        return { ...rest, intent: next };
      });
      if (read().intent?.key === next.key) await admit(next, signal);
      void history.refetch();
    });
  };
  const closeFailedRun = (action: 'stop' | 'readback') => {
    const selected = launch;
    if (!selected || !canStopRun || running.current || !privacy.isCurrent(context) || !isProjectCurrent()) return;
    const originalIntentKey = read().intent?.key;
    const isStopCurrent = () => {
      const current = read().intent?.launch ?? read().observedLaunch;
      return mounted.current && privacy.isCurrent(context) && isProjectCurrent() && current !== undefined &&
        current.workflow_instance_id === selected.workflow_instance_id &&
        current.investigation_ref.id === selected.investigation_ref.id;
    };
    run(async signal => {
      const cancelled = await stopFailedResearchRun({ runs: apis.research.runs, privacy, context, launch: selected,
        ...(status.data === undefined ? {} : { status: status.data }),
        failedRunObserved: canStopFailedResearchRun(status.data, selected, recovery?.failedRunObserved === true),
        action, signal, isCurrent: isStopCurrent,
        readMemory: () => read().stop,
        writeMemory: next => write(old => old.intent?.launch?.workflow_instance_id === selected.workflow_instance_id ||
          old.observedLaunch?.workflow_instance_id === selected.workflow_instance_id ? { ...old, stop: next } : old),
        onStatus: async view => {
          await client.cancelQueries({ queryKey: options.status(selected).queryKey, exact: true });
          if (!signal.aborted && isStopCurrent()) client.setQueryData(options.status(selected).queryKey, view);
        },
      });
      if (cancelled?.execution_state !== 'CANCELLED' ||
          cancelled.cancellation_receipt_ref !== `workflow-cancelled:${selected.workflow_instance_id}` || !isStopCurrent()) return;
      const current = read();
      if (originalIntentKey !== undefined && current.intent?.key === originalIntentKey &&
          current.intent.launch?.workflow_instance_id === selected.workflow_instance_id) {
        returningToComposer.current = true;
        write(old => {
          if (old.intent?.key !== originalIntentKey || old.intent.launch?.workflow_instance_id !== selected.workflow_instance_id) return old;
          const { intent: _intent, stop: _stop, ...rest } = old;
          return rest;
        });
      } else if (current.intent === undefined && current.observedLaunch?.workflow_instance_id === selected.workflow_instance_id) {
        returningToComposer.current = true;
        write(old => {
          if (old.intent || old.observedLaunch?.workflow_instance_id !== selected.workflow_instance_id) return old;
          const { observedLaunch: _launch, stop: _stop, ...rest } = old;
          return rest;
        });
      } else return;
      void history.refetch();
    }, true);
  };
  const terminal = saved?.intent?.launch && progress?.workflow_instance_id === saved.intent.launch.workflow_instance_id &&
    progress.execution_state !== 'ACTIVE' && !status.isError && !status.isFetching;
  const observed = saved?.intent ? undefined : saved?.observedLaunch;
  const historyTerminal = observed && status.isSuccess && !status.isFetching &&
    progress !== undefined && matchesResearchRunLaunch(progress, observed) &&
    (progress.execution_state === 'ENGINE_COMPLETED' || progress.execution_state === 'CANCELLED');
  const dismissHistory = () => {
    if (!observed || !historyTerminal || running.current || !privacy.isCurrent(context)) return;
    const currentStatus = client.getQueryState(options.status(observed).queryKey);
    if (currentStatus?.status !== 'success' || currentStatus.fetchStatus !== 'idle' || currentStatus.data !== progress) return;
    write(old => {
      // A history view owns only its selection, never a pending or uncertain mutation intent.
      if (old.intent || old.observedLaunch !== observed) return old;
      returningToComposer.current = true;
      const { observedLaunch: _launch, ...rest } = old; return rest;
    });
  };
  // The shared operation lock also covers standalone model checks, which are not research turns.
  const researchBusy = busy && (preparingModel.current || saved?.intent !== undefined || launch !== undefined);
  const state = saved?.intent?.phase === 'unknown' || status.isError || recovery?.phase === 'unknown' ? 'degraded'
    : progress?.execution_state === 'CANCELLED' ? 'cancelled'
    : recovery?.failedRunObserved && progress?.execution_state === 'ACTIVE' && progress.engine_status === 'unknown' ? 'degraded'
    : progress?.failure ? 'error' : progress?.execution_state === 'ENGINE_COMPLETED' ? 'useful'
    : launch || researchBusy ? 'loading' : 'empty';
  const launchFailure = saved?.intent?.phase === 'unknown' ? saved.intent.launchFailure : undefined;
  const launchFailureReason = launchFailure === undefined ? undefined : researchLaunchFailureMessage(launchFailure, locale);
  const announcement = usePaneAnnouncement(recoveryMessage || (busy ? researchBusy ? text.working : text.modelConfigurationReading
    : inputError ? text.input
    : saved?.intent?.phase === 'unknown' ? `${text.unknown}${launchFailureReason ? ` ${launchFailureReason}` : ''}`
    : !launch && (currentCatalogOperation.isFetching || catalogOperationReadback.isFetching || modelQualificationState === 'qualifying') ? text.modelConfigurationReading
    : !launch && modelSelectionLocked ? locale === 'ru' ? 'Не удалось подтвердить доступность модели. Проверьте сохранённый статус.'
      : 'Model availability could not be confirmed. Check its saved status.'
    : !launch && modelQualificationState === 'ready' ? locale === 'ru' ? 'Доступность модели подтверждена для запуска.' : 'Model availability confirmed for this run.'
    : status.isError ? text.statusUnavailable
    : progress?.failure ? text.runFailed
    : progress?.execution_state === 'CANCELLED' ? text.cancelled
    : progress?.execution_state === 'ENGINE_COMPLETED' ? text.runComplete
    : progress ? text.runRead : history.isError ? text.unavailable : history.data ? text.historyLoaded : ''));
  if (saved?.artifact) return <ReportPanel key={`${saved.artifact.id}:${saved.artifact.revision}`} locale={locale} apis={apis} privacy={privacy} context={context} artifactRef={saved.artifact}
    onOpenDraft={artifact => write(old => ({ ...old, artifact }))}
    onClose={() => { if (privacy.isCurrent(context)) { returningFromReport.current = true; write(old => { const { artifact: _artifact, ...rest } = old; return rest; }); } }} />;
  return <>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
    {/* An empty selection needs no notice: the Sources pane's checkboxes and the composer's source
        count already say it. A missing project or a stale selection still does. */}
    {!scopeCurrent && !saved?.intent && (projectId === undefined || scope.length > 0) && <p className="er-live-callout"><MaterialSymbol name="folder" /><span>{projectId === undefined ? text.noProject : text.scopeStale}</span> {projectId === undefined
      ? <WorkspaceLink className="er-shell-link" to="/projects">{text.projects}</WorkspaceLink>
      : <WorkspaceLink className="er-shell-link" to="/sources">{text.scope}</WorkspaceLink>}</p>}
    {configuration.isError || configuration.data?.run_readiness === 'blocked' ? <div className="er-live-callout">
      <Status>{text.blocked}</Status><div className="er-live-actions"><Button variant="tonal" disabled={configuration.isFetching} onClick={() => { void configuration.refetch(); }}>{text.check}</Button><WorkspaceLink className="er-shell-link" to="/connections">{text.connections}</WorkspaceLink></div>
    </div> : null}
    {inputError && <Status tone="error">{text.input}</Status>}
    {launch && (recoveryHeld || canRequestResearchRecovery(progress, launch)) && <div className="er-live-actions">
      {recovery?.phase === 'unknown'
        ? <Button variant="tonal" disabled={busy} onClick={() => recoverResearch('readback')}>{recoveryText.check}</Button>
        : <Button variant="tonal" disabled={busy || status.isFetching || recovery?.phase === 'blocked'}
          onClick={() => recoverResearch('recover')}>{recoveryText.recover}</Button>}
      {recoveryMessage && <p>{recoveryMessage}</p>}
    </div>}
    {(canRetryFailedRun || canStopRun) && <div className="er-live-actions">
      {canRetryFailedRun && <Button variant="tonal" disabled={busy} onClick={retryFailedRun}>{locale === 'ru' ? 'Повторить вопрос' : 'Retry question'}</Button>}
      {canStopRun && <Button variant="text" disabled={busy} onClick={() => closeFailedRun(
        stopMemory?.cancel_dispatched === true || stopMemory?.phase === 'unknown' ||
          stopMemory?.phase === 'stopping' || stopMemory?.phase === 'reading' ? 'readback' : 'stop')}>{
          stopMemory?.cancel_dispatched === true || stopMemory?.phase === 'unknown' ||
            stopMemory?.phase === 'stopping' || stopMemory?.phase === 'reading'
            ? text.checkStop : text.stopFailed}</Button>}
      {stopMemory?.phase === 'unknown' && canStopRun && <p>{text.stopUnknown}</p>}
    </div>}
    {projectId !== undefined && projectModels.isPending && <Status>{text.modelConfigurationReading}</Status>}
    {projectId !== undefined && projectModels.isError && <Status tone="error">{text.modelConfigurationFailed}</Status>}
    {projectId !== undefined && projectModels.data?.next_cursor !== null && projectModels.data?.next_cursor !== undefined &&
      <Status>{text.modelConfigurationsPartial}</Status>}
    {serviceProviders.data?.truncated && <Status>{text.providerListIncomplete}</Status>}
    {projectId !== undefined && !modelCatalogLoading && !modelCatalogFailed && chatModelOptions.every(choice => !choice.canRun) &&
      <Status>{text.modelRunUnavailable}</Status>}
    <div ref={composer} className="er-live-research">
      {projectId !== undefined && <><ChatModelPicker locale={locale} choices={chatModelOptions} selected={selectedChatModelIdentity}
        qualificationState={currentCatalogOperation.isFetching || catalogOperationReadback.isFetching ? 'qualifying'
          : modelSelectionLocked && !busy ? 'unknown' : modelQualificationState} search={modelSearch} page={modelCatalogPage}
        loading={pickerCatalogLoading} failed={pickerCatalogFailed} hasMore={modelCatalogHasMore}
        disabled={busy || modelSelectionLocked || saved?.intent !== undefined || saved?.observedLaunch !== undefined || projectId === undefined ||
          !privacy.isCurrent(context) || !isProjectCurrent()}
        checkDisabled={busy || projectId === undefined || !privacy.isCurrent(context) || !isProjectCurrent()}
        onSearchChange={value => { setModelSearch(value); setModelCatalogPage(1); }}
        onPageChange={setModelCatalogPage}
        onCheck={() => checkModelSelection()}
        onSelect={chooseChatModel} />
      {failedCatalogTargets.length > 0 && <div className="er-live-callout">
        <p>{locale === 'ru' ? 'Не удалось прочитать списки моделей: ' : 'Model lists unavailable: '}{failedCatalogTargets.map(target => target.label).join(', ')}.</p>
        {failedCatalogTargets.map(target => <Button key={target.index} variant="text" disabled={busy} onClick={() => {
          if (!privacy.isCurrent(context) || !isProjectCurrent()) return;
          void catalogPreferences[target.index]?.refetch(); void modelCatalogs[target.index]?.refetch();
          if (preferredTargetIndex === target.index) void preferredCatalog.refetch();
        }}>{locale === 'ru' ? 'Повторить чтение: ' : 'Retry model list: '}{target.label}</Button>)}
      </div>}
      {catalogModelProblem && <div className="er-live-callout">
        <p>{catalogModelProblem === 'unsupported'
          ? locale === 'ru' ? 'Эта модель пока не поддерживается сервисом.' : 'This model is not currently supported by the service.'
          : catalogModelProblem === 'conflict'
            ? locale === 'ru' ? 'Выбор модели изменился. Проверьте её доступность ещё раз.' : 'The model selection changed. Check its availability again.'
            : locale === 'ru' ? 'Модель недоступна. Проверьте подключение провайдера или выберите другую модель.'
              : 'This model is unavailable. Check the provider connection or choose another model.'}</p>
        <Button variant="text" disabled={busy} onClick={() => chooseChatModel(selectedChatModel)}>
          {locale === 'ru' ? 'Проверить доступность ещё раз' : 'Check availability again'}</Button>
      </div>}
      </>}
      <ResearchRunFeature key={saved?.intent?.key ?? 'next-question'} locale={locale} state={state}
      {...(cover ? { cover } : {})}
      scope={saved?.intent?.scope ?? scope} busy={researchBusy}
      questionHeld={saved?.intent !== undefined || saved?.observedLaunch !== undefined || preparingModel.current}
      draftQuestion={nextQuestionDraft} onDraftQuestionChange={value => {
        if (mounted.current && privacy.isCurrent(context) && !preparingModel.current) setHeldDraft({ context, text: value });
      }}
      {...(projectId !== undefined && displayedWholeScope !== undefined ? { wholeScope: displayedWholeScope } : {})}
      canSubmit={!busy && !saved?.intent && !saved?.observedLaunch && projectId !== undefined && (scope.length === 0 || scopeCurrent) &&
        !configuration.isError && !configuration.isFetching && configuration.data !== undefined && configuration.data.run_readiness !== 'blocked' &&
        !modelSelectionLocked && catalogModelProblem === undefined && !selectedModelQueriesPending && !selectedModelQueriesFailed && selectedChatModel?.canRun === true &&
          projectModels.isSuccess && !projectModels.isFetching && projectModels.data !== undefined}
      {...(saved?.intent ? { question: saved.intent.question } : {})}
      {...(progress ? { progress, ...(displayedFailure ? { firstCause: displayedFailure } : {}) } : {})}
      onAsk={ask} {...(launch ? { onReadStatus: () => { if (recoveryHeld) recoverResearch('readback'); else void status.refetch(); } } : {})}
      {...(saved?.intent?.phase === 'unknown' ? { onRecover: reconcile } : {})}
      answerActions={(terminal || historyTerminal || progress?.answer.availability === 'draft') ? <div className="er-live-actions">
        {progress?.answer.availability === 'draft' && <><Button variant="primary" onClick={() => { if (privacy.isCurrent(context) && progress.answer.availability === 'draft') { const artifact = progress.answer.artifact_ref; write(old => ({ ...old, artifact })); } }}>{text.report}</Button></>}
        {terminal && <Button variant="text" onClick={() => {
          if (privacy.isCurrent(context) && !running.current) write(old => {
            if (old.intent?.key !== saved?.intent?.key) return old;
            returningToComposer.current = true;
            const { intent: _intent, observedLaunch: _launch, ...rest } = old; return rest;
          });
        }}>{text.next}</Button>}
        {historyTerminal && <Button variant="text" onClick={dismissHistory}>{text.next}</Button>}
        </div> : undefined}
      conversation={<>
        {projectId !== undefined && !researchBusy && <ProjectOverview locale={locale} onSuggest={question => {
          if (mounted.current && privacy.isCurrent(context) && isProjectCurrent()) setHeldDraft({ context, text: question });
        }} />}
        {saved?.intent?.phase === 'unknown' && <div className="er-live-callout er-live-callout--attention"><Status>{text.unknown}</Status>
          {launchFailureReason && <p>{launchFailureReason}{launchFailure?.code && <> <code>{launchFailure.code}</code></>}</p>}
          <p>{text.same}</p>
          <Button variant="tonal" disabled={busy} onClick={reconcile}>{text.recover}</Button></div>}
        <section className="er-live-history" aria-label={text.history}><div className="er-live-history-heading"><h2 ref={historyHeading} tabIndex={-1}>{text.history}</h2>
          <Button variant="text" disabled={history.isFetching} onClick={() => { void history.refetch(); }}>{text.readHistory}</Button></div>
          {history.isError ? <Status>{text.unavailable}</Status> : history.data?.runs.length === 0 && history.data.saved_drafts.length === 0 ? <p>{text.noRuns}</p> : null}
          <ul>{!history.isError && history.data?.runs.map(entry => <li key={entry.status.workflow_instance_id}>
            <time dateTime={entry.created_at}>{displayTime(entry.created_at)}</time>
            {entry.query !== undefined && <p className="er-live-history-question">{entry.query}</p>}
            <span className="er-live-history-state" data-status={entry.status.engine_status}>{researchHistoryLabel(locale, entry.status)}</span>
            <Button variant="text" disabled={saved?.intent !== undefined || busy} onClick={() => {
              if (running.current || !privacy.isCurrent(context) || !isProjectCurrent()) return;
              const observed = entry.status; write(old => ({ ...old, observedLaunch: { workflow_instance_id: observed.workflow_instance_id, investigation_ref: observed.investigation_ref, deployment_generation: observed.deployment_generation } }));
            }}>{text.openRun}</Button>
            {entry.status.answer.availability === 'draft' && <Button variant="tonal" onClick={() => {
              if (entry.status.answer.availability === 'draft') { const artifact = entry.status.answer.artifact_ref; write(old => ({ ...old, artifact })); }
            }}>{text.report}</Button>}
          </li>)}</ul>
          <ul>{!history.isError && history.data?.saved_drafts.map(draft => <li key={`${draft.artifact_ref.id}:${draft.artifact_ref.revision}`}>
            <time dateTime={draft.created_at}>{displayTime(draft.created_at)}</time><Button variant="tonal" onClick={() => write(old => ({ ...old, artifact: draft.artifact_ref }))}>{text.report}</Button>
          </li>)}</ul>
        </section>
      </>} /></div>
  </>;
}
