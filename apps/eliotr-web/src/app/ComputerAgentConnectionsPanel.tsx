import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Field,
  OperationAnnouncement,
  Status,
} from "@eliotr/ui";
import type {
  ComputerAgentConnection,
  ComputerAgentConnectionMutationIntent,
} from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "./privacy";
import type { BoundWorkspaceApis } from "./runtime";
import { computerAgentQueryOptions } from "../query/computerAgents";
import { protectedQueryKey } from "../query/client";
import {
  computerAgentConnectionMutationActions,
  computerAgentConnectionOperationKey,
  computerAgentConnectionReadbackPageOptions,
  computerAgentQualificationOptions,
  type ComputerAgentConnectionPutInput,
  type ComputerAgentConnectionReadbackPage,
  type ComputerAgentQualificationStatus,
} from "../query/computerAgentConnections";
import { useCanonicalCommitReport } from "./canonicalCommit";

type Locale = "en" | "ru";
type TransportCapability = ComputerAgentConnection["transport_capabilities"][number];
type ComputerCapability = ComputerAgentConnection["computer_capabilities"][number];
type TaskKind = ComputerAgentConnection["task_kinds"][number];
type QualificationTransport = ComputerAgentQualificationStatus["transport"];

interface ConnectionForm {
  readonly connectionId: string;
  readonly displayName: string;
  readonly contour: ComputerAgentConnection["contour"] | "";
  readonly issuer: string;
  readonly subject: string;
  readonly transportCapabilities: readonly TransportCapability[];
  readonly computerCapabilities: readonly ComputerCapability[];
  readonly taskKinds: readonly TaskKind[];
  readonly confirmEnable: boolean;
}

type OperationAction =
  | { readonly kind: "put"; readonly desired: ComputerAgentConnectionPutInput; readonly previous?: ComputerAgentConnection }
  | { readonly kind: "disable"; readonly previous: ComputerAgentConnection };

type OperationPhase = "review" | "attempting" | "unknown" | "receipt" | "settled";

interface ConnectionOperation {
  readonly contextKey: string;
  readonly intent: ComputerAgentConnectionMutationIntent;
  readonly action: OperationAction;
  readonly pageCursor: string | undefined;
  readonly phase: OperationPhase;
  readonly receipt?: ComputerAgentConnection;
  readonly lastReadback?: ComputerAgentConnectionReadbackPage & { readonly cursor: string | undefined };
  readonly readbackError?: boolean;
}

interface SelectedConnection {
  readonly contextKey: string;
  readonly cursor: string | undefined;
  readonly connection: ComputerAgentConnection;
}

interface QualificationTarget {
  readonly contextKey: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly transport: QualificationTransport;
}

export type ComputerAgentMutationNoticeState =
  | { readonly kind: "session-lost" }
  | { readonly kind: "unknown"; readonly readbackMatches: boolean; readonly canRetrySameAction: boolean }
  | { readonly kind: "receipt-pending-readback"; readonly revision: number }
  | { readonly kind: "confirmed"; readonly revision: number };

const TRANSPORT_CAPABILITIES: readonly TransportCapability[] = ["MCP_READ", "MCP_WRITE", "WEB_INBOX"];
const QUALIFICATION_TRANSPORTS: readonly QualificationTransport[] = ["MCP_WRITE", "WEB_INBOX"];
const COMPUTER_CAPABILITIES: readonly ComputerCapability[] = [
  "CLOUD_BROWSER", "CLOUD_DESKTOP", "CLOUD_NETWORK", "LOCAL_COMPUTER", "LOCAL_FILES", "LOCAL_SHELL",
  "PYTHON_VM", "CONNECTED_APPS", "SCHEDULED_WORK", "PROACTIVE_WORK", "MESSAGING", "SCREENSHOTS",
];
const TASK_KINDS: readonly TaskKind[] = ["RESEARCH_BRANCH_ANALYSIS"];
const CONTOURS: readonly Exclude<ConnectionForm["contour"], "">[] = [
  "GEMINI_SPARK", "META_MUSE", "OPENAI_DOT", "OTHER",
];

