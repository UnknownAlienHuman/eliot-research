import { useId } from "react";
import type { ResearchModelCatalogPage, ServiceModelCatalogPage } from "@eliotr/owner-api-client";
import { Button, Status } from "@eliotr/ui";
import { filterModelCatalogEntries, isModelCatalogEntryVisible, modelCatalogEntryKey,
  type ModelCatalogVisibility } from "../query/modelCatalog";
import "./model-selection.css";

export { modelCatalogEntryKey } from "../query/modelCatalog";

type CatalogPage = ResearchModelCatalogPage | ServiceModelCatalogPage;

const copy = {
  en: {
    title: "Model catalog",
    explanation: "Tick the models to offer in the chat's model menu.",
    search: "Search model inventory",
    showAll: "Show all models",
    hideAll: "Hide all models",
    visible: "Show in Chat",
    accountUnverified: "Account access unverified",
    reading: "Reading model catalog…",
    failed: "The model catalog could not be read.",
    empty: "No models are listed on this page.",
    noMatch: "No catalog entries match this search.",
    previous: "Previous page",
    next: "Next page",
    coverage: (value: CatalogPage["pagination"]["coverage"]) => value === "complete"
      ? "" : "The provider may list more models than shown here.",
  },
  ru: {
    title: "Каталог моделей",
    explanation: "Отметьте модели, которые предлагать в выборе модели в чате.",
    search: "Поиск в каталоге моделей",
    showAll: "Показывать все модели",
    hideAll: "Скрыть все модели",
    visible: "Показывать в чате",
    accountUnverified: "Доступ аккаунта не проверен",
    reading: "Читаем каталог моделей…",
    failed: "Не удалось прочитать каталог моделей.",
    empty: "На этой странице каталога нет моделей.",
    noMatch: "В каталоге нет совпадений с запросом.",
    previous: "Предыдущая страница",
    next: "Следующая страница",
    coverage: (value: CatalogPage["pagination"]["coverage"]) => value === "complete"
      ? "" : "У провайдера может быть больше моделей, чем показано здесь.",
  },
} as const;

export function ModelCatalogFilter({ locale, catalog, loading, failed, search, visibility, busy,
  onSearchChange, onVisibilityChange, onAllVisibilityChange, onPageChange }: {
  readonly locale: "en" | "ru";
  readonly catalog: CatalogPage | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly search: string;
  readonly visibility: ModelCatalogVisibility | undefined;
  readonly busy?: boolean;
  readonly onSearchChange: (value: string) => void;
  readonly onVisibilityChange: (modelId: string, visible: boolean) => void;
  readonly onAllVisibilityChange: (visible: boolean) => void;
  readonly onPageChange: (page: number) => void;
}) {
  const id = useId(), text = copy[locale];
  const models = catalog ? filterModelCatalogEntries(catalog.models, search) : [];
  return <section className="er-model-catalog" aria-labelledby={`${id}-title`}>
    <h4 id={`${id}-title`}>{text.title}</h4>
    <p>{text.explanation}</p>
    <label className="er-model-catalog__search" htmlFor={`${id}-search`}>
      <span>{text.search}</span>
      <input id={`${id}-search`} className="er-field__control" type="search" maxLength={512}
        value={search} disabled={busy} onChange={event => onSearchChange(event.currentTarget.value)} />
    </label>
    <div className="er-model-catalog__actions">
      <Button variant="text" disabled={busy || visibility === undefined || visibility.mode === "all"}
        onClick={() => onAllVisibilityChange(true)}>{text.showAll}</Button>
      <Button variant="text" disabled={busy || visibility === undefined || visibility.mode === "none"}
        onClick={() => onAllVisibilityChange(false)}>{text.hideAll}</Button>
    </div>
    {loading && <Status announce>{text.reading}</Status>}
    {failed && <Status tone="error" announce>{text.failed}</Status>}
    {catalog && text.coverage(catalog.pagination.coverage) !== "" &&
      <p className="er-model-catalog__coverage" role="status">{text.coverage(catalog.pagination.coverage)}</p>}
    {catalog && models.length === 0 && <p>{search.trim() ? text.noMatch : text.empty}</p>}
    {models.length > 0 && <ul className="er-model-catalog__list">
      {models.map(model => {
        const checkboxId = `${id}-${encodeURIComponent(modelCatalogEntryKey(model))}`;
        return <li className="er-model-catalog__row" key={modelCatalogEntryKey(model)}>
          <input id={checkboxId} className="er-model-catalog__checkbox" type="checkbox"
            aria-label={`${text.visible}: ${model.name} ${model.model_id}`}
            checked={visibility === undefined ? false : isModelCatalogEntryVisible(visibility, model.model_id)}
            disabled={busy || visibility === undefined}
            onChange={event => onVisibilityChange(model.model_id, event.currentTarget.checked)} />
          <label htmlFor={checkboxId} className="er-model-catalog__identity">
            {/* The name, and the exact ID only when it says something the name does not. */}
            <strong>{model.name}</strong>{model.model_id !== model.name && <code>{model.model_id}</code>}
            {model.account_availability === "unverified" && <span>{text.accountUnverified}</span>}
          </label>
        </li>;
      })}
    </ul>}
    {catalog && <nav className="er-model-catalog__pagination" aria-label={text.title}>
      <Button variant="text" disabled={busy || catalog.pagination.page <= 1}
        onClick={() => onPageChange(Math.max(1, catalog.pagination.page - 1))}>{text.previous}</Button>
      <span>{catalog.pagination.page}</span>
      <Button variant="text" disabled={busy || catalog.pagination.has_more !== true || catalog.pagination.next_page === null}
        onClick={() => { if (catalog.pagination.next_page !== null) onPageChange(catalog.pagination.next_page); }}>{text.next}</Button>
    </nav>}
  </section>;
}
