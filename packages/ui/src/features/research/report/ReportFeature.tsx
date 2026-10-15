/**
 * U4-M Report feature: manifest rows, lazy section readback and a gated export.
 *
 * Props only. No fetch, no Query client, no client factory, no agent socket and no protocol
 * import. Every remote read and the export delivery are explicit callbacks owned by the root.
 * Bytes are never assembled or re-encoded here: the feature reports completeness from the
 * accepted manifest and section proofs and hands the verified responses to the root sink.
 */
import { Button, Status } from "../../../primitives/primitives";
import { MaterialSymbol } from "../../../catalog/MaterialSymbol";
import type { ArtifactSectionResponse } from "@eliotr/owner-api-client";
import type { DeclaredSection, VersionedRef } from "@eliotr/owner-api-client";
import "./report.css";

export type ReportFeatureState =
  | "useful" | "loading" | "empty" | "degraded" | "error";

export type ReportFreshness =
  | "CURRENT_REVISIONS" | "PREVIOUS_REVISIONS" | "UNKNOWN";

/** The accepted DTO shape, narrowed to what the panel displays. */
export interface ReportManifestRow {
  readonly artifact_ref: VersionedRef;
  readonly title: string;
  readonly created_at: string;
  readonly sections: readonly DeclaredSection[];
}

export interface ReportSectionRow {
  readonly section: DeclaredSection;
  readonly read: ArtifactSectionResponse | undefined;
}

export type { DeclaredSection, ArtifactSectionResponse };

export interface ReportFeatureCopy {
  readonly title: string;
  readonly manifestLabel: string;
  readonly createdLabel: string;
  readonly sectionsLabel: string;
  readonly sectionsCount: (count: number) => string;
  readonly openSection: string;
  readonly technicalDetails: string;
  readonly technicalObject: string;
  readonly technicalSectionRef: string;
  readonly technicalDigest: string;
  readonly freshnessLabel: string;
  readonly freshnessCurrent: string;
  readonly freshnessPrevious: string;
  readonly freshnessUnknown: string;
  readonly freshnessUnresolved: string;
  readonly readSection: string;
  readonly readingSection: string;
  readonly sectionRead: string;
  readonly sectionUnread: string;
  readonly completenessLabel: string;
  readonly completenessPending: string;
  readonly completenessComplete: string;
  readonly completenessProgress: (read: number, total: number) => string;
  readonly export: string;
  readonly exportBlocked: string;
  readonly exportDisabledReason: string;
  readonly openReport: string;
  readonly loading: string;
  readonly empty: string;
  readonly rejectedRead: string;
  readonly staleManifest: string;
  readonly interruptedRead: string;
  readonly unverifiedBytes: string;
}

export interface ReportFeatureProps {
  readonly locale: "en" | "ru";
  readonly copy: ReportFeatureCopy;
  readonly state: ReportFeatureState;
  readonly manifest?: ReportManifestRow | undefined;
  readonly sections: readonly ReportSectionRow[];
  readonly freshness: ReportFreshness;
  readonly readingRef?: string | undefined;
  readonly rejectedSectionRef?: string | undefined;
  readonly interrupted?: boolean | undefined;
  readonly onReadSection: (section: DeclaredSection) => void;
  readonly onOpenManifest: () => void;
  readonly onExport: () => void;
}

const EN_COPY: ReportFeatureCopy = {
  title: "Report",
  manifestLabel: "Draft",
  createdLabel: "Created",
  sectionsLabel: "Sections",
  sectionsCount: (count: number) => count === 1 ? "1 section" : `${count} sections`,
  openSection: "Open",
  technicalDetails: "Technical details",
  technicalObject: "Body object",
  technicalSectionRef: "Section reference",
  technicalDigest: "Body digest",
  freshnessLabel: "Source freshness",
  freshnessCurrent: "Built on the current versions of its sources.",
  freshnessPrevious: "Built on earlier versions of its sources; they have changed since.",
  freshnessUnknown: "Unknown",
  freshnessUnresolved: "Not checked whether its sources are still current — they may have changed since.",
  readSection: "Read",
  readingSection: "Reading",
  sectionRead: "Read",
  sectionUnread: "Not read yet",
  completenessLabel: "Completeness",
  completenessPending: "Some sections are not read yet.",
  completenessComplete: "Every section is read and verified.",
  completenessProgress: (read: number, total: number) => `Read ${read} of ${total}. Export opens once every section is read.`,
  export: "Export report",
  exportBlocked: "Export is blocked until every declared section is read back.",
  exportDisabledReason: "A complete export needs every declared section verified. No partial export is offered.",
  openReport: "Refresh",
  loading: "Reading the report manifest.",
  empty: "No saved draft exists for this run yet.",
  rejectedRead: "A section read was rejected. Nothing was shown for it.",
  staleManifest: "The manifest no longer matches this run. Refresh the manifest before reading sections.",
  interruptedRead: "A section read was interrupted before it finished. Nothing was shown.",
  unverifiedBytes: "The read-back bytes did not match the manifest row, so they were discarded.",
};

