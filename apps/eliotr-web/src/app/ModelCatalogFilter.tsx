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
    chosen: "In the chat menu",
    allModels: "All provider models",
    noModels: "none yet, tick models below",
    allBut: (count: number) => `All but ${count}`,
    remove: "Remove from the chat menu",
    inventory: "All provider models",
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
    chosen: "В меню чата",
    allModels: "Все модели провайдера",
    noModels: "пока ни одной, отметьте модели ниже",
    allBut: (count: number) => `Все, кроме ${count}`,
    remove: "Убрать из меню чата",
    inventory: "Все модели провайдера",
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
  const shown = (modelId: string) => visibility !== undefined && isModelCatalogEntryVisible(visibility, modelId);
  // Ticked models first: the owner sees what the chat offers before the provider's long inventory.
  const ordered = [...models].sort((left, right) => Number(shown(right.model_id)) - Number(shown(left.model_id)));
  const names = new Map((catalog?.models ?? []).map(model => [model.model_id, model.name]));
  const searching = search.trim() !== "";
  const row = (model: (typeof models)[number]) => {
    const checkboxId = `${id}-${encodeURIComponent(modelCatalogEntryKey(model))}`;
    return <li className="er-model-catalog__row" key={modelCatalogEntryKey(model)}>
      <input id={checkboxId} className="er-model-catalog__checkbox" type="checkbox"
        aria-label={`${text.visible}: ${model.name} ${model.model_id}`}
        checked={shown(model.model_id)}
        disabled={busy || visibility === undefined}
        onChange={event => onVisibilityChange(model.model_id, event.currentTarget.checked)} />
      <label htmlFor={checkboxId} className="er-model-catalog__identity">
        {/* The name, and the exact ID only when it says something the name does not. */}
        <strong>{model.name}</strong>{model.model_id !== model.name && <code>{model.model_id}</code>}
        {model.account_availability === "unverified" && <span>{text.accountUnverified}</span>}
      </label>
    </li>;
  };
  const list = models.length > 0 && <ul className="er-model-catalog__list">{ordered.map(row)}</ul>;
  const pagination = catalog && <nav className="er-model-catalog__pagination" aria-label={text.title}>
    <Button variant="text" disabled={busy || catalog.pagination.page <= 1}
      onClick={() => onPageChange(Math.max(1, catalog.pagination.page - 1))}>{text.previous}</Button>
    <span>{catalog.pagination.page}</span>
    <Button variant="text" disabled={busy || catalog.pagination.has_more !== true || catalog.pagination.next_page === null}
      onClick={() => { if (catalog.pagination.next_page !== null) onPageChange(catalog.pagination.next_page); }}>{text.next}</Button>
  </nav>;
  return <section className="er-model-catalog" aria-labelledby={`${id}-title`}>
    <h4 id={`${id}-title`}>{text.title}</h4>
    {/* What the chat offers now, as one line of chips; a chip's x takes the model out of the menu. */}
    <div className="er-model-catalog__chosen" role="group" aria-label={text.chosen}>
      <span className="er-model-catalog__chosen-label">{text.chosen}:</span>
      {visibility === undefined ? null
        : visibility.mode === "all" ? <span className="er-model-catalog__chip">{text.allModels}</span>
        : visibility.mode === "none" ? <span className="er-model-catalog__none">{text.noModels}</span>
        : visibility.mode === "exclude" ? <span className="er-model-catalog__chip">{text.allBut(visibility.model_ids.length)}</span>
        : visibility.model_ids.map(modelId => <span key={modelId} className="er-model-catalog__chip">
          <span>{names.get(modelId) ?? modelId}</span>
          <button type="button" aria-label={`${text.remove}: ${names.get(modelId) ?? modelId}`} disabled={busy}
            onClick={() => onVisibilityChange(modelId, false)}>×</button>
        </span>)}
    </div>
    <div className="er-model-catalog__tools">
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
    </div>
    {loading && <Status announce>{text.reading}</Status>}
    {failed && <Status tone="error" announce>{text.failed}</Status>}
    {catalog && models.length === 0 && <p>{searching ? text.noMatch : text.empty}</p>}
    {/* A search shows its matches at once; otherwise the provider's whole inventory stays folded. */}
    {searching ? <>{list}{pagination}</> : models.length > 0 && <details className="er-model-catalog__inventory">
      <summary>{text.inventory}</summary>
      {catalog && text.coverage(catalog.pagination.coverage) !== "" &&
        <p className="er-model-catalog__coverage" role="status">{text.coverage(catalog.pagination.coverage)}</p>}
      {list}
      {pagination}
    </details>}
  </section>;
}
