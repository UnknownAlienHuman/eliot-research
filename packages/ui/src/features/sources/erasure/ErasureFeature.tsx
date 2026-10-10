/** ErasureFeature — U3-E props-only pattern.
 *
 * No transport, no store, no Query client and no client factory. Every value arrives through
 * props, and every action is an explicit callback. Only implemented actions render.
 *
 * The prepared view and the status view are the accepted decoder types, re-exported by the
 * owner-api-client barrel, so no ad hoc DTO is invented here.
 */
import { Button, IconButton, OperationAnnouncement, Status } from "../../../primitives/primitives";
import type {
  ErasurePrepareView,
  ErasureStatusView,
} from "@eliotr/owner-api-client";
import "./erasure.css";

export type ErasureFeatureState =
  | "useful" | "loading" | "empty" | "degraded" | "error";

export interface ErasureFeatureCopy {
  readonly title: string;
  readonly review_intro: string;
  readonly source_label: string;
  readonly revisions_label: string;
  readonly locations_label: string;
  readonly review_without_prepared: string;
  readonly confirm_intro: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly refresh: string;
  readonly review_disclosure: string;
  readonly disclosure_permission: string;
  readonly disclosure_legal_basis: string;
  readonly disclosure_deadline: string;
  readonly disclosure_subjects: string;
  readonly disclosure_ledger: string;
  readonly loading: string;
  readonly empty: string;
  readonly unknown_state: string;
  readonly saved_none: string;
  readonly closed_context: string;
  readonly blocked: string;
  readonly invalid_payload: string;
  readonly rejected_read: string;
  readonly interrupted_read: string;
  readonly complete_verified: string;
  readonly stage_retention: string;
}

export interface ErasureFeatureProps {
  readonly locale: "en" | "ru";
  readonly copy: ErasureFeatureCopy;
  readonly state: ErasureFeatureState;
  readonly prepared?: Pick<ErasurePrepareView, "source_title" | "source_id" | "revision_targets" | "request">;
  readonly status?: Pick<ErasureStatusView, "state" | "receipt">;
  /** True only when the root proved a fresh COMPLETE readback with a matching receipt. */
  readonly completeVerified?: boolean;
  readonly hasSavedStatus?: boolean;
  readonly reviewOpen?: boolean;
  /**
   * One ephemeral manager-owned message for the pane's operation channel. The prop is
   * deliberately optional: when it is omitted no channel is rendered at all, so every
   * prepared, blocked, unknown and complete fact stays quiet. Passing an explicit string,
   * including the empty string, renders exactly one persistent channel that starts empty.
   *
   * Whether a message is announced is the root's derivation, never this component's: there
   * is no transition tracking, effect or local hook here.
   */
  readonly operationAnnouncement?: string;
  readonly onReview: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onRefresh: () => void;
  readonly onToggleDisclosure: () => void;
}

const EN_COPY: ErasureFeatureCopy = {
  title: "Erasure review",
  review_intro: "Review the exact deletion the server prepared before you confirm it.",
  source_label: "Source",
  revisions_label: "Revisions included",
  locations_label: "Locations the server will erase",
  review_without_prepared: "Review deletion",
  confirm_intro: "Confirm only when the source and the locations above are exactly what you expect.",
  confirm: "Confirm deletion",
  cancel: "Cancel",
  refresh: "Refresh status",
  review_disclosure: "Show the submitted details",
  disclosure_permission: "Permission",
  disclosure_legal_basis: "Legal basis",
  disclosure_deadline: "Deadline",
  disclosure_subjects: "Subjects",
  disclosure_ledger: "Ledger entry",
  loading: "Reading the saved deletion request.",
  empty: "Select a source to review its deletion request.",
  unknown_state: "The deletion result is unknown. Refresh the status to read the saved request.",
  saved_none: "No saved deletion status exists yet.",
  closed_context: "This review is no longer current. Refresh to start again.",
  blocked: "The deletion could not finish for every stored copy. Review the result below.",
  invalid_payload: "The deletion response was rejected as invalid. Nothing was shown.",
  rejected_read: "The deletion status could not be read. Nothing was shown.",
  interrupted_read: "Reading the status was interrupted before it finished. Nothing was shown.",
  complete_verified: "The deletion is complete and the server receipt confirms it.",
  stage_retention: "The deletion is still working through the retention and holds check.",
};

const RU_COPY: ErasureFeatureCopy = {
  title: "Проверка удаления",
  review_intro: "Проверьте точное удаление, подготовленное сервером, прежде чем подтвердить его.",
  source_label: "Источник",
  revisions_label: "Включённые ревизии",
  locations_label: "Места, которые сервер удалит",
  review_without_prepared: "Проверить удаление",
  confirm_intro: "Подтверждайте, только если источник и места выше совпадают с ожидаемыми.",
  confirm: "Подтвердить удаление",
  cancel: "Отмена",
  refresh: "Обновить статус",
  review_disclosure: "Показать переданные сведения",
  disclosure_permission: "Разрешение",
  disclosure_legal_basis: "Правовое основание",
  disclosure_deadline: "Срок",
  disclosure_subjects: "Субъекты",
  disclosure_ledger: "Запись журнала",
  loading: "Чтение сохранённого запроса на удаление.",
  empty: "Выберите источник, чтобы проверить запрос на его удаление.",
  unknown_state: "Результат удаления неизвестен. Обновите статус, чтобы прочитать сохранённый запрос.",
  saved_none: "Сохранённого статуса удаления пока нет.",
  closed_context: "Эта проверка уже не актуальна. Обновите, чтобы начать заново.",
  blocked: "Удаление не завершилось для каждой сохранённой копии. Ознакомьтесь с результатом ниже.",
  invalid_payload: "Ответ на удаление отклонён как некорректный. Ничего не было показано.",
  rejected_read: "Статус удаления не удалось прочитать. Ничего не было показано.",
  interrupted_read: "Чтение статуса было прервано до завершения. Ничего не было показано.",
  complete_verified: "Удаление завершено, и квитанция сервера это подтверждает.",
  stage_retention: "Удаление всё ещё проходит проверку хранения и удержаний.",
};

