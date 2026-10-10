import { useId } from 'react';
import { Button, Status } from '@eliotr/ui';
import type { LibraryPage } from '@eliotr/owner-api-client';

/** Selection is an explicit future intent. Server run snapshots never read this mutable list. */
export interface NextQuestionSource {
  readonly id: string;
  readonly label: string;
  readonly page: LibraryPage;
}
const copy = {
  en: { title: 'Sources for your next question', detail: 'Choose the sources to include. Importing or opening a source does not select it.', clear: 'Clear selection', empty: 'Choose a project to review its sources.', selected: (count: number) => `${count} sources selected` },
  ru: { title: 'Источники для следующего вопроса', detail: 'Выберите источники для исследования. Импорт и открытие документа не меняют этот выбор.', clear: 'Снять выбор', empty: 'Выберите проект, чтобы увидеть его источники.', selected: (count: number) => `Выбрано источников: ${count}` },
} as const;
export function NextQuestionScope({ locale, page, selected, onToggle, onClear }: {
  readonly locale: 'en' | 'ru'; readonly page: LibraryPage | undefined;
  readonly selected: readonly NextQuestionSource[];
  readonly onToggle: (page: LibraryPage, id: string, checked: boolean) => void;
  readonly onClear: () => void;
}) {
  const id = useId(), text = copy[locale];
  return <details className="er-live-scope" aria-labelledby={id}>
    <summary><h2 id={id}>{text.title}</h2><span>{text.selected(selected.length)}</span></summary>
    <p>{text.detail}</p>
    {page ? <ul>{page.sources.map(source => <li key={source.id}><label>
      <input type="checkbox" checked={selected.some(item => item.id === source.id)}
        onChange={event => onToggle(page, source.id, event.target.checked)} />
      <span>{source.title}</span>
    </label></li>)}</ul> : <Status>{text.empty}</Status>}
    <p role="status">{text.selected(selected.length)}</p>
    {selected.length > 0 && <Button variant="text" onClick={onClear}>{text.clear}</Button>}
  </details>;
}
