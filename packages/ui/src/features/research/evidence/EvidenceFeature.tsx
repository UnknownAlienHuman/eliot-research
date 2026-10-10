import { useId, useState } from "react";
import { Button } from "../../../primitives/primitives";
import "./evidence.css";

/**
 * Read-only Evidence feature for the Research/evidence rail. Pure props: no transport, query, store,
 * factory, SDK, socket or global effect is imported or acquired here. The root binds data and actions.
 *
 * The single hard rule of this surface is that a citation-resolution outcome is never a claim verdict.
 * Resolution answers "could these exact bytes be read back and authorized for this session". Semantic
 * support answers "does the checked claim hold". Both are rendered from separate accepted DTOs and are
 * never merged into one badge, so a quarantined or unverifiable excerpt can never look unsupported, and
 * an unsupported claim never looks like a broken citation.
 *
 * Row to DTO mapping, all from the accepted owner-api-client barrel:
 *   CitedEvidence                     <- handle_ref, excerpt_sha256
 *   ReauthorizedCitedEvidence         <- original_handle_ref, handle_ref, excerpt_sha256
 *   CitationResolutionOutcome         <- handle_ref, outcome, excerpt_sha256, verification_receipt_ref
 *   CitationAuditClaim                <- claim_ref, claim_text, disposition, support/counterevidence refs
 *   CitationAuditDisposition         <- the closed support vocabulary
 *   OpenedEvidence / VerifiedEvidence <- the decoded excerpt text and its verified identities
 */

import type {
  CitationAuditClaim,
  CitationAuditDisposition,
  CitationResolutionOutcome,
  CitedEvidence,
  OpenedEvidence,
  ReauthorizedCitedEvidence,
  VerifiedEvidence,
} from "@eliotr/owner-api-client";

/** Resolution outcomes that are explicitly not a rejection and never a lack of support. */
export type EvidenceIndeterminateOutcome =
  | "SOURCE_QUARANTINED"
  | "VERIFY_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "EFFECT_UNKNOWN";

/** Resolution outcomes that reject the readback outright. */
export type EvidenceRejectedOutcome =
  | "INVALID_REFERENCE"
  | "AUTHORITY_REVOKED"
  | "CONTENT_MISMATCH";

export type EvidenceRowState = "idle" | "loading" | "loaded" | "failed";

/** One rail entry. Exactly one citation source is present, never several. */
export interface EvidenceRow {
  readonly citation: CitedEvidence | ReauthorizedCitedEvidence;
  /** The resolution receipt entry for this handle, when one was requested. */
  readonly outcome?: CitationResolutionOutcome;
  /** The audit claim this excerpt is offered as support or counterevidence for, if any. */
  readonly forClaim?: CitationAuditClaim;
  readonly forClaimRelation?: "support" | "counterevidence";
  readonly state?: EvidenceRowState;
  /** The decoded excerpt, present only when its identities matched the current request. */
  readonly opened?: OpenedEvidence | VerifiedEvidence;
}

export interface EvidenceFeatureProps {
  readonly citations: readonly EvidenceRow[];
  /**
  /** Loading is per-row in the DTO, so this flag only covers the rail itself. */
  readonly loading?: boolean;
  readonly emptyMessage?: string;
  readonly errorMessage?: string;
  /** Requested only through this callback; this component opens no connection itself. */
  readonly onOpenExcerpt?: (citation: CitedEvidence | ReauthorizedCitedEvidence) => void;
  readonly onRetry?: () => void;
  readonly longLocale?: "ru" | "en";
}

export type ResolvedOutcome = Extract<CitationResolutionOutcome, { outcome: "RESOLVED" }>;
export type NotResolvedOutcome = Exclude<CitationResolutionOutcome, ResolvedOutcome>;

const REJECTED_OUTCOMES: readonly EvidenceRejectedOutcome[] = [
  "INVALID_REFERENCE",
  "AUTHORITY_REVOKED",
  "CONTENT_MISMATCH",
];

const INDETERMINATE_OUTCOMES: readonly EvidenceIndeterminateOutcome[] = [
  "SOURCE_QUARANTINED",
  "VERIFY_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "EFFECT_UNKNOWN",
];

/**
 * A reauthorized handle supersedes its original, so identity comparisons that matter for the readback
 * always use the live handle. The original is retained for display only.
 */
const liveHandle = (citation: CitedEvidence | ReauthorizedCitedEvidence): string => {
  // A reauthorized handle supersedes its original, so live identity uses handle_ref, not original_handle_ref.
  const handle = citation.handle_ref;
  return `${handle.id}:${handle.revision}`;
};