export function ErasureFeature(props: ErasureFeatureProps) {
  const { copy, state, prepared, status, onReview, onConfirm, onCancel, onRefresh, onToggleDisclosure } = props;
  const receipt = status?.receipt;
  // Completion needs a fresh COMPLETE readback and a matching receipt. Partial progress and a
  // blocked outcome can both list completed locations, so those never render as complete.
  const completeVerified = props.completeVerified === true &&
    status?.state === "COMPLETE" && receipt !== undefined &&
    receipt.state === "COMPLETE" && receipt.purge_ledger_entry_ref.length > 0;
  return (
    <section className="er-erasure" lang={props.locale} aria-label={copy.title}>
      {/* One channel for the whole feature. It renders only when the manager supplied the
          prop, so a quiet pane has no announcement region at all. An explicit empty string
          still renders the region initially empty. */}
      {props.operationAnnouncement === undefined ? null : (
        <OperationAnnouncement>{props.operationAnnouncement}</OperationAnnouncement>
      )}
      <header className="er-erasure__head">
        <h2 className="er-erasure__title">{copy.title}</h2>
        {completeVerified ? <Status tone="neutral" icon="check">{copy.complete_verified}</Status> : null}
      </header>
      {state === "loading" ? <Status tone="neutral" icon="search">{copy.loading}</Status> : null}
      {state === "empty" ? <Status tone="neutral" icon="search">{copy.empty}</Status> : null}
      {state === "degraded" ? (
        <div className="er-erasure__degraded">
          {status?.state === "UNKNOWN" ? <p>{copy.unknown_state}</p> : null}
          {props.hasSavedStatus === false ? <p>{copy.saved_none}</p> : null}
          {status === undefined && props.hasSavedStatus !== false ? <p>{copy.closed_context}</p> : null}
          <Button variant="tonal" icon="search" onClick={onRefresh}>{copy.refresh}</Button>
        </div>
      ) : null}
      {state === "error" ? (
        <div className="er-erasure__error">
          {status?.state === "BLOCKED" && receipt !== undefined ? (
            <>
              <p>{copy.blocked}</p>
              <ul className="er-erasure__blocked">
                {receipt.blocked_locations.map((item) => <li key={item.location}>{item.location}</li>)}
              </ul>
            </>
          ) : null}
          {status?.state === "COMPLETE" && !completeVerified ? <p>{copy.invalid_payload}</p> : null}
          {status === undefined ? <p>{copy.rejected_read}</p> : null}
          {status !== undefined && status.state !== "BLOCKED" && status.state !== "COMPLETE" ? <p>{copy.rejected_read}</p> : null}
          <Button variant="tonal" icon="search" onClick={onRefresh}>{copy.refresh}</Button>
        </div>
      ) : null}
      {state === "useful" && prepared !== undefined ? (
        <div className="er-erasure__review" data-erasure-review>
          <p className="er-erasure__intro">{copy.review_intro}</p>
          <dl className="er-erasure__facts">
            <div className="er-erasure__fact">
              <dt>{copy.source_label}</dt>
              <dd data-erasure-source>{prepared.source_title}</dd>
            </div>
            <div className="er-erasure__fact">
              <dt>{copy.revisions_label}</dt>
              <dd data-erasure-revisions>{prepared.revision_targets.length}</dd>
            </div>
            <div className="er-erasure__fact">
              <dt>{copy.locations_label}</dt>
              <dd>
                <ul className="er-erasure__locations">
                  {prepared.request.request.required_locations.map((location) =>
                    <li key={location}>{location}</li>)}
                </ul>
              </dd>
            </div>
          </dl>
          <p className="er-erasure__intro">{copy.confirm_intro}</p>
          <div className="er-erasure__actions">
            {props.hasSavedStatus === true || status !== undefined ? null : (
              <Button variant="primary" icon="evidence" onClick={onConfirm}>{copy.confirm}</Button>
            )}
            <Button variant="text" onClick={onCancel}>{copy.cancel}</Button>
            <IconButton label={copy.review_disclosure} icon="more" onClick={onToggleDisclosure} />
          </div>
          {props.reviewOpen === true ? (
            <dl className="er-erasure__disclosure" data-erasure-disclosure>
              <div><dt>{copy.disclosure_permission}</dt><dd>{prepared.request.permission_ref.id}</dd></div>
              <div><dt>{copy.disclosure_legal_basis}</dt><dd>{prepared.request.request.legal_basis_ref}</dd></div>
              <div><dt>{copy.disclosure_deadline}</dt><dd>{prepared.request.request.deadline}</dd></div>
              <div><dt>{copy.disclosure_subjects}</dt><dd>{prepared.request.request.exact_subject_refs.length}</dd></div>
              <div><dt>{copy.disclosure_ledger}</dt><dd>{receipt?.purge_ledger_entry_ref ?? copy.saved_none}</dd></div>
            </dl>
          ) : null}
        </div>
      ) : null}
      {state === "useful" && prepared === undefined ? (
        <Button variant="tonal" icon="evidence" onClick={onReview}>{copy.review_without_prepared}</Button>
      ) : null}
      {status?.state === "CHECK_RETENTION_AND_HOLDS" ? (
        <Status tone="neutral" icon="more">{copy.stage_retention}</Status>
      ) : null}
    </section>
  );
}

export const ERASURE_COPY = { en: EN_COPY, ru: RU_COPY } as const;
