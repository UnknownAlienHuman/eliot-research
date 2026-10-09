// U3-D Document reader. Presentation and local navigation only.
//
// Server state arrives as props from the app query layer. This component never fetches, never
// instantiates a factory or transport, and never derives a byte range, a coordinate or a digest.
// The document text comes from the accepted whole-object read, and every displayed field is shown
// verbatim from the accepted DTOs.
import { useId, useState } from 'react';
import { Button, Status } from '../../../primitives/primitives';
import type { AdmittedDocument, NavigationSection } from '@eliotr/owner-api-client';
import { SafeMarkdown } from './SafeMarkdown';
import './document.css';

export type DocumentReaderState = 'useful' | 'loading' | 'empty' | 'degraded' | 'error';

export interface DocumentReaderProps {
  readonly locale: 'en' | 'ru';
  readonly state: DocumentReaderState;
  /** The exact admitted revision being read. Required whenever a document is present. */
  readonly sourceRevisionRef?: string;
  /** The deployment generation the document must match. */
  readonly expectedDeploymentGeneration?: string;
  /** The exact admitted document from the accepted whole-object read. */
  readonly document?: AdmittedDocument;
  /** Sections exactly as the server supplied them. Never recomputed or renamed. */
  readonly sections?: readonly NavigationSection[];
  readonly activeSectionRef?: string;
  readonly onOpenSection?: (sectionRef: string) => void;
  readonly onBack?: () => void;
  readonly onRetry?: () => void;
}

const COPY = {
  en: {
    heading: 'Document',
    subtitle: 'Saved text from the selected version.',
    scopeLabel: 'Admitted revision',
    generationLabel: 'Deployment generation',
    digestLabel: 'Content digest',
    sizeLabel: 'Size',
    wholeRead: 'The whole document was read, because no exact range identity was supplied.',
    sectionsLabel: 'Sections',
    sectionBytes: 'Bytes',
    sectionBytesUnknown: 'Byte range not recorded',
    openSection: 'Open section',
    back: 'Back to sections',
    refresh: 'Read again',
    loading: 'Reading the admitted document.',
    empty: 'No document is selected.',
    degraded: 'The document could not be verified as current.',
    error: 'The document could not be read.',
    mismatch: 'This response is not the admitted representation, so its text was refused.',
    missingRevision: 'An admitted revision is required before a document can be read.',
    quoteHeading: 'Document text',
    unknown: 'Not verified',
  },
  ru: {
    heading: 'Документ',
    subtitle: 'Сохранённый текст выбранной версии.',
    scopeLabel: 'Допущенная версия',
    generationLabel: 'Поколение развёртывания',
    digestLabel: 'Дайджест содержимого',
    sizeLabel: 'Размер',
    wholeRead: 'Прочитан весь документ, так как точная идентификация диапазона не передана.',
    sectionsLabel: 'Разделы',
    sectionBytes: 'Байты',
    sectionBytesUnknown: 'Диапазон байтов не записан',
    openSection: 'Открыть раздел',
    back: 'Назад к разделам',
    refresh: 'Прочитать снова',
    loading: 'Читаем допущенный документ.',
    empty: 'Документ не выбран.',
    degraded: 'Не удалось подтвердить актуальность документа.',
    error: 'Не удалось прочитать документ.',
    mismatch: 'Этот ответ не является допущенным представлением, поэтому его текст был отклонён.',
    missingRevision: 'Перед чтением документа требуется допущенная версия.',
    quoteHeading: 'Текст документа',
    unknown: 'Не подтверждено',
  },
} as const;

/** A displayable section. Byte values are the server's, never computed. */
interface SectionRow {
  readonly sectionRef: string;
  readonly label: string;
  readonly sourceRevisionRef: string;
  readonly start: number | undefined;
  readonly end: number | undefined;
}

function toSectionRows(sections: readonly NavigationSection[] | undefined): SectionRow[] {
  return (sections ?? []).map((section) => ({
    sectionRef: section.section_ref,
    label: section.label,
    sourceRevisionRef: section.source_revision_ref,
    start: section.normalized_start_byte,
    end: section.normalized_end_byte,
  }));
}

/**
 * The document is only displayable when the caller named a revision and the document agrees with the
 * generation it was read against. A mismatch refuses the text instead of showing stale bytes.
 */
function readableDocument(props: DocumentReaderProps): AdmittedDocument | undefined {
  const document = props.document;
  if (document === undefined || props.state !== 'useful') return undefined;
  if (props.sourceRevisionRef === undefined || props.expectedDeploymentGeneration === undefined) return undefined;
  if (document.sourceRevisionRef !== props.sourceRevisionRef) return undefined;
  if (props.expectedDeploymentGeneration !== undefined &&
      document.deploymentGeneration !== props.expectedDeploymentGeneration) return undefined;
  return document;
}