const handleMatches = (left: string, right: string): boolean => left === right;

/**
 * A decoded excerpt is renderable only when its own verified identities still match the citation the
 * caller asked about and the deployment the rail is bound to. Anything else is stale and its text is
 * suppressed rather than shown.
 */
const isExcerptCurrent = (
  row: EvidenceRow,
  opened: OpenedEvidence | VerifiedEvidence,
): boolean => {
  // Only fields the accepted DTOs actually declare are compared. Neither opened shape carries a
  // deployment generation, so currentness rests on the exact handle and the exact excerpt digest,
  // and, when a resolution receipt is present, on its verification receipt.
  const handleMatchesCurrent = handleMatches(
    `${opened.handleRef.id}:${opened.handleRef.revision}`,
    liveHandle(row.citation),
  );
  const digestMatchesCurrent = opened.excerptSha256 === row.citation.excerpt_sha256;
  const verified = "evidence" in opened ? opened.evidence : undefined;
  const receiptMatchesCurrent =
    row.outcome !== undefined &&
    row.outcome.outcome === "RESOLVED" &&
    (opened.verificationReceiptRef === row.outcome.verification_receipt_ref ||
      verified?.verification_receipt_ref === row.outcome.verification_receipt_ref);
  return handleMatchesCurrent && digestMatchesCurrent && receiptMatchesCurrent;
};

export const isRejectedOutcome = (outcome: CitationResolutionOutcome): outcome is Extract<CitationResolutionOutcome, { outcome: EvidenceRejectedOutcome }> =>
  REJECTED_OUTCOMES.includes(outcome.outcome as EvidenceRejectedOutcome);

export const isIndeterminateOutcome = (outcome: CitationResolutionOutcome): outcome is Extract<CitationResolutionOutcome, { outcome: EvidenceIndeterminateOutcome }> =>
  INDETERMINATE_OUTCOMES.includes(outcome.outcome as EvidenceIndeterminateOutcome);

export const isResolvedOutcome = (outcome: CitationResolutionOutcome): outcome is ResolvedOutcome =>
  outcome.outcome === "RESOLVED";

/** Support vocabulary is closed; anything else is a decode error, not an unknown support level. */
const SUPPORT_DISPOSITIONS: readonly CitationAuditDisposition[] = [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNSUPPORTED",
  "CONTRADICTED",
  "NOT_VERIFIABLE_IN_SCOPE",
];

export const isSupportDisposition = (value: string): value is CitationAuditDisposition =>
  SUPPORT_DISPOSITIONS.includes(value as CitationAuditDisposition);


const OUTCOME_LABEL: Record<CitationResolutionOutcome["outcome"], string> = {
  RESOLVED: "Citation read back for this session",
  INVALID_REFERENCE: "Citation reference is not valid",
  AUTHORITY_REVOKED: "Citation authority was revoked",
  SOURCE_QUARANTINED: "Source is quarantined",
  CONTENT_MISMATCH: "Citation bytes do not match",
  VERIFY_UNAVAILABLE: "Verification is unavailable",
  STORAGE_UNAVAILABLE: "Storage is unavailable",
  EFFECT_UNKNOWN: "Citation effect is unknown",
};

const DISPOSITION_LABEL: Record<CitationAuditDisposition, string> = {
  SUPPORTED: "Supported",
  PARTIALLY_SUPPORTED: "Partially supported",
  UNSUPPORTED: "Unsupported",
  CONTRADICTED: "Contradicted",
  NOT_VERIFIABLE_IN_SCOPE: "Not verifiable in scope",
};
const OUTCOME_RU: Record<CitationResolutionOutcome["outcome"], string> = {
  RESOLVED: "Цитата прочитана для этого сеанса", INVALID_REFERENCE: "Ссылка на цитату недействительна",
  AUTHORITY_REVOKED: "Доступ к цитате отозван", SOURCE_QUARANTINED: "Источник в карантине",
  CONTENT_MISMATCH: "Байты цитаты не совпадают", VERIFY_UNAVAILABLE: "Проверка недоступна",
  STORAGE_UNAVAILABLE: "Хранилище недоступно", EFFECT_UNKNOWN: "Исход чтения цитаты неизвестен",
};
const DISPOSITION_RU: Record<CitationAuditDisposition, string> = {
  SUPPORTED: "Подтверждено", PARTIALLY_SUPPORTED: "Частично подтверждено", UNSUPPORTED: "Не подтверждено",
  CONTRADICTED: "Опровергнуто", NOT_VERIFIABLE_IN_SCOPE: "Нельзя проверить в выбранной области",
};