const copy = {
  en: {
    title: "Computer-agent connections",
    explanation: "Manage the owner-scoped registry. Enabled describes saved configuration; it does not mean the agent is online.",
    loading: "Loading computer-agent connections.",
    loadFailed: "The current owner connection page could not be read.",
    retryPage: "Read this page again",
    empty: "No computer-agent connections are saved for this owner.",
    pageCount: (count: number) => `Current page · ${count} of up to 20 connections`,
    previous: "Previous 20",
    next: "Next 20",
    newConnection: "New connection",
    selectConnection: "Select this configuration",
    enabled: "Enabled configuration",
    disabled: "Disabled configuration",
    technical: "Technical details",
    id: "Logical connection ID",
    revision: "Saved revision",
    createHeading: "Configure a computer agent",
    editHeading: "Review computer-agent configuration",
    selectedUnavailable: "The selected connection is not present on the verified page. Read the page again or select a current row.",
    changed: "A newer saved revision was read. Review the refreshed fields before preparing another change.",
    loadLatest: "Load the latest saved fields",
    displayName: "Display name",
    contour: "Provider contour",
    chooseContour: "Choose a contour",
    actor: "Service actor identity",
    issuer: "Service actor issuer",
    subject: "Service actor subject",
    fixedAuth: "Authentication method: service_token. Secret values are never entered here.",
    immutableActor: "The saved service actor cannot be reassigned on an existing logical connection.",
    transport: "Transport capabilities",
    computer: "Computer capabilities",
    tasks: "Supported task kinds",
    capabilityNote: "Only checked capabilities are saved. Unchecked capabilities are not added automatically.",
    taskRouteRequired: "Choose MCP_WRITE or WEB_INBOX and explicitly select the supported task kind.",
    requiredFields: "Complete the required connection, display, contour, and service-actor fields.",
    confirmEnable: "I understand that saving will create or enable this connection.",
    willEnable: "Saving this form creates or enables the connection.",
    reviewPut: "Review and prepare save",
    reviewDisable: "Review disable",
    saveEnabled: "Confirm and save enabled configuration",
    disableExact: (revision: number) => `Confirm disable of revision ${revision}`,
    editDraft: "Edit this unsubmitted review",
    disable: "Disable saved connection",
    alreadyDisabled: "This configuration is already disabled.",
    reviewTitle: "Review this exact change",
    actionCreate: "Create and enable",
    actionUpdate: "Update and keep enabled",
    actionDisable: "Disable",
    expectedRevision: "Expected current revision",
    resultState: "Resulting configuration state",
    enabledResult: "Enabled",
    disabledResult: "Disabled",
    preparing: "Reading the selected revision before preparing the change.",
    prepareFailed: "The change could not be prepared from the current owner configuration. Read the page and review the fields again.",
    prepareStale: "The selected revision changed. The latest saved fields were loaded; review them before continuing.",
    operationAttempting: "Submitting the exact reviewed owner change.",
    operationUnknown: "The outcome is unknown. The exact reviewed action and its original request identity are retained.",
    operationUnknownMatches: "The protected readback matches the requested result, but a canonical receipt is still required.",
    operationUnknownDiffers: "The protected readback does not confirm the requested result. The reviewed action remains unchanged.",
    retrySame: "Retry the same reviewed action",
    readback: "Read the protected configuration again",
    readbackNext: "Read the next 20 connections",
    readbackFirst: "Read from the first page",
    readbackFailed: "Protected readback failed. No new change was prepared.",
    receiptLag: (revision: number) => `The server returned a receipt for revision ${revision}; the protected list readback has not confirmed it yet.`,
    confirmed: (revision: number) => `Configuration change confirmed by receipt and protected readback at revision ${revision}.`,
    sessionLost: "The owner session is no longer current. Protected connection details are hidden.",
    qualification: "Transport qualification",
    qualificationChoose: "Choose a supported transport",
    qualificationRead: "Read qualification",
    qualificationNotRead: "Qualification has not been read for a transport.",
    qualificationLoading: "Reading server qualification for this transport.",
    qualificationFailed: "Qualification could not be read for this connection revision and transport.",
    qualificationUnsupported: "Readiness is available only for an enabled connection with a supported task transport and task kind.",
    qualificationEnabledOnly: "This configuration is disabled; qualification is not current.",
    qualificationCurrent: (expiry: string) => `Server qualification is current for this transport until ${expiry}.`,
    qualificationNotCurrent: "The server did not provide a current qualification for this transport and owner session.",
    qualificationIssued: "A qualification challenge is issued; readiness is not confirmed.",
    qualificationExpired: "The server qualification has expired.",
    qualificationActor: "The verified service actor does not match the saved identity.",
    qualificationStale: "The server qualification is stale for this connection revision or transport.",
    connectionIdRequired: "Enter the logical connection ID.",
    connectionId: "Connection ID",
    stateOnly: "Configuration state",
    recheckChanged: "The selected revision changed before review. The newest fields are loaded; review again.",
    contourLabels: { GEMINI_SPARK: "Gemini Spark", META_MUSE: "Meta Muse", OPENAI_DOT: "OpenAI", OTHER: "Other" },
    transportLabels: { MCP_READ: "Read through MCP", MCP_WRITE: "Write through MCP", WEB_INBOX: "Web inbox" },
    computerLabels: {
      CLOUD_BROWSER: "Cloud browser", CLOUD_DESKTOP: "Cloud desktop", CLOUD_NETWORK: "Cloud network",
      LOCAL_COMPUTER: "Local computer", LOCAL_FILES: "Local files", LOCAL_SHELL: "Local shell",
      PYTHON_VM: "Python VM", CONNECTED_APPS: "Connected apps", SCHEDULED_WORK: "Scheduled work",
      PROACTIVE_WORK: "Proactive work", MESSAGING: "Messaging", SCREENSHOTS: "Screenshots",
    },
    taskLabels: { RESEARCH_BRANCH_ANALYSIS: "Research branch analysis" },
    qualificationLabels: { MCP_WRITE: "MCP write", WEB_INBOX: "Web inbox" },
  },
  ru: {
    title: "Подключения компьютерных агентов",
    explanation: "Управляйте реестром владельца. «Включено» описывает сохранённую конфигурацию, но не означает, что агент в сети.",
    loading: "Загружаются подключения компьютерных агентов.",
    loadFailed: "Не удалось прочитать текущую страницу подключений владельца.",
    retryPage: "Прочитать страницу ещё раз",
    empty: "Для этого владельца нет сохранённых подключений компьютерных агентов.",
    pageCount: (count: number) => `Текущая страница · ${count} из максимум 20 подключений`,
    previous: "Предыдущие 20",
    next: "Следующие 20",
    newConnection: "Новое подключение",
    selectConnection: "Выбрать эту конфигурацию",
    enabled: "Конфигурация включена",
    disabled: "Конфигурация отключена",
    technical: "Технические сведения",
    id: "Логический идентификатор подключения",
    revision: "Сохранённая ревизия",
    createHeading: "Настроить компьютерного агента",
    editHeading: "Проверить конфигурацию компьютерного агента",
    selectedUnavailable: "Выбранного подключения нет на проверенной странице. Прочитайте страницу ещё раз или выберите текущую строку.",
    changed: "Прочитана более новая ревизия. Проверьте обновлённые поля перед подготовкой изменения.",
    loadLatest: "Загрузить последние сохранённые поля",
    displayName: "Отображаемое имя",
    contour: "Контур провайдера",
    chooseContour: "Выберите контур",
    actor: "Идентификатор сервисного субъекта",
    issuer: "Издатель сервисного субъекта",
    subject: "Субъект сервисного аккаунта",
    fixedAuth: "Метод аутентификации: service_token. Секретные значения здесь не вводятся.",
    immutableActor: "Нельзя переназначить сохранённого сервисного субъекта для существующего логического подключения.",
    transport: "Возможности транспорта",
    computer: "Возможности компьютера",
    tasks: "Поддерживаемые типы задач",
    capabilityNote: "Сохраняются только отмеченные возможности. Неотмеченные права не добавляются автоматически.",
    taskRouteRequired: "Выберите MCP_WRITE или WEB_INBOX и явно отметьте поддерживаемый тип задачи.",
    requiredFields: "Заполните обязательные идентификаторы подключения, имя, контур и поля сервисного субъекта.",
    confirmEnable: "Я понимаю, что сохранение создаст или включит это подключение.",
    willEnable: "Сохранение этой формы создаст или включит подключение.",
    reviewPut: "Проверить и подготовить сохранение",
    reviewDisable: "Проверить отключение",
    saveEnabled: "Подтвердить сохранение включённой конфигурации",
    disableExact: (revision: number) => `Подтвердить отключение ревизии ${revision}`,
    editDraft: "Изменить неподтверждённую форму",
    disable: "Отключить сохранённое подключение",
    alreadyDisabled: "Эта конфигурация уже отключена.",
    reviewTitle: "Проверьте это изменение",
    actionCreate: "Создать и включить",
    actionUpdate: "Обновить и оставить включённым",
    actionDisable: "Отключить",
    expectedRevision: "Ожидаемая текущая ревизия",
    resultState: "Итоговое состояние конфигурации",
    enabledResult: "Включено",
    disabledResult: "Отключено",
    preparing: "Читается выбранная ревизия перед подготовкой изменения.",
    prepareFailed: "Не удалось подготовить изменение по текущей конфигурации владельца. Прочитайте страницу и проверьте поля.",
    prepareStale: "Выбранная ревизия изменилась. Загружены последние поля; проверьте их перед продолжением.",
    operationAttempting: "Отправляется точное проверенное изменение владельца.",
    operationUnknown: "Результат неизвестен. Точное проверенное действие и исходный идентификатор запроса сохранены.",
    operationUnknownMatches: "Защищённое чтение совпадает с запрошенным результатом, но нужна каноническая квитанция.",
    operationUnknownDiffers: "Защищённое чтение не подтверждает запрошенный результат. Проверенное действие не изменено.",
    retrySame: "Повторить то же проверенное действие",
    readback: "Повторно прочитать защищённую конфигурацию",
    readbackNext: "Прочитать следующие 20 подключений",
    readbackFirst: "Прочитать с первой страницы",
    readbackFailed: "Защищённое чтение не удалось. Новое изменение не подготовлено.",
    receiptLag: (revision: number) => `Сервер вернул квитанцию для ревизии ${revision}; защищённое чтение списка пока её не подтвердило.`,
    confirmed: (revision: number) => `Изменение подтверждено квитанцией и защищённым чтением ревизии ${revision}.`,
    sessionLost: "Сеанс владельца больше не актуален. Защищённые сведения о подключении скрыты.",
    qualification: "Квалификация транспорта",
    qualificationChoose: "Выберите поддерживаемый транспорт",
    qualificationRead: "Прочитать квалификацию",
    qualificationNotRead: "Квалификация для транспорта ещё не прочитана.",
    qualificationLoading: "Читается серверная квалификация этого транспорта.",
    qualificationFailed: "Не удалось прочитать квалификацию этой ревизии подключения и транспорта.",
    qualificationUnsupported: "Готовность доступна только для включённого подключения с поддерживаемым транспортом и типом задачи.",
    qualificationEnabledOnly: "Конфигурация отключена; квалификация не актуальна.",
    qualificationCurrent: (expiry: string) => `Серверная квалификация этого транспорта актуальна до ${expiry}.`,
    qualificationNotCurrent: "Сервер не подтвердил актуальную квалификацию этого транспорта и сеанса владельца.",
    qualificationIssued: "Выпущено испытание квалификации; готовность не подтверждена.",
    qualificationExpired: "Срок серверной квалификации истёк.",
    qualificationActor: "Проверенный сервисный субъект не совпадает с сохранённой идентичностью.",
    qualificationStale: "Серверная квалификация устарела для этой ревизии подключения или транспорта.",
    connectionIdRequired: "Введите логический идентификатор подключения.",
    connectionId: "Идентификатор подключения",
    stateOnly: "Состояние конфигурации",
    recheckChanged: "До проверки изменилась выбранная ревизия. Загружены последние поля; проверьте их ещё раз.",
    contourLabels: { GEMINI_SPARK: "Gemini Spark", META_MUSE: "Meta Muse", OPENAI_DOT: "OpenAI", OTHER: "Другое" },
    transportLabels: { MCP_READ: "Чтение через MCP", MCP_WRITE: "Запись через MCP", WEB_INBOX: "Веб-входящие" },
    computerLabels: {
      CLOUD_BROWSER: "Облачный браузер", CLOUD_DESKTOP: "Облачный рабочий стол", CLOUD_NETWORK: "Облачная сеть",
      LOCAL_COMPUTER: "Локальный компьютер", LOCAL_FILES: "Локальные файлы", LOCAL_SHELL: "Локальная оболочка",
      PYTHON_VM: "Виртуальная машина Python", CONNECTED_APPS: "Подключённые приложения", SCHEDULED_WORK: "Запланированная работа",
      PROACTIVE_WORK: "Проактивная работа", MESSAGING: "Обмен сообщениями", SCREENSHOTS: "Снимки экрана",
    },
    taskLabels: { RESEARCH_BRANCH_ANALYSIS: "Анализ ветви исследования" },
    qualificationLabels: { MCP_WRITE: "Запись через MCP", WEB_INBOX: "Веб-входящие" },
  },
} as const;

