/*
 * Owner control surface for agent work: presentation types and copy only.
 *
 * ERC is used mainly by agents (MCP, API, web inbox); the owner's interface steers them and decides
 * what they propose. Tools listed here are the system's own operations, never abstract verbs: a
 * request the system has no tool for is written as a plain chat request instead.
 */
import type { MaterialSymbolName } from "../../catalog/MaterialSymbol";

export type AgentWorkLocale = "en" | "ru";

/** System operations an owner or an agent can run; each maps to an existing ERC capability. */
export type ResearchToolId =
  | "search" | "mentions" | "verify" | "deep" | "overview"
  | "versions" | "changes" | "import" | "erase" | "document" | "wiki";

export type AgentTransport = "mcp" | "local" | "inbox";
export type AgentPresence = "ready" | "busy" | "offline";

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly transport: AgentTransport;
  readonly presence: AgentPresence;
}

export type TaskScopeKind = "research" | "section" | "claim" | "source";
export interface TaskScope {
  readonly id: string;
  readonly kind: TaskScopeKind;
  readonly label: string;
}

export type AgentTaskState = "waiting" | "working" | "decision" | "done" | "declined" | "expired";
export interface AgentTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly agent: string;
  readonly state: AgentTaskState;
  readonly tool?: ResearchToolId | undefined;
  readonly progress?: { readonly done: number; readonly total: number } | undefined;
}

/** "eliot" means the system runs the tool itself; any other value is an agent id. */
export interface HandoffRequest {
  readonly target: string;
  readonly tool: ResearchToolId | "request";
  readonly scope: readonly TaskScope[];
  readonly note: string;
}

/** Draft Inbox risk classes (architecture §9.6): D2 needs a verifier and the owner, D3 the owner only. */
export type DecisionRisk = "D0" | "D1" | "D2" | "D3";
export type DecisionKind = "document" | "sources" | "wiki" | "delete" | "permission";
export interface DecisionItem {
  readonly id: string;
  readonly kind: DecisionKind;
  readonly risk: DecisionRisk;
  readonly title: string;
  /** The agent or client that proposed it, when the read says so. */
  readonly from?: string | undefined;
  readonly detail?: string | undefined;
  readonly project?: string | undefined;
}

export const TOOL_ICON: Record<ResearchToolId | "request", MaterialSymbolName> = {
  search: "search", mentions: "find-in-page", verify: "fact-check", deep: "research", overview: "summarize",
  versions: "history", changes: "compare", import: "upload", erase: "delete", document: "document", wiki: "spark",
  request: "chat",
};

export const TOOL_ACCENT: Record<ResearchToolId | "request", "blue" | "green" | "violet" | "pink" | "amber"> = {
  search: "blue", mentions: "blue", verify: "green", deep: "violet", overview: "violet",
  versions: "green", changes: "green", import: "amber", erase: "pink", document: "pink", wiki: "violet", request: "blue",
};

export const DECISION_ICON: Record<DecisionKind, MaterialSymbolName> = {
  document: "document", sources: "add", wiki: "spark", delete: "delete", permission: "settings",
};

type ToolCopy = Record<ResearchToolId | "request", { readonly label: string; readonly hint: string }>;