const EvidenceExcerptBlock = (props: {
  readonly row: EvidenceRow;
  readonly russian: boolean;
}): React.ReactElement => {
  const { row, russian } = props;
  const { opened } = row;
  if (opened === undefined) {
    return (
      <p className="evidence__excerpt evidence__excerpt--absent">
        {russian ? "Фрагмент ещё не открыт для этого сеанса." : "Excerpt not opened for this session."}
      </p>
    );
  }
  if (!isExcerptCurrent(row, opened)) {
    // Stale or revoked bytes are never shown. A fresh explicit request is the only way back.
    return (
      <p className="evidence__excerpt evidence__excerpt--stale">
        {russian ? "Фрагмент изменился после открытия. Запросите актуальный фрагмент снова." : "This excerpt changed since it was opened. Request the current excerpt again."}
      </p>
    );
  }
  // source_title is declared only on the verified evidence, never on the plain opened shape.
  const sourceTitle = "evidence" in opened ? opened.evidence.source_title : undefined;
  return (
    <figure className="evidence__excerpt">
      <blockquote className="evidence__excerpt-quote">
        <p className="evidence__excerpt-text">{opened.text}</p>
      </blockquote>
      <figcaption className="evidence__excerpt-meta">
        {sourceTitle === undefined ? null : <span>{sourceTitle}</span>}
        <details><summary>{russian ? "Квитанция чтения" : "Readback receipt"}</summary>
        <span>
          {`Opened handle ${opened.handleRef.id}:${opened.handleRef.revision}`}
        </span>
        <span>{`Receipt ${opened.verificationReceiptRef}`}</span>
        </details>
      </figcaption>
    </figure>
  );
};

const EvidenceOutcomeLine = (props: { readonly outcome: CitationResolutionOutcome; readonly russian: boolean }): React.ReactElement => {
  const { outcome, russian } = props;
  const rejected = isRejectedOutcome(outcome);
  const indeterminate = isIndeterminateOutcome(outcome);
  const note = russian ? rejected ? "Эту цитату нельзя использовать. Это не означает, что утверждение не подтверждено."
    : indeterminate ? "Цитата не подтверждена и не отклонена. Это ничего не доказывает об утверждении."
    : "Точные байты прочитаны. Это ещё не означает, что утверждение подтверждено." : rejected
    ? "This citation cannot be used. It is not evidence that the claim is unsupported."
    : indeterminate
      ? "This citation is neither confirmed nor rejected. It is not evidence about the claim either way."
      : "Readback confirmed. This still says nothing about whether the claim holds.";
  return (
    <p className="evidence__outcome" role="status">
      <span className={rejected ? "evidence__status evidence__status--error" : "evidence__status"}>
        {(russian ? OUTCOME_RU : OUTCOME_LABEL)[outcome.outcome]}
      </span>
      <span className="evidence__outcome-note">{note}</span>
    </p>
  );
};


const EvidenceClaimBlock = (props: { readonly claim: CitationAuditClaim; readonly relation: "support" | "counterevidence"; readonly russian: boolean }): React.ReactElement => {
  const { claim, relation, russian } = props;
  return (
    <div className="evidence__claim">
      <p className="evidence__claim-text">{claim.claim_text}</p>
      <p className="evidence__claim-disposition">
        <span className="evidence__claim-label">
          {russian ? relation === "support" ? "Фрагмент проверен как подтверждение утверждения" : "Фрагмент проверен как контрдоказательство"
            : relation === "support" ? "Claim checked against this excerpt as support" : "Claim checked against this excerpt as counterevidence"}
        </span>
        <span className="evidence__claim-value">
          {(russian ? DISPOSITION_RU : DISPOSITION_LABEL)[claim.disposition]}
        </span>
      </p>
    </div>
  );
};


