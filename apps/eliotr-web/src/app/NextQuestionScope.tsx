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
  en: { title: 'Sources for your next question', detail: 'Choose the sources to include. Importing or opening a source does not select it.', clear: 'Clear selection', empty: 'Choose a project to review its sources.', loading: 'Loading sources for your next question...', error: 'Sources for your next question could not be loaded.', missing: 'The source list for this project is not available yet.', selected: (count: number) => `${count} sources selected` },
  ru: { title: 'Источники для следующего вопроса', detail: 'Выберите источники для исследования. Импорт и открытие документа не меняют этот выбор.', clear: 'Снять выбор', empty: 'Выберите проект, чтобы увидеть его источники.', loading: 'Загрузка источников для следующего вопроса...', error: 'Не удалось загрузить источники для следующего вопроса.', missing: 'Список источников выбранного проекта пока недоступен.', selected: (count: number) => `Выбрано источников: ${count}` },
} as const;
export function NextQuestionScope({ locale, page, projectSelected, isLoading, isError, selected, selectionLimit, onToggle, onClear }: {
  readonly locale: 'en' | 'ru'; readonly page: LibraryPage | undefined;
  readonly projectSelected: boolean; readonly isLoading: boolean; readonly isError: boolean;
  readonly selected: readonly NextQuestionSource[];
  readonly selectionLimit: number;
  readonly onToggle: (page: LibraryPage, id: string, checked: boolean) => void;
  readonly onClear: () => void;
}) {
  const id = useId(), text = copy[locale];
  const missingPage = isLoading ? text.loading : isError ? text.error : projectSelected ? text.missing : text.empty;
  return <details className="er-live-scope" aria-labelledby={id}>
    <summary><h2 id={id}>{text.title}</h2><span>{text.selected(selected.length)}</span></summary>
    <p>{text.detail}</p>
    <p>{locale === 'ru' ? `В этой версии интерфейса можно выбрать до ${selectionLimit} источников для одного вопроса.` : `This interface supports up to ${selectionLimit} sources per question.`}</p>
    {page ? <ul>{page.sources.map(source => <li key={source.id}><label>
      <input type="checkbox" checked={selected.some(item => item.id === source.id)}
        disabled={selected.length >= selectionLimit && !selected.some(item => item.id === source.id)}
        onChange={event => onToggle(page, source.id, event.target.checked)} />
      <span>{source.title}</span>
    </label></li>)}</ul> : <Status tone={isError && !isLoading ? "error" : "neutral"}>{missingPage}</Status>}
    <p>{text.selected(selected.length)}</p>
    {selected.length > 0 && <Button variant="text" onClick={onClear}>{text.clear}</Button>}
  </details>;
}