/** Local navigation identity, so Back always has a target without a host router. */
export function DocumentReader(props: DocumentReaderProps) {
  const copy = COPY[props.locale];
  const instanceId = useId();
  const [localActiveRef, setLocalActiveRef] = useState<string | undefined>(undefined);
  const rows = toSectionRows(props.sections?.filter(section => section.source_revision_ref === props.sourceRevisionRef));
  const document = readableDocument(props);
  const activeRef = props.activeSectionRef ?? localActiveRef;
  const activeSection = rows.find((row) => row.sectionRef === activeRef);

  const openSection = (sectionRef: string): void => {
    setLocalActiveRef(sectionRef);
    props.onOpenSection?.(sectionRef);
  };

  const goBack = (): void => {
    setLocalActiveRef(undefined);
    props.onBack?.();
  };

  return (
    <section className="er-document-reader" aria-labelledby={`${instanceId}-heading`}>
      <header className="er-document-reader__head">
        <h2 className="er-document-reader__heading" id={`${instanceId}-heading`}>{copy.heading}</h2>
        <p className="er-document-reader__hint">{copy.subtitle}</p>
        <details className="er-document-reader__disclosure"><summary>{props.locale === 'ru' ? 'Сведения о версии' : 'Version details'}</summary>
        <dl className="er-document-reader__facts">
          <div className="er-document-reader__fact">
            <dt>{copy.scopeLabel}</dt>
            <dd>{props.sourceRevisionRef ?? copy.missingRevision}</dd>
          </div>
          <div className="er-document-reader__fact">
            <dt>{copy.generationLabel}</dt>
            <dd>{document?.deploymentGeneration ?? props.expectedDeploymentGeneration ?? copy.unknown}</dd>
          </div>
          <div className="er-document-reader__fact">
            <dt>{copy.digestLabel}</dt>
            <dd>{document?.contentSha256 ?? copy.unknown}</dd>
          </div>
          <div className="er-document-reader__fact">
            <dt>{copy.sizeLabel}</dt>
            <dd>{document?.sizeBytes ?? copy.unknown}</dd>
          </div>
        </dl><p className="er-document-reader__whole-read">{copy.wholeRead}</p></details>
      </header>

      {props.state === 'loading' ? <Status>{copy.loading}</Status> : null}
      {props.state === 'empty' ? <Status>{copy.empty}</Status> : null}
      {props.state === 'degraded' ? <Status tone="error">{copy.degraded}</Status> : null}
      {props.state === 'error' ? <Status tone="error">{copy.error}</Status> : null}
      {props.state === 'useful' && document === undefined ? <Status tone="error">{copy.mismatch}</Status> : null}

      {document === undefined ? null : (
        <>
          <section className="er-document-reader__text" aria-label={copy.quoteHeading}>
            <SafeMarkdown text={document.text} />
          </section>
        </>
      )}

      <section className="er-document-reader__sections" aria-label={copy.sectionsLabel}>
        <h3 className="er-document-reader__subheading">{copy.sectionsLabel}</h3>
        {rows.length === 0 ? <Status>{props.locale === 'ru' ? 'Разделы этой версии недоступны.' : 'Sections are unavailable for this revision.'}</Status> : null}
        <ul className="er-document-reader__section-list">
          {rows.map((row) => (
            <li key={row.sectionRef} className="er-document-reader__section">
              <Button
                variant={row.sectionRef === activeRef ? 'primary' : 'tonal'}
                aria-pressed={row.sectionRef === activeRef}
                onClick={() => openSection(row.sectionRef)}
              >
                {row.label}
              </Button>
              <span className="er-document-reader__section-bytes">
                {row.start === undefined || row.end === undefined
                  ? copy.sectionBytesUnknown
                  : `${copy.sectionBytes}: ${row.start} - ${row.end}`}
              </span>
            </li>
          ))}
        </ul>
        {activeSection === undefined ? null : (
          <div className="er-document-reader__active">
            <h4 className="er-document-reader__active-heading">{activeSection.label}</h4>
            <p className="er-document-reader__active-source">{activeSection.sourceRevisionRef}</p>
            <Button variant="text" onClick={goBack}>{copy.back}</Button>
          </div>
        )}
      </section>

      {props.onRetry && <div className="er-document-reader__actions">
        <Button variant="tonal" onClick={() => props.onRetry?.()}>{copy.refresh}</Button>
      </div>}
    </section>
  );
}