function contextKey(context: SessionContext): string {
  return [context.cacheEpoch, context.principal, context.credentialGeneration, context.deploymentGeneration].join("\u001f");
}

// React Query replaces stored data with a structural clone that is no longer frozen, but the strict
// owner SDK only accepts an immutable prepared intent (intentInput requires Object.isFrozen). Re-freeze
// the intent read back from the protected entry so the same frozen request identity is executed. The
// idempotency key and reviewed body are unchanged strings, so this preserves identity, never re-mints.
function restoreOperation(operation: ConnectionOperation | undefined): ConnectionOperation | undefined {
  if (operation === undefined || Object.isFrozen(operation.intent)) return operation;
  return { ...operation, intent: Object.freeze({ ...operation.intent }) };
}

function emptyForm(): ConnectionForm {
  return {
    connectionId: "", displayName: "", contour: "", issuer: "", subject: "",
    transportCapabilities: [], computerCapabilities: [], taskKinds: [], confirmEnable: false,
  };
}

function formFromConnection(connection: ComputerAgentConnection): ConnectionForm {
  return {
    connectionId: connection.connection_id,
    displayName: connection.display_name,
    contour: connection.contour,
    issuer: connection.actor.issuer,
    subject: connection.actor.subject,
    transportCapabilities: [...connection.transport_capabilities],
    computerCapabilities: [...connection.computer_capabilities],
    taskKinds: [...connection.task_kinds],
    confirmEnable: false,
  };
}