const RU_COPY: ReportFeatureCopy = {
  title: "Отчёт",
  manifestLabel: "Черновик",
  createdLabel: "Создан",
  sectionsLabel: "Разделы",
  sectionsCount: (count: number) => { const tail = count % 10, hundred = count % 100; return `${count} ${tail === 1 && hundred !== 11 ? "раздел" : tail >= 2 && tail <= 4 && (hundred < 12 || hundred > 14) ? "раздела" : "разделов"}`; },
  openSection: "Открыть",
  technicalDetails: "Технические сведения",
  technicalObject: "Объект тела",
  technicalSectionRef: "Ссылка на раздел",
  technicalDigest: "Дайджест тела",
  freshnessLabel: "Актуальность источников",
  freshnessCurrent: "Построен на текущих версиях источников.",
  freshnessPrevious: "Построен на прежних версиях источников; с тех пор они изменились.",
  freshnessUnknown: "Неизвестно",
  freshnessUnresolved: "Не проверено, актуальны ли источники: они могли измениться после отчёта.",
  readSection: "Прочитать",
  readingSection: "Чтение",
  sectionRead: "Прочитан",
  sectionUnread: "Ещё не прочитан",
  completenessLabel: "Полнота",
  completenessPending: "Не все разделы прочитаны.",
  completenessComplete: "Все разделы прочитаны и проверены.",
  completenessProgress: (read: number, total: number) => `Прочитано ${read} из ${total}. Экспорт откроется, когда будут прочитаны все разделы.`,
  export: "Экспортировать отчёт",
  exportBlocked: "Экспорт заблокирован, пока не прочитаны все объявленные разделы.",
  exportDisabledReason: "Полный экспорт требует проверки каждого объявленного раздела. Частичный экспорт не предлагается.",
  openReport: "Обновить",
  loading: "Чтение манифеста отчёта.",
  empty: "Для этого запуска сохранённого черновика пока нет.",
  rejectedRead: "Чтение раздела было отклонено. Для него ничего не показано.",
  staleManifest: "Манифест больше не соответствует этому запуску. Обновите манифест перед чтением разделов.",
  interruptedRead: "Чтение раздела было прервано до завершения. Ничего не было показано.",
  unverifiedBytes: "Прочитанные байты не совпали со строкой манифеста, поэтому они были отброшены.",
};

function freshnessText(copy: ReportFeatureCopy, freshness: ReportFreshness): string {
  if (freshness === "CURRENT_REVISIONS") return copy.freshnessCurrent;
  if (freshness === "PREVIOUS_REVISIONS") return copy.freshnessPrevious;
  return copy.freshnessUnknown;
}

