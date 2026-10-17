import { useId } from 'react';
import { Button, Status } from '@eliotr/ui';
import type { LibraryPage } from '@eliotr/owner-api-client';

/** Selection is an explicit future intent. Server run snapshots never read this mutable list. */
export interface NextQuestionSource {
  readonly id: string;
  readonly label: string;
  readonly page: LibraryPage;
  readonly cursor?: string;
}
const copy = {
  en: { title: 'Sources for your next question', detail: 'Your next question uses all project sources. Tick sources to narrow it.', partial: 'Only the ticked sources are included.', clear: 'Use all sources', all: 'All sources', empty: 'Choose a project to review its sources.', loading: 'Loading sources for your next question...', error: 'Sources for your next question could not be loaded.', missing: 'The source list for this project is not available yet.', selected: (count: number) => `${count} sources selected` },
  ru: { title: 'Источники для следующего вопроса', detail: 'Следующий вопрос задаётся по всем источникам проекта. Отметьте источники, чтобы сузить его.', partial: 'В вопрос войдут только отмеченные источники.', clear: 'Использовать все источники', all: 'Все источники', empty: 'Выберите проект, чтобы увидеть его источники.', loading: 'Загрузка источников для следующего вопроса...', error: 'Не удалось загрузить источники для следующего вопроса.', missing: 'Список источников выбранного проекта пока недоступен.', selected: (count: number) => `Выбрано источников: ${count}` },
} as const;
export function NextQuestionScope({ locale, page, projectSelected, isLoading, isError, selected, selectionLimit, onToggle, onClear, wholeProject = false }: {
  readonly locale: 'en' | 'ru'; readonly page: LibraryPage | undefined;
  readonly projectSelected: boolean; readonly isLoading: boolean; readonly isError: boolean;
  readonly selected: readonly NextQuestionSource[];
  readonly selectionLimit: number;
  readonly onToggle: (page: LibraryPage, id: string, checked: boolean) => void;
  readonly onClear: () => void;
  /** No ticked source asks the whole project (the live workspace); without it, nothing ticked is nothing chosen. */
  readonly wholeProject?: boolean;
}) {
  const id = useId(), text = copy[locale];
  const whole = wholeProject && selected.length === 0;
  const count = whole ? text.all : text.selected(selected.length);
  const missingPage = isLoading ? text.loading : isError ? text.error : projectSelected ? text.missing : text.empty;
  return <details className="er-live-scope" aria-labelledby={id} data-project={projectSelected ? 'selected' : 'none'}>
    <summary><h2 id={id}>{text.title}</h2><span>{count}</span></summary>
    <p>{whole ? text.detail : wholeProject ? text.partial : text.detail}</p>
    {page ? <ul>{page.sources.map(source => <li key={source.id}><label>
      <input type="checkbox" checked={selected.some(item => item.id === source.id)}
        disabled={selected.length >= selectionLimit && !selected.some(item => item.id === source.id)}
        onChange={event => onToggle(page, source.id, event.target.checked)} />
      <span>{source.title}</span>
    </label></li>)}</ul> : <Status tone={isError && !isLoading ? "error" : "neutral"}>{missingPage}</Status>}
    <div className="er-live-scope-footer">
      <p>{count}</p>
      {!wholeProject && page && page.sources.length > 0 && <Button variant="text" onClick={() => {
        for (const source of page.sources.slice(0, selectionLimit)) onToggle(page, source.id, true);
      }}>{locale === 'ru' ? page.next_cursor ? 'Выбрать страницу' : 'Выбрать все' : page.next_cursor ? 'Select page' : 'Select all'}</Button>}
      {selected.length > 0 && <Button variant="text" onClick={onClear}>{text.clear}</Button>}
    </div>
  </details>;
}