export const EvidenceFeature = (props: EvidenceFeatureProps): React.ReactElement => {
  const { citations, loading = false, emptyMessage, errorMessage, onOpenExcerpt, onRetry, longLocale } = props;
  const russian = longLocale === "ru";
  const title = russian ? "Доказательства" : "Evidence";
  const baseId = useId();
  const [openedKeys, setOpenedKeys] = useState<readonly string[]>([]);

  // Resolution is never collapsed into support. Each row keeps its own outcome and its own claim
  // relationship, so a quarantined excerpt and an unsupported claim never read as one verdict.
  const requestExcerpt = (citation: CitedEvidence | ReauthorizedCitedEvidence, key: string): void => {
    setOpenedKeys((current) => (current.includes(key) ? current : [...current, key]));
    onOpenExcerpt?.(citation);
  };

  if (errorMessage !== undefined) {
    return (
      <section className="evidence evidence--error" aria-labelledby={`${baseId}-error`}>
        <h2 className="evidence__title" id={`${baseId}-error`}>
          {title}
        </h2>
        <p className="evidence__message" role="status">
          {errorMessage}
        </p>
        {onRetry === undefined ? null : (
          <Button variant="tonal" onClick={onRetry}>
            {russian ? "Повторить чтение доказательств" : "Try evidence again"}
          </Button>
        )}
      </section>
    );
  }

  if (loading) {
    return (
      <section className="evidence evidence--loading" aria-busy="true" aria-labelledby={`${baseId}-loading`}>
        <h2 className="evidence__title" id={`${baseId}-loading`}>
          {title}
        </h2>
        <p className="evidence__message">{russian ? "Читаем доказательства для этого раздела." : "Loading cited evidence for this section."}</p>
        <ul className="evidence__list evidence__list--skeleton">
          {[0, 1, 2].map((index) => (
            <li className="evidence__row evidence__row--skeleton" key={index} />
          ))}
        </ul>
      </section>
    );
  }

  if (citations.length === 0) {
    return (
      <section className="evidence evidence--empty" aria-labelledby={`${baseId}-empty`}>
        <h2 className="evidence__title" id={`${baseId}-empty`}>
          {title}
        </h2>
        <p className="evidence__message">
          {emptyMessage ?? (russian ? "Для этого раздела нет доступных цитат." : "No cited evidence is available for this section.")}
        </p>
      </section>
    );
  }


  return (
    <section className={`evidence${longLocale === "ru" ? " evidence--long" : ""}`} aria-labelledby={`${baseId}-title`}>
      <h2 className="evidence__title" id={`${baseId}-title`}>
        {title}
      </h2>
      <p className="evidence__hint">
        {russian ? "Чтение цитаты проверяет её точные байты для этого сеанса. Оценка утверждения выполняется отдельно."
          : "Reading a citation confirms its bytes for this session. It never states whether a claim holds."}
      </p>
      <ul className="evidence__list">
        {citations.map((row, index) => {
          const key = `${baseId}-${liveHandle(row.citation)}-${row.citation.excerpt_sha256}`;
          const state = row.state ?? "idle";
          const asked = openedKeys.includes(key);
          const current = row.opened !== undefined && isExcerptCurrent(row, row.opened);
          const original = "original_handle_ref" in row.citation ? row.citation.original_handle_ref : undefined;
          return (
            <li className="evidence__row" key={key} data-testid={`evidence-row-${index}`}>
              <div className="evidence__row-head">
                <span className="evidence__handle">{russian ? "Цитата" : "Citation"} {index + 1}</span>
                <details><summary>{russian ? "Ссылки на цитату" : "Citation references"}</summary>
                <p>{liveHandle(row.citation)}</p>
                {original === undefined ? null : (
                  <span className="evidence__original">
                    {`supersedes ${original.id}:${original.revision}`}
                  </span>
                )}
                </details>
              </div>

              {row.outcome === undefined ? null : <EvidenceOutcomeLine outcome={row.outcome} russian={russian} />}

              {row.forClaim === undefined || row.forClaimRelation === undefined ? null : (
                <EvidenceClaimBlock claim={row.forClaim} relation={row.forClaimRelation} russian={russian} />
              )}

              <EvidenceExcerptBlock row={row} russian={russian} />

              <div className="evidence__actions">
                {state === "loading" ? (
                  <span className="evidence__pending" role="status">
                    {russian ? "Читаем фрагмент цитаты" : "Reading cited excerpt"}
                  </span>
                ) : null}
                {state === "failed" ? (
                  <span className="evidence__failed" role="status">
                    {russian ? "Не удалось прочитать фрагмент. Проверьте цитату снова перед использованием." : "This excerpt could not be read. Confirm the citation again before using it."}
                  </span>
                ) : null}
                {current || state === "loading" || (asked && state !== "failed" && row.opened === undefined) ? null : (
                  <Button
                    variant="text"
                    onClick={() => requestExcerpt(row.citation, key)}
                    aria-label={`${russian ? "Открыть фрагмент цитаты" : "Open cited excerpt"} ${index + 1}`}
                  >
                    {russian ? "Открыть фрагмент цитаты" : "Open cited excerpt"}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