export function ReportFeature(props: ReportFeatureProps) {
  // onOpenManifest stays in the contract; the workspace's own refresh action re-reads the manifest.
  const { copy, state, manifest, sections, freshness, readingRef, rejectedSectionRef, onReadSection, onExport } = props;
  const declaredCount = manifest?.sections.length ?? 0;
  // Completeness compares the manifest-declared set against the rows, and every readback must
  // echo its declared identity. A subset of rows, or a readback that differs from its declared
  // row, is never complete. Identity echoes are asserted, not recomputed: this module owns no
  // transport, decoder or hash authority of its own.
  const declaredSet = new Map(
    (manifest?.sections ?? []).map((declared) => [
      `${declared.section_ref.id}:${declared.section_ref.revision}`,
      declared,
    ]),
  );
  const matchesDeclared = (row: ReportSectionRow): boolean => {
    const key = `${row.section.section_ref.id}:${row.section.section_ref.revision}`;
    const declared = declaredSet.get(key);
    if (declared === undefined || row.read === undefined) return false;
    const read = row.read;
    const sameArtifact =
      read.artifact_ref.id === manifest?.artifact_ref.id &&
      read.artifact_ref.revision === manifest?.artifact_ref.revision;
    const sameSection =
      read.section_ref.id === declared.section_ref.id &&
      read.section_ref.revision === declared.section_ref.revision;
    return (
      read.body_object_ref === declared.body_object_ref &&
      read.body_sha256 === declared.body_sha256 &&
      row.section.body_object_ref === declared.body_object_ref &&
      row.section.body_sha256 === declared.body_sha256 &&
      read.size_bytes === read.bytes.byteLength &&
      sameArtifact && sameSection
    );
  };
  const complete =
    state === "useful" &&
    declaredSet.size > 0 &&
    declaredSet.size === declaredCount &&
    sections.length === declaredSet.size &&
    new Set(sections.map(row => `${row.section.section_ref.id}:${row.section.section_ref.revision}`)).size === declaredSet.size &&
    sections.every((row) => matchesDeclared(row));
  const readCount = sections.filter(row => matchesDeclared(row)).length;
  const created = formatCreated(props.locale, manifest?.created_at);
  return (
    <section className="er-report" lang={props.locale} aria-label={copy.title}>
      <header className="er-report__head">
        <h2 className="er-report__title">{copy.title}</h2>
        {/* One line instead of a facts table: what it is, when it was made, how many sections. */}
        {state === "useful" && manifest !== undefined ? <p className="er-report__meta">
          <span>{copy.manifestLabel}</span>
          <span>{manifest.title}</span>
          {created ? <time dateTime={manifest.created_at} title={manifest.created_at}>{created}</time> : null}
          <span data-report-sections>{copy.sectionsCount(declaredCount)}</span>
        </p> : null}
      </header>
      {state === "loading" ? <Status tone="neutral" icon="search">{copy.loading}</Status> : null}
      {state === "empty" ? <Status tone="neutral" icon="folder">{copy.empty}</Status> : null}
      {state === "degraded" ? (
        <div className="er-report__degraded">
          {props.interrupted === true ? <p>{copy.interruptedRead}</p> : null}
          {props.interrupted !== true ? <p>{copy.staleManifest}</p> : null}
        </div>
      ) : null}
      {state === "error" ? (
        <div className="er-report__error">
          {rejectedSectionRef === undefined ? <p>{copy.rejectedRead}</p> : null}
          {rejectedSectionRef !== undefined ? <p>{copy.unverifiedBytes}</p> : null}
        </div>
      ) : null}
      {state === "useful" ? (
        <p className="er-report__freshness" data-freshness={freshness} data-report-freshness={freshnessText(copy, freshness)}>
          <span className="er-report__freshness-label">{copy.freshnessLabel}: </span>
          {freshness === "UNKNOWN" ? copy.freshnessUnresolved : freshnessText(copy, freshness)}
        </p>
      ) : null}
      {state === "useful" ? (
        <ul className="er-report__sections" aria-label={copy.sectionsLabel}>
          {sections.map((row, index) => {
            const key = `${row.section.section_ref.id}:${row.section.section_ref.revision}`;
            const isReading = readingRef === key;
            const isRead = matchesDeclared(row);
            const label = row.section.title;
            return (
              <li key={`${key}:${index}`} className="er-report__section" data-report-section={key} data-read={isRead ? "true" : "false"}>
                <span className="er-report__section-glyph" aria-hidden="true"><MaterialSymbol name={isRead ? "check" : "document"} /></span>
                <span className="er-report__section-text">
                  <span className="er-report__section-label" data-report-section-label>{label}</span>
                  <span className="er-report__section-state">{isRead ? copy.sectionRead : copy.sectionUnread}</span>
                </span>
                {isRead ? (
                  <Button variant="text" onClick={() => onReadSection(row.section)}>
                    {copy.openSection}<span className="er-report__sr"> · {label}</span>
                  </Button>
                ) : (
                  <Button variant="tonal" disabled={isReading} onClick={() => onReadSection(row.section)}>
                    {isReading ? copy.readingSection : copy.readSection}<span className="er-report__sr"> · {label}</span>
                  </Button>
                )}
                <details className="er-report__section-details">
                  <summary>{copy.technicalDetails}</summary>
                  <dl className="er-report__section-technical">
                    <div>
                      <dt>{copy.technicalSectionRef}</dt>
                      <dd>{key}</dd>
                    </div>
                    <div>
                      <dt>{copy.technicalObject}</dt>
                      <dd>{row.section.body_object_ref}</dd>
                    </div>
                    <div>
                      <dt>{copy.technicalDigest}</dt>
                      <dd>{row.section.body_sha256}</dd>
                    </div>
                    {row.read !== undefined ? (
                      <div>
                        <dt>{copy.technicalDigest}</dt>
                        <dd>{row.read.body_sha256}</dd>
                      </div>
                    ) : null}
                  </dl>
                </details>
              </li>
            );
          })}
        </ul>
      ) : null}
      {state === "useful" ? (
        <div className="er-report__export">
          <p data-report-completeness>
            {complete ? copy.completenessComplete : copy.completenessProgress(readCount, declaredCount)}
          </p>
          {/* No partial export: the action stays disabled until every declared section is verified. */}
          <Button variant={complete ? "primary" : "tonal"} icon="send" disabled={!complete}
            {...(complete ? { onClick: onExport } : { title: copy.exportDisabledReason })}>
            {copy.export}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function formatCreated(locale: "en" | "ru", value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export const REPORT_COPY = { en: EN_COPY, ru: RU_COPY } as const;