function toggle<T extends string>(values: readonly T[], value: T, checked: boolean): T[] {
  return checked ? (values.includes(value) ? [...values] : [...values, value]) : values.filter(item => item !== value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sameConnection(left: ComputerAgentConnection, right: ComputerAgentConnection): boolean {
  return left.connection_id === right.connection_id && left.revision === right.revision &&
    left.owner_principal_ref === right.owner_principal_ref && left.state === right.state &&
    left.display_name === right.display_name && left.contour === right.contour &&
    left.actor.issuer === right.actor.issuer && left.actor.authentication_method === right.actor.authentication_method &&
    left.actor.subject === right.actor.subject && sameStrings(left.transport_capabilities, right.transport_capabilities) &&
    sameStrings(left.computer_capabilities, right.computer_capabilities) && sameStrings(left.task_kinds, right.task_kinds) &&
    left.created_at === right.created_at && left.updated_at === right.updated_at;
}

function putFromForm(form: ConnectionForm, expectedRevision: number): ComputerAgentConnectionPutInput | undefined {
  if (!form.contour || form.connectionId.length === 0 || form.displayName.length === 0 ||
      form.issuer.length === 0 || form.subject.length === 0 || form.transportCapabilities.length === 0 ||
      !form.transportCapabilities.some(value => value === "MCP_WRITE" || value === "WEB_INBOX") ||
      !form.taskKinds.includes("RESEARCH_BRANCH_ANALYSIS")) return undefined;
  return {
    display_name: form.displayName,
    contour: form.contour,
    actor: { issuer: form.issuer, authentication_method: "service_token", subject: form.subject },
    transport_capabilities: [...form.transportCapabilities],
    computer_capabilities: [...form.computerCapabilities],
    task_kinds: [...form.taskKinds],
    expected_revision: expectedRevision,
  };
}

function connectionMatchesAction(connection: ComputerAgentConnection, operation: ConnectionOperation, principal: string): boolean {
  if (connection.owner_principal_ref !== principal || connection.revision !== operation.intent.expectedRevision + 1) return false;
  if (operation.action.kind === "put") {
    const desired = operation.action.desired;
    return connection.state === "ENABLED" && connection.display_name === desired.display_name &&
      connection.contour === desired.contour && connection.actor.issuer === desired.actor.issuer &&
      connection.actor.authentication_method === desired.actor.authentication_method &&
      connection.actor.subject === desired.actor.subject &&
      sameStrings(connection.transport_capabilities, desired.transport_capabilities) &&
      sameStrings(connection.computer_capabilities, desired.computer_capabilities) &&
      sameStrings(connection.task_kinds, desired.task_kinds);
  }
  const previous = operation.action.previous;
  return connection.state === "DISABLED" && connection.display_name === previous.display_name &&
    connection.contour === previous.contour && connection.actor.issuer === previous.actor.issuer &&
    connection.actor.authentication_method === previous.actor.authentication_method &&
    connection.actor.subject === previous.actor.subject &&
    sameStrings(connection.transport_capabilities, previous.transport_capabilities) &&
    sameStrings(connection.computer_capabilities, previous.computer_capabilities) &&
    sameStrings(connection.task_kinds, previous.task_kinds);
}

function qualificationIsCurrent(
  status: ComputerAgentQualificationStatus,
  connection: ComputerAgentConnection,
  context: SessionContext,
  transport: QualificationTransport,
  now: number,
): boolean {
  return status.status === "READY" && status.connection_id === connection.connection_id &&
    status.connection_revision === connection.revision && status.transport === transport &&
    status.deployment_generation === context.deploymentGeneration &&
    status.verified_credential_generation === context.credentialGeneration &&
    status.ready_until !== undefined && Date.parse(status.ready_until) > now;
}

export function ComputerAgentMutationNotice({ locale, state, onReadback, onRetrySameAction }: {
  readonly locale: Locale;
  readonly state: ComputerAgentMutationNoticeState;
  readonly onReadback?: (() => void) | undefined;
  readonly onRetrySameAction?: (() => void) | undefined;
}) {
  const text = copy[locale];
  if (state.kind === "session-lost") return <Status tone="error" announce>{text.sessionLost}</Status>;
  if (state.kind === "confirmed") return <Status announce>{text.confirmed(state.revision)}</Status>;
  if (state.kind === "receipt-pending-readback") return <div>
    <Status announce>{text.receiptLag(state.revision)}</Status>
    {onReadback && <Button variant="tonal" onClick={onReadback}>{text.readback}</Button>}
  </div>;
  return <div>
    <Status tone="error" announce>{state.readbackMatches ? text.operationUnknownMatches : text.operationUnknown}</Status>
    {!state.readbackMatches && <p>{text.operationUnknownDiffers}</p>}
    {onReadback && <Button variant="tonal" onClick={onReadback}>{text.readback}</Button>}
    {state.canRetrySameAction && onRetrySameAction &&
      <Button variant="text" onClick={onRetrySameAction}>{text.retrySame}</Button>}
  </div>;
}

export function ComputerAgentConnectionsPanel({ locale, apis, privacy, context }: {
  readonly locale: Locale;
  readonly apis: BoundWorkspaceApis;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
}) {
  const text = copy[locale];
  const ownerContextKey = contextKey(context);
  const privacyRevision = privacy.getSnapshot().revision;
  const contextCurrent = privacy.isCurrent(context);
  const queryClient = useQueryClient();
  const [afterConnectionId, setAfterConnectionId] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [selection, setSelection] = useState<SelectedConnection>();
  const [formState, setFormState] = useState<{ readonly contextKey: string; readonly value: ConnectionForm }>(() => ({
    contextKey: ownerContextKey, value: emptyForm(),
  }));
  const form = formState.contextKey === ownerContextKey ? formState.value : emptyForm();
  const [formError, setFormError] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const attemptingRef = useRef(false);
  // An unsettled operation must survive an ordinary route unmount/remount. Plain component state is
  // destroyed on remount, which would drop the frozen request identity (idempotency key, reviewed
  // body, action, phase and any receipt). Hold it in a protected QueryClient entry keyed by the
  // owner context, mirroring StudioPanel's local-intent memory: gcTime Infinity keeps it out of
  // garbage collection while the entry exists. Only the current owner context may write it; owner
  // loss is handled by the privacy controller's clearProtected(), which clears the workspace cache.
  const operationKey = useMemo(
    () => computerAgentConnectionOperationKey(context),
    [context],
  );
  const operationQuery = useQuery<ConnectionOperation | null>({
    queryKey: operationKey,
    queryFn: skipToken,
    gcTime: Infinity,
    // Retain the already frozen mutation identity by reference across route unmount/remount.
    structuralSharing: false,
  });
  const writeOperation = useCallback((update: (current: ConnectionOperation | undefined) => ConnectionOperation | undefined) => {
    if (!privacy.isCurrent(context)) return;
    // undefined means "do not update" to QueryClient; use an explicit empty
    // value so canceling a review actually releases its protected intent.
    queryClient.setQueryData<ConnectionOperation | null>(operationKey, current => update(current ?? undefined) ?? null);
  }, [context, operationKey, privacy, queryClient]);
  // On unmount, a mutation that was still attempting has an unknown outcome. Transition the held
  // operation to UNKNOWN rather than dropping it or leaving a stale "attempting" phase. A receipt
  // that arrives after unmount still upgrades the held entry (see attempt()); an unknown that
  // survives unmount is never downgraded again. The attempting guard resets per mount so a remount
  // does not believe a stale in-flight attempt is still running and never autoresends it.
  useEffect(() => {
    attemptingRef.current = false;
    return () => {
      attemptingRef.current = false;
      if (privacy.isCurrent(context)) writeOperation(current =>
        current?.contextKey === ownerContextKey && current.phase === "attempting"
          ? { ...current, phase: "unknown" as const }
          : current);
    };
  }, [context, ownerContextKey, privacy, writeOperation]);
  // Restore the same identity only within the exact current owner context.
  const operation = operationQuery.data?.contextKey === ownerContextKey
    ? restoreOperation(operationQuery.data)
    : undefined;
  const [qualificationTarget, setQualificationTarget] = useState<QualificationTarget>();
  const [qualificationNow, setQualificationNow] = useState(() => Date.now());
  const idPrefix = useId();

  const pageOptions = computerAgentQueryOptions(apis, privacy, context, afterConnectionId);
  const pageQuery = useQuery({ ...pageOptions, enabled: contextCurrent, staleTime: 0, gcTime: 0 });
  const page = pageQuery.isError ? undefined : pageQuery.data;
  const selected = selection?.contextKey === ownerContextKey ? selection : undefined;
  const selectedConnection = selected && selected.cursor === afterConnectionId
    ? page?.connections.find(item => item.connection_id === selected.connection.connection_id)
    : undefined;
  const selectedChanged = selected !== undefined && selectedConnection !== undefined &&
    !sameConnection(selected.connection, selectedConnection);
  const operationLocked = operation !== undefined && operation.phase !== "settled";
  const supportedQualificationTransports = selectedConnection?.state === "ENABLED" &&
    selectedConnection.task_kinds.includes("RESEARCH_BRANCH_ANALYSIS")
    ? QUALIFICATION_TRANSPORTS.filter(transport => selectedConnection.transport_capabilities.includes(transport))
    : [];
  const targetMatchesSelection = qualificationTarget?.contextKey === ownerContextKey &&
    selectedConnection !== undefined && qualificationTarget.connectionId === selectedConnection.connection_id &&
    qualificationTarget.revision === selectedConnection.revision &&
    supportedQualificationTransports.includes(qualificationTarget.transport);
  const qualificationOptions = targetMatchesSelection && selectedConnection && qualificationTarget
    ? computerAgentQualificationOptions(apis, privacy, context, selectedConnection, qualificationTarget.transport)
    : undefined;
  const qualificationQueryKey = qualificationOptions?.queryKey ??
    [...protectedQueryKey(context, "computer-agent-qualification"), "unselected"] as const;
  const qualificationQuery = useQuery<ComputerAgentQualificationStatus | undefined>({
    queryKey: qualificationQueryKey,
    queryFn: qualificationOptions?.queryFn ?? (async () => undefined),
    enabled: false,
    staleTime: 0,
    gcTime: 0,
  });
  const qualificationStatus = qualificationQuery.isError ? undefined : qualificationQuery.data;
  const qualificationReady = qualificationStatus !== undefined && selectedConnection !== undefined &&
    qualificationTarget !== undefined && qualificationIsCurrent(
      qualificationStatus, selectedConnection, context, qualificationTarget.transport, qualificationNow,
    );
  const actions = computerAgentConnectionMutationActions(apis, privacy, context);
  const reportCanonicalCommit = useCanonicalCommitReport(() => {
    void queryClient.invalidateQueries({
      queryKey: protectedQueryKey(context, "computer-agent-qualification"),
      refetchType: "none",
    });
  });

  useEffect(() => {
    if (!privacy.isCurrent(context)) {
      setSelection(undefined);
      setFormState({ contextKey: ownerContextKey, value: emptyForm() });
      setQualificationTarget(undefined);
      setFormError(undefined);
      return;
    }
    if (formState.contextKey !== ownerContextKey) {
      setSelection(undefined);
      setFormState({ contextKey: ownerContextKey, value: emptyForm() });
      setQualificationTarget(undefined);
      setFormError(undefined);
    }
  }, [context, formState.contextKey, ownerContextKey, privacy, privacyRevision]);

  useEffect(() => {
    const readyUntil = qualificationReady ? qualificationStatus?.ready_until : undefined;
    if (!readyUntil) return undefined;
    const delay = Math.max(0, Date.parse(readyUntil) - Date.now() + 1);
    const timer = window.setTimeout(() => setQualificationNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [qualificationReady, qualificationStatus?.ready_until]);

  function updateForm(update: (current: ConnectionForm) => ConnectionForm): void {
    setFormState(current => ({
      contextKey: ownerContextKey,
      value: update(current.contextKey === ownerContextKey ? current.value : emptyForm()),
    }));
    setFormError(undefined);
    if (operation?.phase === "settled") writeOperation(() => undefined);
  }

  function startNewConnection(): void {
    if (!privacy.isCurrent(context) || operationLocked) return;
    setSelection(undefined);
    setQualificationTarget(undefined);
    setFormState({ contextKey: ownerContextKey, value: emptyForm() });
    setFormError(undefined);
    writeOperation(() => undefined);
  }

  function selectConnection(connection: ComputerAgentConnection): void {
    if (!privacy.isCurrent(context) || operationLocked) return;
    setSelection({ contextKey: ownerContextKey, cursor: afterConnectionId, connection });
    setFormState({ contextKey: ownerContextKey, value: formFromConnection(connection) });
    setQualificationTarget(undefined);
    setFormError(undefined);
    writeOperation(() => undefined);
  }

  function loadLatestSelection(): void {
    if (!privacy.isCurrent(context) || !selectedConnection || !selected) return;
    setSelection({ contextKey: ownerContextKey, cursor: afterConnectionId, connection: selectedConnection });
    setFormState({ contextKey: ownerContextKey, value: formFromConnection(selectedConnection) });
    setQualificationTarget(undefined);
    setFormError(undefined);
  }

  function movePage(cursor: string | undefined, history: Array<string | undefined>): void {
    if (!privacy.isCurrent(context) || operationLocked) return;
    setSelection(undefined);
    setFormState({ contextKey: ownerContextKey, value: emptyForm() });
    setQualificationTarget(undefined);
    writeOperation(() => undefined);
    setFormError(undefined);
    setCursorHistory(history);
    setAfterConnectionId(cursor);
  }

  async function acceptReadbackPage(cursor: string | undefined, page: ComputerAgentConnectionReadbackPage["page"]): Promise<boolean> {
    const listKey = [...protectedQueryKey(context, "computer-agents"), cursor ?? null] as const;
    await queryClient.cancelQueries({ queryKey: listKey, exact: true });
    if (!privacy.isCurrent(context)) return false;
    queryClient.setQueryData(listKey, page);
    return true;
  }

  async function readbackFor(operationToRead: ConnectionOperation, cursor?: string): Promise<void> {
    if (!privacy.isCurrent(context)) return;
    const readbackOptions = computerAgentConnectionReadbackPageOptions(
      apis, privacy, context, operationToRead.intent.connectionId, cursor,
    );
    try {
      const result = await queryClient.fetchQuery({ ...readbackOptions, staleTime: 0, gcTime: 0 });
      if (!privacy.isCurrent(context) || operationToRead.contextKey !== ownerContextKey) return;
      if (!await acceptReadbackPage(cursor, result.page)) return;
      const receipt = operationToRead.receipt;
      if (receipt && result.connection && result.connection.owner_principal_ref === context.principal &&
          sameConnection(receipt, result.connection)) {
        if (afterConnectionId !== cursor) {
          setCursorHistory(cursor === undefined ? [] : [undefined]);
          setAfterConnectionId(cursor);
        }
        setSelection({ contextKey: ownerContextKey, cursor, connection: result.connection });
        setFormState({ contextKey: ownerContextKey, value: formFromConnection(result.connection) });
        setQualificationTarget(undefined);
        writeOperation(current => current?.intent.idempotencyKey === operationToRead.intent.idempotencyKey
          ? { ...current, phase: "settled", receipt, lastReadback: { ...result, cursor }, readbackError: false }
          : current);
        reportCanonicalCommit(`computer-agent:${result.connection.connection_id}:${result.connection.revision}`);
        return;
      }
      writeOperation(current => current?.intent.idempotencyKey === operationToRead.intent.idempotencyKey
        ? { ...current, lastReadback: { ...result, cursor }, readbackError: false }
        : current);
    } catch {
      if (!privacy.isCurrent(context)) return;
      writeOperation(current => current?.intent.idempotencyKey === operationToRead.intent.idempotencyKey
        ? { ...current, readbackError: true }
        : current);
    }
  }

  async function prepareForm(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!privacy.isCurrent(context) || operationLocked || preparingRef.current || selected && !selectedConnection || selectedChanged) return;
    const expectedRevision = selectedConnection?.revision ?? 0;
    const desired = putFromForm(form, expectedRevision);
    if (!desired) {
      setFormError(text.taskRouteRequired);
      if (form.connectionId.length === 0) setFormError(text.connectionIdRequired);
      return;
    }
    if ((!selectedConnection || selectedConnection.state === "DISABLED") && !form.confirmEnable) {
      setFormError(text.confirmEnable);
      return;
    }
    preparingRef.current = true;
    setPreparing(true);
    try {
      let current = selectedConnection;
      if (selected && current) {
        const readbackOptions = computerAgentConnectionReadbackPageOptions(
          apis, privacy, context, current.connection_id, selected.cursor,
        );
        const fresh = await queryClient.fetchQuery({ ...readbackOptions, staleTime: 0, gcTime: 0 });
        if (!privacy.isCurrent(context)) return;
        if (!await acceptReadbackPage(selected.cursor, fresh.page)) return;
        if (!fresh.connection) {
          setFormError(text.selectedUnavailable);
          return;
        }
        if (!sameConnection(selected.connection, fresh.connection)) {
          setSelection({ contextKey: ownerContextKey, cursor: selected.cursor, connection: fresh.connection });
          setFormState({ contextKey: ownerContextKey, value: formFromConnection(fresh.connection) });
          setFormError(text.recheckChanged);
          setQualificationTarget(undefined);
          return;
        }
        current = fresh.connection;
      }
      const reviewedPut = putFromForm(form, current?.revision ?? 0);
      if (!reviewedPut) {
        setFormError(text.taskRouteRequired);
        return;
      }
      const intent = actions.preparePut(form.connectionId, reviewedPut, current);
      writeOperation(() => ({
        contextKey: ownerContextKey,
        intent,
        action: { kind: "put", desired: reviewedPut, ...(current ? { previous: current } : {}) },
        pageCursor: selected?.cursor,
        phase: "review",
        readbackError: false,
      }));
      setFormError(undefined);
    } catch {
      if (privacy.isCurrent(context)) setFormError(text.prepareFailed);
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  async function prepareDisable(): Promise<void> {
    if (!privacy.isCurrent(context) || operationLocked || preparingRef.current || !selected || !selectedConnection ||
        selectedChanged || selectedConnection.state !== "ENABLED") return;
    preparingRef.current = true;
    setPreparing(true);
    try {
      const readbackOptions = computerAgentConnectionReadbackPageOptions(
        apis, privacy, context, selectedConnection.connection_id, selected.cursor,
      );
      const fresh = await queryClient.fetchQuery({ ...readbackOptions, staleTime: 0, gcTime: 0 });
      if (!privacy.isCurrent(context)) return;
      if (!await acceptReadbackPage(selected.cursor, fresh.page)) return;
      if (!fresh.connection) {
        setFormError(text.selectedUnavailable);
        return;
      }
      if (!sameConnection(selected.connection, fresh.connection)) {
        setSelection({ contextKey: ownerContextKey, cursor: selected.cursor, connection: fresh.connection });
        setFormState({ contextKey: ownerContextKey, value: formFromConnection(fresh.connection) });
        setFormError(text.recheckChanged);
        setQualificationTarget(undefined);
        return;
      }
      const intent = actions.prepareDisable(fresh.connection);
      const disabled = fresh.connection;
      writeOperation(() => ({
        contextKey: ownerContextKey,
        intent,
        action: { kind: "disable", previous: disabled },
        pageCursor: selected.cursor,
        phase: "review",
        readbackError: false,
      }));
      setFormError(undefined);
    } catch {
      if (privacy.isCurrent(context)) setFormError(text.prepareFailed);
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  async function attempt(operationToRun: ConnectionOperation): Promise<void> {
    if (!privacy.isCurrent(context) || attemptingRef.current ||
        (operationToRun.phase !== "review" && operationToRun.phase !== "unknown") ||
        (operationToRun.phase === "unknown" && operationToRun.lastReadback === undefined)) return;
    const intentKey = operationToRun.intent.idempotencyKey;
    const heldOperation = queryClient.getQueryData<ConnectionOperation>(operationKey);
    if (heldOperation?.intent.idempotencyKey !== intentKey || heldOperation.phase !== operationToRun.phase) return;
    attemptingRef.current = true;
    const inFlight: ConnectionOperation = {
      contextKey: operationToRun.contextKey,
      intent: operationToRun.intent,
      action: operationToRun.action,
      pageCursor: operationToRun.pageCursor,
      phase: "attempting",
      readbackError: false,
    };
    writeOperation(current => current?.intent.idempotencyKey === intentKey && current.phase === operationToRun.phase
      ? inFlight
      : current);
    const startedOperation = queryClient.getQueryData<ConnectionOperation>(operationKey);
    if (!privacy.isCurrent(context) || startedOperation?.intent.idempotencyKey !== intentKey ||
        startedOperation.phase !== "attempting") {
      attemptingRef.current = false;
      return;
    }
    try {
      const receipt = await actions.execute(operationToRun.intent);
      if (!privacy.isCurrent(context)) return;
      const withReceipt: ConnectionOperation = {
        contextKey: inFlight.contextKey,
        intent: inFlight.intent,
        action: inFlight.action,
        pageCursor: inFlight.pageCursor,
        phase: "receipt",
        receipt,
        readbackError: false,
      };
      writeOperation(current => current?.intent.idempotencyKey === intentKey
        ? current.phase === "settled"
          ? current
          : { ...current, phase: "receipt", receipt, readbackError: false }
        : current);
      await readbackFor(withReceipt, withReceipt.pageCursor);
    } catch {
      if (!privacy.isCurrent(context)) return;
      const unknown: ConnectionOperation = { ...inFlight, phase: "unknown", readbackError: false };
      writeOperation(current => current?.intent.idempotencyKey === intentKey &&
          current.phase !== "receipt" && current.phase !== "settled"
        ? { ...current, phase: "unknown", readbackError: false }
        : current);
      await readbackFor(unknown, unknown.pageCursor);
    } finally {
      attemptingRef.current = false;
    }
  }

  function retryPage(): void {
    if (!privacy.isCurrent(context)) return;
    void queryClient.fetchQuery({ ...pageOptions, staleTime: 0, gcTime: 0 }).catch(() => undefined);
  }

  function readQualification(): void {
    if (!privacy.isCurrent(context) || !qualificationOptions || !targetMatchesSelection) return;
    setQualificationNow(Date.now());
    void queryClient.fetchQuery({ ...qualificationOptions, staleTime: 0, gcTime: 0 }).catch(() => undefined);
  }

  const readbackMatches = operation?.lastReadback?.connection !== undefined &&
    connectionMatchesAction(operation.lastReadback.connection, operation, context.principal);
  const noticeState: ComputerAgentMutationNoticeState | undefined = !contextCurrent
    ? { kind: "session-lost" }
    : operation?.phase === "unknown"
      ? { kind: "unknown", readbackMatches, canRetrySameAction: operation.lastReadback !== undefined }
      : operation?.phase === "receipt"
        ? { kind: "receipt-pending-readback", revision: operation.receipt?.revision ?? operation.intent.expectedRevision + 1 }
        : operation?.phase === "settled"
          ? { kind: "confirmed", revision: operation.receipt?.revision ?? operation.intent.expectedRevision + 1 }
          : undefined;
  const qualificationMessage = !selectedConnection
    ? text.qualificationNotRead
    : selectedConnection.state !== "ENABLED"
      ? text.qualificationEnabledOnly
      : supportedQualificationTransports.length === 0
        ? text.qualificationUnsupported
        : !targetMatchesSelection
          ? text.qualificationNotRead
          : qualificationQuery.isFetching
            ? text.qualificationLoading
            : qualificationQuery.isError
              ? text.qualificationFailed
              : qualificationStatus === undefined
                ? text.qualificationNotRead
                : qualificationReady && qualificationTarget && qualificationStatus.ready_until
                  ? text.qualificationCurrent(new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", {
                    dateStyle: "medium", timeStyle: "short",
                  }).format(new Date(qualificationStatus.ready_until)))
                  : qualificationStatus.status === "ISSUED"
                    ? text.qualificationIssued
                    : qualificationStatus.status === "EXPIRED"
                      ? text.qualificationExpired
                      : qualificationStatus.status === "ACTOR_MISMATCH"
                        ? text.qualificationActor
                        : qualificationStatus.status === "STALE"
                          ? text.qualificationStale
                          : text.qualificationNotCurrent;

  if (!contextCurrent) return <section className="er-agent-connections" aria-labelledby={`${idPrefix}-title`}>
    <h2 id={`${idPrefix}-title`}>{text.title}</h2>
    <ComputerAgentMutationNotice locale={locale} state={{ kind: "session-lost" }} />
  </section>;

  return <section className="er-live-connection-operation er-agent-connections" aria-labelledby={`${idPrefix}-title`}>
    <h2 id={`${idPrefix}-title`}>{text.title}</h2>
    <p>{text.explanation}</p>
    <OperationAnnouncement>{preparing ? text.preparing : operation?.phase === "attempting" ? text.operationAttempting : ""}</OperationAnnouncement>

    <div aria-busy={pageQuery.isFetching}>
      <p>{page ? text.pageCount(page.connections.length) : pageQuery.isPending ? text.loading : text.loadFailed}</p>
      {pageQuery.isError && <div>
        <Status tone="error">{text.loadFailed}</Status>
        <Button variant="tonal" onClick={retryPage}>{text.retryPage}</Button>
      </div>}
      {page && page.connections.length === 0 && <p>{text.empty}</p>}
      {page && page.connections.length > 0 && <ul>
        {page.connections.map(connection => <li key={connection.connection_id}>
          <Button variant="text" aria-pressed={selected?.connection.connection_id === connection.connection_id}
            aria-label={`${text.selectConnection}: ${connection.display_name} · ${connection.state === "ENABLED" ? text.enabled : text.disabled}`} disabled={operationLocked}
            onClick={() => selectConnection(connection)}>
            {connection.display_name} · {connection.state === "ENABLED" ? text.enabled : text.disabled}
          </Button>
        </li>)}
      </ul>}
      <div className="er-live-pagination">
        {cursorHistory.length > 0 && <Button variant="text" disabled={operationLocked}
          onClick={() => movePage(cursorHistory.at(-1), cursorHistory.slice(0, -1))}>{text.previous}</Button>}
        {page?.next_connection_id && <Button variant="tonal" disabled={operationLocked}
          onClick={() => movePage(page.next_connection_id, [...cursorHistory, afterConnectionId])}>{text.next}</Button>}
      </div>
    </div>

    <div className="er-live-pagination">
      <Button variant="tonal" disabled={operationLocked} onClick={startNewConnection}>{text.newConnection}</Button>
    </div>

    {selection && !selectedConnection && <Status tone="error">{text.selectedUnavailable}</Status>}
    {selectedChanged && <div>
      <Status tone="error">{text.changed}</Status>
      <Button variant="tonal" onClick={loadLatestSelection} disabled={operationLocked}>{text.loadLatest}</Button>
    </div>}

    {(!selection || selectedConnection) && <form onSubmit={event => { void prepareForm(event); }}>
      <fieldset disabled={operationLocked || preparing}>
        <legend>{selection ? text.editHeading : text.createHeading}</legend>
        {selection && selectedConnection
          ? <>
            <p>{text.actor}</p>
            <p>{text.issuer}: <code>{selectedConnection.actor.issuer}</code></p>
            <p>{text.subject}: <code>{selectedConnection.actor.subject}</code></p>
            <p>{text.immutableActor}</p>
          </>
          : <Field label={text.id} value={form.connectionId} maxLength={256} required
            onChange={event => updateForm(current => ({ ...current, connectionId: event.target.value }))} />}

        <Field label={text.displayName} value={form.displayName} maxLength={128} required
          onChange={event => updateForm(current => ({ ...current, displayName: event.target.value }))} />

        <div className="er-field">
          <label className="er-field__label" htmlFor={`${idPrefix}-contour`}>{text.contour}</label>
          <select id={`${idPrefix}-contour`} className="er-field__control" required value={form.contour}
            onChange={event => updateForm(current => ({ ...current, contour: event.target.value as ConnectionForm["contour"] }))}>
            <option value="">{text.chooseContour}</option>
            {CONTOURS.map(value => <option key={value} value={value}>{text.contourLabels[value]}</option>)}
          </select>
        </div>

        {!selection && <>
          <Field label={text.issuer} type="url" value={form.issuer} maxLength={256} required
            onChange={event => updateForm(current => ({ ...current, issuer: event.target.value }))} />
          <Field label={text.subject} value={form.subject} maxLength={256} required
            onChange={event => updateForm(current => ({ ...current, subject: event.target.value }))} />
          <p>{text.fixedAuth}</p>
        </>}

        <fieldset>
          <legend>{text.transport}</legend>
          {TRANSPORT_CAPABILITIES.map(value => <label key={value}>
            <input type="checkbox" checked={form.transportCapabilities.includes(value)}
              onChange={event => updateForm(current => ({
                ...current, transportCapabilities: toggle(current.transportCapabilities, value, event.target.checked),
              }))} /> {text.transportLabels[value]}
          </label>)}
        </fieldset>

        <fieldset>
          <legend>{text.computer}</legend>
          {COMPUTER_CAPABILITIES.map(value => <label key={value}>
            <input type="checkbox" checked={form.computerCapabilities.includes(value)}
              onChange={event => updateForm(current => ({
                ...current, computerCapabilities: toggle(current.computerCapabilities, value, event.target.checked),
              }))} /> {text.computerLabels[value]}
          </label>)}
        </fieldset>

        <fieldset>
          <legend>{text.tasks}</legend>
          {TASK_KINDS.map(value => <label key={value}>
            <input type="checkbox" checked={form.taskKinds.includes(value)}
              onChange={event => updateForm(current => ({
                ...current, taskKinds: toggle(current.taskKinds, value, event.target.checked),
              }))} /> {text.taskLabels[value]}
          </label>)}
        </fieldset>
        <p>{text.capabilityNote}</p>
        {(!selectedConnection || selectedConnection.state === "DISABLED") && <label>
          <input type="checkbox" checked={form.confirmEnable}
            onChange={event => updateForm(current => ({ ...current, confirmEnable: event.target.checked }))} /> {text.confirmEnable}
        </label>}
        {(!selectedConnection || selectedConnection.state === "DISABLED") && <p>{text.willEnable}</p>}
        {formError && <p role="alert">{formError}</p>}
        <Button variant="tonal" type="submit" loading={preparing} disabled={selectedChanged}>
          {text.reviewPut}
        </Button>
      </fieldset>
    </form>}

    {selectedConnection && !selectedChanged && <div>
      {selectedConnection.state === "ENABLED"
        ? <Button variant="text" onClick={() => { void prepareDisable(); }} disabled={operationLocked || preparing}>
          {text.reviewDisable}
        </Button>
        : <p>{text.alreadyDisabled}</p>}
      <div className="er-field">
        <label className="er-field__label" htmlFor={`${idPrefix}-qualification`}>{text.qualification}</label>
        <select id={`${idPrefix}-qualification`} className="er-field__control"
          value={targetMatchesSelection ? qualificationTarget.transport : ""}
          disabled={operationLocked || supportedQualificationTransports.length === 0}
          onChange={event => {
            const value = event.target.value as QualificationTransport | "";
            setQualificationTarget(value ? {
              contextKey: ownerContextKey, connectionId: selectedConnection.connection_id,
              revision: selectedConnection.revision, transport: value,
            } : undefined);
          }}>
          <option value="">{text.qualificationChoose}</option>
          {supportedQualificationTransports.map(value => <option key={value} value={value}>{text.qualificationLabels[value]}</option>)}
        </select>
      </div>
      <p>{qualificationMessage}</p>
      <Button variant="tonal" onClick={readQualification}
        disabled={operationLocked || !targetMatchesSelection || qualificationQuery.isFetching}>
        {text.qualificationRead}
      </Button>
      <details>
        <summary>{text.technical}</summary>
        <p>{text.id}: <code>{selectedConnection.connection_id}</code></p>
        <p>{text.revision}: {selectedConnection.revision}</p>
        <p>{text.stateOnly}: {selectedConnection.state === "ENABLED" ? text.enabled : text.disabled}</p>
      </details>
    </div>}

    {operation && operation.phase === "review" && <section aria-labelledby={`${idPrefix}-review`}>
      <h3 id={`${idPrefix}-review`}>{text.reviewTitle}</h3>
      <p>{operation.action.kind === "disable" ? text.actionDisable
        : operation.action.previous ? text.actionUpdate : text.actionCreate}</p>
      <p>{text.expectedRevision}: {operation.intent.expectedRevision}</p>
      <p>{text.resultState}: {operation.action.kind === "disable" ? text.disabledResult : text.enabledResult}</p>
      <Button variant="primary" onClick={() => { void attempt(operation); }}>
        {operation.action.kind === "disable" ? text.disableExact(operation.intent.expectedRevision) : text.saveEnabled}
      </Button>
      <Button variant="text" onClick={() => writeOperation(() => undefined)}>{text.editDraft}</Button>
    </section>}

    {operation && (operation.phase === "attempting" || operation.phase === "unknown" || operation.phase === "receipt" || operation.phase === "settled") && noticeState &&
      <section aria-label={text.reviewTitle}>
        {operation.phase === "attempting" && <Status announce>{text.operationAttempting}</Status>}
        {operation.phase !== "attempting" && <ComputerAgentMutationNotice locale={locale} state={noticeState}
          onReadback={operation.phase === "unknown" || operation.phase === "receipt"
            ? () => { void readbackFor(operation, operation.lastReadback?.cursor ?? operation.pageCursor); }
            : undefined}
          onRetrySameAction={operation.phase === "unknown" && operation.lastReadback !== undefined
            ? () => { void attempt(operation); }
            : undefined} />}
        {operation.readbackError && <p role="alert">{text.readbackFailed}</p>}
        {operation.lastReadback?.connection && <p>{operation.lastReadback.connection.display_name} · {text.revision}: {operation.lastReadback.connection.revision}</p>}
        {operation.lastReadback?.page.next_connection_id && <Button variant="text"
          onClick={() => { void readbackFor(operation, operation.lastReadback?.page.next_connection_id); }}>
          {text.readbackNext}
        </Button>}
        {operation.lastReadback && !operation.lastReadback.connection && !operation.lastReadback.page.next_connection_id &&
          operation.lastReadback.cursor !== undefined && <Button variant="text" onClick={() => { void readbackFor(operation, undefined); }}>
          {text.readbackFirst}
        </Button>}
      </section>}
  </section>;
}
