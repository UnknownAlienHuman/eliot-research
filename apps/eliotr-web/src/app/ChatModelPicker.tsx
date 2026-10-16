import { useId } from "react";
import { Button, Status } from "@eliotr/ui";
import { modelCatalogEntryKey } from "../query/modelCatalog";
import type { ChatModelOption } from "../query/chatModelCatalog";
import "./model-selection.css";

export type ChatModelQualificationState = "idle" | "qualifying" | "ready" | "unknown";

const copy = {
  en: {
    label: "Chat model",
    placeholder: "Choose a model",
    search: "Search visible models",
    helper: "Choose a model for this chat. We’ll check availability before starting.",
    idle: "Choose a visible model for this chat.",
    qualifying: "Checking model availability…",
    ready: "Model availability confirmed for this run.",
    unknown: "We couldn’t confirm model availability. Check again before sending.",
    empty: "No visible models were found for this search.",
    noProjectConfiguration: "This model isn’t available for this project yet.",
    qualificationUnavailable: "Provider access needs to be checked before this model can be used.",
    builtinUnavailable: "This model isn’t available in the current service configuration.",
    builtin: "Available",
    qualified: "Available",
    needsQualification: "Availability check needed",
    accountUnverified: "Access not confirmed",
    accountUnknown: "Access unknown",
    reading: "Reading visible model catalogs…",
    failed: "Model availability could not be checked.",
    previous: "Previous model page",
    next: "More models",
    check: "Check availability",
  },
  ru: {
    label: "Модель чата",
    placeholder: "Выберите модель",
    search: "Поиск видимых моделей",
    helper: "Выберите модель для чата. Перед запуском мы проверим её доступность.",
    idle: "Выберите видимую модель для этого чата.",
    qualifying: "Проверяем доступность модели…",
    ready: "Доступность модели подтверждена для запуска.",
    unknown: "Не удалось подтвердить доступность модели. Проверьте ещё раз перед отправкой.",
    empty: "Для этого поиска видимых моделей нет.",
    noProjectConfiguration: "Эта модель пока недоступна для проекта.",
    qualificationUnavailable: "Перед использованием нужно проверить доступ к провайдеру.",
    builtinUnavailable: "Эта модель недоступна в текущих настройках сервиса.",
    builtin: "Доступна",
    qualified: "Доступна",
    needsQualification: "Нужно проверить доступность",
    accountUnverified: "Доступ не подтверждён",
    accountUnknown: "Доступ неизвестен",
    reading: "Читаем каталоги видимых моделей…",
    failed: "Не удалось проверить доступность модели.",
    previous: "Предыдущая страница моделей",
    next: "Больше моделей",
    check: "Проверить доступность",
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
  const status = qualificationState === "qualifying" ? text.qualifying : qualificationState === "ready"
    ? text.ready : qualificationState === "unknown" ? text.unknown : text.idle;
  const reason = (choice: ChatModelOption) => choice.unavailableReason === "project-configuration"
    ? text.noProjectConfiguration : choice.unavailableReason === "qualification" ? text.qualificationUnavailable
      : choice.unavailableReason === "builtin-default" ? text.builtinUnavailable : "";
  return <section className="er-chat-model-picker" aria-labelledby={`${id}-label`}>
    <label id={`${id}-label`} className="er-field__label" htmlFor={`${id}-select`}>{text.label}</label>
    <label className="er-model-catalog__search" htmlFor={`${id}-search`}>
      <span>{text.search}</span>
      <input id={`${id}-search`} className="er-field__control" type="search" maxLength={512}
        value={search} disabled={disabled || qualificationState === "qualifying"}
        onChange={event => onSearchChange(event.currentTarget.value)} />
    </label>
    <select id={`${id}-select`} className="er-field__control" value={selectedKey}
      disabled={disabled || qualificationState === "qualifying" || (choices.length === 0 && !selected)}
      onChange={event => onSelect(byKey.get(event.currentTarget.value))}>
      <option value="">{text.placeholder}</option>
      {selectedKey !== "" && !byKey.has(selectedKey) && <option value={selectedKey} disabled>
        {selected?.provider_id} · {selected?.model_id}
      </option>}
      {choices.map(choice => <option key={choice.key} value={choice.key} disabled={!choice.canRun}>
        {choice.model.name} · {choice.providerLabel} ({choice.model.provider_id}) · {choice.model.model_id}
        {!choice.canRun ? ` — ${reason(choice)}` : ` — ${choice.availabilityCheckRequired || choice.candidate?.qualification_state === "qualification_required"
          ? text.needsQualification : choice.builtin ? text.builtin : text.qualified} · ${
          choice.model.account_availability === "unverified" ? text.accountUnverified : text.accountUnknown}`}
      </option>)}
    </select>
    <p>{text.helper}</p>
    <Status tone={failed || qualificationState === "unknown" ? "error" : "neutral"}>
      {loading ? text.reading : failed ? text.failed : choices.length === 0 ? text.empty : status}
    </Status>
    {qualificationState === "unknown" && onCheck && <Button variant="text" disabled={checkDisabled ?? disabled} onClick={onCheck}>{text.check}</Button>}
    <nav className="er-model-catalog__pagination" aria-label={text.label}>
      <Button variant="text" disabled={disabled || page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>{text.previous}</Button>
      <span>{page}</span>
      <Button variant="text" disabled={disabled || !hasMore} onClick={() => onPageChange(page + 1)}>{text.next}</Button>
    </nav>
  </section>;
}