export const AGENT_WORK_COPY = {
  en: {
    agents: "Agents", tools: "Tools", tasks: "Tasks", manageAgents: "Manage agents", noTasks: "Tasks you hand over appear here.", noAgents: "No agents are connected to this workspace yet.", agentsUnavailable: "Agent connections have not been read here yet.",
    presence: { ready: "Ready", busy: "Working", offline: "Offline" } satisfies Record<AgentPresence, string>,
    transport: { mcp: "MCP", local: "Local", inbox: "Web inbox" } satisfies Record<AgentTransport, string>,
    taskState: (state: AgentTaskState, progress?: { readonly done: number; readonly total: number }) => ({
      waiting: "Waiting for the agent", working: progress ? `Working · ${progress.done} of ${progress.total}` : "Working",
      decision: "Needs your decision", done: "Done", declined: "Declined by the agent", expired: "Expired",
    })[state],
    tool: {
      search: { label: "Search sources", hint: "Passages that answer a question" },
      mentions: { label: "All mentions", hint: "Every occurrence of a name or term" },
      verify: { label: "Check a claim", hint: "Support and contradictions in the sources" },
      deep: { label: "Deep research", hint: "A full investigation with a report" },
      overview: { label: "Source overview", hint: "What each source covers and where to read" },
      versions: { label: "Versions", hint: "Saved versions of a source" },
      changes: { label: "What changed", hint: "Changes since the last research" },
      import: { label: "Add sources", hint: "Upload or import documents" },
      erase: { label: "Delete versions", hint: "Only after your confirmation" },
      document: { label: "Save as document", hint: "A result as a separate document" },
      wiki: { label: "Wiki draft", hint: "Propose a Wiki page" },
      request: { label: "Your request", hint: "Anything else, in your own words" },
    } satisfies ToolCopy,
    sheet: {
      title: "Hand over", to: "To", system: "Eliot itself", tool: "Tool", what: "What to hand over", note: "Notes",
      notePlaceholder: "What to look at, what to skip, where to start", noteRequired: "Describe the request first.",
      scopeRequired: "Add at least one item to hand over.", remove: (label: string) => `Remove ${label}`,
      cancel: "Cancel", send: "Send", offline: "offline",
      eraseNote: "Deletion happens only after you confirm it in the Inbox.",
      summary: (target: string, tool: string, items: string) => `${target} · ${tool}: ${items}.`,
    },
    scopeKind: { research: "Research", section: "Section", claim: "Claim", source: "Source" } satisfies Record<TaskScopeKind, string>,
    inbox: {
      title: "Needs your decision", empty: "Nothing is waiting for you.", accept: "Accept", decline: "Decline",
      delete: "Delete", keep: "Keep", open: "Open", from: (agent: string) => `From ${agent}`,
      risk: { D0: "Mechanical", D1: "Additive", D2: "Analytical", D3: "Owner only" } satisfies Record<DecisionRisk, string>,
    },
  },
  ru: {
    agents: "Агенты", tools: "Инструменты", tasks: "Поручения", manageAgents: "Управление агентами", noTasks: "Здесь появятся ваши поручения.", noAgents: "К рабочему пространству пока не подключены агенты.", agentsUnavailable: "Подключения агентов здесь ещё не прочитаны.",
    presence: { ready: "Готов", busy: "Работает", offline: "Не в сети" } satisfies Record<AgentPresence, string>,
    transport: { mcp: "MCP", local: "Локально", inbox: "Веб-инбокс" } satisfies Record<AgentTransport, string>,
    taskState: (state: AgentTaskState, progress?: { readonly done: number; readonly total: number }) => ({
      waiting: "Ждёт агента", working: progress ? `Работает · ${progress.done} из ${progress.total}` : "Работает",
      decision: "Нужно ваше решение", done: "Готово", declined: "Агент отказался", expired: "Срок истёк",
    })[state],
    tool: {
      search: { label: "Поиск по источникам", hint: "Фрагменты, отвечающие на вопрос" },
      mentions: { label: "Все упоминания", hint: "Каждое упоминание имени или термина" },
      verify: { label: "Проверить утверждение", hint: "Подтверждения и противоречия в источниках" },
      deep: { label: "Глубокое исследование", hint: "Полный разбор с отчётом" },
      overview: { label: "Обзор источников", hint: "О чём каждый источник и где читать" },
      versions: { label: "Версии", hint: "Сохранённые версии источника" },
      changes: { label: "Что изменилось", hint: "Изменения с прошлого исследования" },
      import: { label: "Добавить источники", hint: "Загрузить или импортировать документы" },
      erase: { label: "Удалить версии", hint: "Только после вашего подтверждения" },
      document: { label: "Сохранить документом", hint: "Результат отдельным документом" },
      wiki: { label: "Черновик вики", hint: "Предложить страницу вики" },
      request: { label: "Свой запрос", hint: "Что угодно своими словами" },
    } satisfies ToolCopy,
    sheet: {
      title: "Поручение", to: "Кому", system: "Eliot сам", tool: "Инструмент", what: "Что передать", note: "Пожелания",
      notePlaceholder: "На что смотреть, что пропустить, с чего начать", noteRequired: "Сначала опишите запрос.",
      scopeRequired: "Добавьте хотя бы один элемент.", remove: (label: string) => `Убрать «${label}»`,
      cancel: "Отмена", send: "Отправить", offline: "не в сети",
      eraseNote: "Удаление выполнится только после вашего подтверждения во «Входящих».",
      summary: (target: string, tool: string, items: string) => `${target} · ${tool}: ${items}.`,
    },
    scopeKind: { research: "Исследование", section: "Раздел", claim: "Утверждение", source: "Источник" } satisfies Record<TaskScopeKind, string>,
    inbox: {
      title: "Ждут вашего решения", empty: "Решений, которые ждут вас, нет.", accept: "Принять", decline: "Отклонить",
      delete: "Удалить", keep: "Оставить", open: "Открыть", from: (agent: string) => `От: ${agent}`,
      risk: { D0: "Механическая правка", D1: "Дополнение", D2: "Аналитика", D3: "Только владелец" } satisfies Record<DecisionRisk, string>,
    },
  },
} as const;
