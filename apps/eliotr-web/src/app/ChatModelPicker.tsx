import { useId } from "react";
import { Button, MaterialSymbol, Status } from "@eliotr/ui";
import { modelCatalogEntryKey } from "../query/modelCatalog";
import type { ChatModelOption } from "../query/chatModelCatalog";
import "./model-selection.css";

export type ChatModelQualificationState = "idle" | "qualifying" | "ready" | "unknown";

const copy = {
  en: {
    label: "Chat model",
    placeholder: "Choose a model",
    search: "Search visible models",
    qualifying: "Checking model availability…",
    ready: "Model availability confirmed for this run.",
    unknown: "We couldn’t confirm model availability. Check again before sending.",
    empty: "No visible models were found for this search.",
    noProjectConfiguration: "This model isn’t available for this project yet.",
    qualificationUnavailable: "Provider access needs to be checked before this model can be used.",
    builtinUnavailable: "This model isn’t available in the current service configuration.",
    reading: "Reading visible model catalogs…",
    failed: "Model availability could not be checked.",
    previous: "Previous model page",
    next: "More models",
    check: "Check availability",
    find: "Find a model",
    unavailableShort: "unavailable",
  },
  ru: {
    label: "Модель чата",
    placeholder: "Выберите модель",
    search: "Поиск видимых моделей",
    qualifying: "Проверяем доступность модели…",
    ready: "Доступность модели подтверждена для запуска.",
    unknown: "Не удалось подтвердить доступность модели. Проверьте ещё раз перед отправкой.",
    empty: "Для этого поиска видимых моделей нет.",
    noProjectConfiguration: "Эта модель пока недоступна для проекта.",
    qualificationUnavailable: "Перед использованием нужно проверить доступ к провайдеру.",
    builtinUnavailable: "Эта модель недоступна в текущих настройках сервиса.",
    reading: "Читаем каталоги видимых моделей…",
    failed: "Не удалось проверить доступность модели.",
    previous: "Предыдущая страница моделей",
    next: "Больше моделей",
    check: "Проверить доступность",
    find: "Найти модель",
    unavailableShort: "недоступна",
  },
} as const;

type Choice = Pick<ChatModelOption["model"], "provider_id" | "model_id">;

export function ChatModelPicker({ locale, choices, selected, qualificationState = "idle", disabled, search, page,
  loading = false, failed = false, hasMore = false, checkDisabled, onSearchChange, onPageChange, onCheck, onSelect }: {
  readonly locale: "en" | "ru";
  /** Public catalog entries after applying saved owner visibility and project run eligibility. */
  readonly choices: readonly ChatModelOption[];
  readonly selected: Choice | undefined;
  readonly qualificationState?: ChatModelQualificationState;
  readonly disabled?: boolean;
  readonly search: string;
  readonly page: number;
  readonly loading?: boolean;
  readonly failed?: boolean;
  readonly hasMore?: boolean;
  readonly checkDisabled?: boolean;
  readonly onSearchChange: (value: string) => void;
  readonly onPageChange: (page: number) => void;
  readonly onCheck?: () => void;
  readonly onSelect: (candidate: ChatModelOption | undefined) => void;
}) {
  const id = useId(), text = copy[locale];
  const selectedKey = selected ? modelCatalogEntryKey(selected) : "";
  const byKey = new Map(choices.map(choice => [choice.key, choice]));
  // Native optgroups carry the provider, so each option is just the model's name; an unavailable
  // model says so briefly. Availability of the rest is checked automatically on choice.
  const groups = new Map<string, ChatModelOption[]>();
  for (const choice of choices) groups.set(choice.providerLabel, [...(groups.get(choice.providerLabel) ?? []), choice]);
  const current = byKey.get(selectedKey);
  const status = qualificationState === "qualifying" ? text.qualifying : qualificationState === "ready"
    ? text.ready : qualificationState === "unknown" ? text.unknown : undefined;
  const statusText = loading ? text.reading : failed ? text.failed : choices.length === 0 ? text.empty : status;
  const locked = disabled || qualificationState === "qualifying";
  return <section className="er-chat-model-picker" aria-labelledby={`${id}-label`}>
    <label id={`${id}-label`} className="er-chat-model-picker__label" htmlFor={`${id}-select`}>{text.label}</label>
    <span className="er-chat-model-picker__chip" data-disabled={locked || (choices.length === 0 && !selected) ? "true" : "false"}>
      <MaterialSymbol name="spark" />
      <select id={`${id}-select`} className="er-chat-model-picker__select" value={selectedKey}
        title={current ? `${current.model.name} · ${current.providerLabel}` : text.placeholder}
        disabled={locked || (choices.length === 0 && !selected)}
        onChange={event => onSelect(byKey.get(event.currentTarget.value))}>
        <option value="">{text.placeholder}</option>
        {selectedKey !== "" && !byKey.has(selectedKey) && <option value={selectedKey} disabled>
          {selected?.model_id}
        </option>}
        {[...groups].map(([provider, rows]) => <optgroup key={provider} label={provider}>
          {rows.map(choice => <option key={choice.key} value={choice.key} disabled={!choice.canRun}
            title={!choice.canRun ? reasonText(text, choice) : `${choice.model.name} · ${provider}`}>
            {choice.model.name}{!choice.canRun ? ` — ${text.unavailableShort}` : ""}
          </option>)}
        </optgroup>)}
      </select>
      <MaterialSymbol name="arrow-drop-down" />
    </span>
    <details className="er-chat-model-picker__find">
      <summary aria-label={text.find} title={text.find}><MaterialSymbol name="search" /></summary>
      <div className="er-chat-model-picker__find-panel">
        <label className="er-model-catalog__search" htmlFor={`${id}-search`}>
          <span>{text.search}</span>
          <input id={`${id}-search`} className="er-field__control" type="search" maxLength={512}
            value={search} disabled={locked}
            onChange={event => onSearchChange(event.currentTarget.value)} />
        </label>
        <nav className="er-model-catalog__pagination" aria-label={text.label}>
          <Button variant="text" disabled={disabled || page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>{text.previous}</Button>
          <span>{page}</span>
          <Button variant="text" disabled={disabled || !hasMore} onClick={() => onPageChange(page + 1)}>{text.next}</Button>
        </nav>
      </div>
    </details>
    {statusText !== undefined && <Status tone={failed || qualificationState === "unknown" ? "error" : "neutral"}>{statusText}</Status>}
    {(qualificationState === "unknown" || failed || (!loading && selected !== undefined && !byKey.has(selectedKey))) && onCheck &&
      <Button variant="text" disabled={checkDisabled ?? disabled} onClick={onCheck}>{text.check}</Button>}
  </section>;
}

function reasonText(text: (typeof copy)[keyof typeof copy], choice: ChatModelOption): string {
  return choice.unavailableReason === "project-configuration" ? text.noProjectConfiguration
    : choice.unavailableReason === "qualification" ? text.qualificationUnavailable
      : choice.unavailableReason === "builtin-default" ? text.builtinUnavailable : text.unavailableShort;
}
