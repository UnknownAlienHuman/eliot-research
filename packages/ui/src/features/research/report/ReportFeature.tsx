/**
 * U4-M Report feature: manifest rows, lazy section readback and a gated export.
 *
 * Props only. No fetch, no Query client, no client factory, no agent socket and no protocol
 * import. Every remote read and the export delivery are explicit callbacks owned by the root.
 * Bytes are never assembled or re-encoded here: the feature reports completeness from the
 * accepted manifest and section proofs and hands the verified responses to the root sink.
 */
import { Button, Status } from "../../../primitives/primitives";
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
  readonly sectionOrdinal: (ordinal: number) => string;
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
  manifestLabel: "Saved draft",
  createdLabel: "Created",
  sectionsLabel: "Declared sections",
  sectionsCount: (count: number) => `${count} declared`,
  sectionOrdinal: (ordinal: number) => `Section ${ordinal}`,
  openSection: "Open",
  technicalDetails: "Technical details",
  technicalObject: "Body object",
  technicalSectionRef: "Section reference",
  technicalDigest: "Body digest",
  freshnessLabel: "Source freshness",
  freshnessCurrent: "Current revisions",
  freshnessPrevious: "Previous revisions",
  freshnessUnknown: "Unknown",
  freshnessUnresolved: "Freshness is unresolved. It is not evidence that the sources are current.",
  readSection: "Read",
  readingSection: "Reading",
  sectionRead: "Read back",
  sectionUnread: "Not read back",
  completenessLabel: "Completeness",
  completenessPending: "Some declared sections are not read back yet.",
  completenessComplete: "Every declared section is read back and verified.",
  export: "Export report",
  exportBlocked: "Export is blocked until every declared section is read back.",
  exportDisabledReason: "A complete export needs every declared section verified. No partial export is offered.",
  openReport: "Open manifest",
  loading: "Reading the report manifest.",
  empty: "No saved draft exists for this run yet.",
  rejectedRead: "A section read was rejected. Nothing was shown for it.",
  staleManifest: "The manifest no longer matches this run. Refresh the manifest before reading sections.",
  interruptedRead: "A section read was interrupted before it finished. Nothing was shown.",
  unverifiedBytes: "The read-back bytes did not match the manifest row, so they were discarded.",
};

const RU_COPY: ReportFeatureCopy = {
  title: "Отчёт",
  manifestLabel: "Сохранённый черновик",
  createdLabel: "Создан",
  sectionsLabel: "Объявленные разделы",
  sectionsCount: (count: number) => `Объявлено: ${count}`,
  sectionOrdinal: (ordinal: number) => `Раздел ${ordinal}`,
  openSection: "Открыть",
  technicalDetails: "Технические сведения",
  technicalObject: "Объект тела",
  technicalSectionRef: "Ссылка на раздел",
  technicalDigest: "Дайджест тела",
  freshnessLabel: "Актуальность источников",
  freshnessCurrent: "Текущие ревизии",
  freshnessPrevious: "Предыдущие ревизии",
  freshnessUnknown: "Неизвестно",
  freshnessUnresolved: "Актуальность не определена. Это не доказательство того, что источники текущие.",
  readSection: "Прочитать",
  readingSection: "Чтение",
  sectionRead: "Прочитан",
  sectionUnread: "Не прочитан",
  completenessLabel: "Полнота",
  completenessPending: "Не все объявленные разделы прочитаны.",
  completenessComplete: "Все объявленные разделы прочитаны и проверены.",
  export: "Экспортировать отчёт",
  exportBlocked: "Экспорт заблокирован, пока не прочитаны все объявленные разделы.",
  exportDisabledReason: "Полный экспорт требует проверки каждого объявленного раздела. Частичный экспорт не предлагается.",
  openReport: "Открыть манифест",
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
  const { copy, state, manifest, sections, freshness, readingRef, rejectedSectionRef, onReadSection, onOpenManifest, onExport } = props;
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
  return (
    <section className="er-report" lang={props.locale} aria-label={copy.title}>
      <header className="er-report__head">
        <h2 className="er-report__title">{copy.title}</h2>
        <Button variant="text" icon="folder" onClick={onOpenManifest}>{copy.openReport}</Button>
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
      {state === "useful" && manifest !== undefined ? (
        <div className="er-report__manifest">
          <dl className="er-report__facts">
            <div className="er-report__fact">
              <dt>{copy.manifestLabel}</dt>
              <dd data-report-title>{manifest.title}</dd>
            </div>
            <div className="er-report__fact">
              <dt>{copy.createdLabel}</dt>
              <dd>{manifest.created_at}</dd>
            </div>
            <div className="er-report__fact">
              <dt>{copy.sectionsLabel}</dt>
              <dd data-report-sections>{copy.sectionsCount(declaredCount)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
      {state === "useful" ? (
        <div className="er-report__freshness">
          <h3>{copy.freshnessLabel}</h3>
          <p data-report-freshness>{freshnessText(copy, freshness)}</p>
          {freshness === "UNKNOWN" ? <p>{copy.freshnessUnresolved}</p> : null}
        </div>
      ) : null}
      {state === "useful" ? (
        <ul className="er-report__sections">
          {sections.map((row, index) => {
            const key = `${row.section.section_ref.id}:${row.section.section_ref.revision}`;
            const isReading = readingRef === key;
            return (
              <li key={`${key}:${index}`} className="er-report__section" data-report-section={key}>
                <span className="er-report__section-label" data-report-section-label>
                  {copy.sectionOrdinal(index + 1)}
                </span>
                <span className="er-report__section-state">
                  {matchesDeclared(row) ? copy.sectionRead : copy.sectionUnread}
                </span>
                {!matchesDeclared(row) ? (
                  <Button
                    variant="tonal"
                    icon="file"
                    disabled={isReading}
                    onClick={() => onReadSection(row.section)}
                  >
                    {isReading ? copy.readingSection : copy.readSection} · {copy.sectionOrdinal(index + 1)}
                  </Button>
                ) : null}
                {matchesDeclared(row) ? (
                  <Button variant="text" icon="file" onClick={() => onReadSection(row.section)}>
                    {copy.openSection} · {copy.sectionOrdinal(index + 1)}
                  </Button>
                ) : null}
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
          <h3>{copy.completenessLabel}</h3>
          <p data-report-completeness>
            {complete ? copy.completenessComplete : copy.completenessPending}
          </p>
          {complete ? (
            <Button variant="primary" icon="send" onClick={onExport}>{copy.export}</Button>
          ) : (
            <>
              <Button variant="primary" icon="send" disabled>{copy.export}</Button>
              <p>{copy.exportBlocked}</p>
            </>
          )}
          <p className="er-report__gate-note">{copy.exportDisabledReason}</p>
        </div>
      ) : null}
    </section>
  );
}

export const REPORT_COPY = { en: EN_COPY, ru: RU_COPY } as const;
