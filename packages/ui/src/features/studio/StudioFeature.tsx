/** StudioFeature - U5-S props-only pattern.
 *
 * No transport, no store, no Query client, no client factory and no agents socket. Every value arrives
 * through props and every action is an explicit callback, so this component can never perform a
 * network, storage or protocol effect on its own.
 *
 * The accepted C3-S owner-client view types are used directly, so no ad hoc DTO is invented here and
 * no wire field is renamed. Where the screen narrows a shape it uses Pick rather than a local copy.
 */
import { useId, useState } from "react";
import { Button, IconButton, Status } from "../../primitives/primitives";
import type {
  ArtifactPublicationView,
  ArtifactSectionRevisionView,
  WikiProposalListView,
  WikiProposalReadView,
} from "@eliotr/owner-api-client";

/**
 * Derived from the two publicly exported views, so this component never imports an internal studio
 * type. Both aliases are structural: the list item and the read view's freshness are the exact shapes
 * the accepted client decodes.
 */
export type WikiProposalSummaryItem = WikiProposalListView["items"][number];

const PROPOSAL_LABEL: Record<'en' | 'ru', Record<WikiProposalReadView['state'], string>> = {
  en: { PROPOSED: 'Draft', PUBLISHED: 'Published' },
  ru: { PROPOSED: 'Черновик', PUBLISHED: 'Опубликовано' },
};
const RISK_LABEL: Record<'en' | 'ru', Record<WikiProposalReadView['risk_class'], string>> = {
  en: { D0_MECHANICAL: 'Mechanical change', D1_LOW_RISK_ADDITIVE: 'Addition with low risk', D2_ANALYTICAL: 'Analytical change', D3_AUTHORITY_SENSITIVE: 'Change requiring authority review' },
  ru: { D0_MECHANICAL: 'Механическое изменение', D1_LOW_RISK_ADDITIVE: 'Дополнение с низким риском', D2_ANALYTICAL: 'Аналитическое изменение', D3_AUTHORITY_SENSITIVE: 'Изменение требует проверки полномочий' },
};

export type WikiSourceFreshness = WikiProposalReadView["source_freshness"];

import "./studio.css";

export type StudioFeatureState =
  | "useful" | "loading" | "empty" | "degraded" | "error";

export interface StudioFeatureCopy {
  readonly title: string;
  readonly intro: string;
  readonly list_label: string;
  readonly reader_label: string;
  readonly open_proposal: string;
  readonly open_artifact: string;
  readonly more_pages: string;
  readonly has_more: string;
  readonly list_end: string;
  readonly risk_label: string;
  readonly risk_unknown: string;
  readonly freshness_current: string;
  readonly freshness_previous: string;
  readonly freshness_unknown: string;
  readonly freshness_detail: string;
  readonly changed_source: string;
  readonly saved_revision: string;
  readonly head_revision: string;
  readonly edit_title_label: string;
  readonly edit_note_field_label: string;
  readonly edit_body_field_label: string;
  readonly body_label: string;
  readonly body_unavailable: string;
  readonly publication_none: string;
  readonly publication_accepted: string;
  readonly publication_other: string;
  readonly create_edit: string;
  readonly edit_note_label: string;
  readonly publish_review: string;
  readonly publish: string;
  readonly publish_confirm: string;
  readonly publish_ready: string;
  readonly publish_not_draft: string;
  readonly publish_unavailable: string;
  readonly revise_section: string;
  readonly revise_committed: string;
  readonly revise_open: string;
  readonly revise_unknown: string;
  readonly revise_cancelled: string;
  readonly revise_pending: string;
  readonly back: string;
  readonly close: string;
  readonly loading: string;
  readonly empty: string;
  readonly empty_list?: string;
  readonly empty_reader?: string;
  readonly degraded: string;
  readonly error: string;
}

/** What the screen may show for one selected proposal, narrowed from the accepted read view. */
export type SelectedProposal = Pick<
  WikiProposalReadView,
  "proposal_ref" | "page" | "risk_class" | "state" | "source_freshness" | "deployment_generation"
>;

export interface StudioFeatureProps {
  readonly locale: "en" | "ru";
  readonly copy: StudioFeatureCopy;
  readonly state: StudioFeatureState;
  /** The accepted proposal list view, already decoded by the root. */
  readonly proposals?: Pick<WikiProposalListView, "items" | "has_more">;
  /** The accepted read view for the selected proposal, already decoded by the root. */
  readonly selected?: SelectedProposal;
  /** The accepted, digest-verified body for the selected proposal. */
  readonly body?: { readonly text: string; readonly byte_length: number };
  /** The accepted publication view for the opened artifact, or null for no owner acceptance. */
  readonly publication?: ArtifactPublicationView | null;
  /** The accepted section revise result for the most recent section action. */
  readonly revise?: ArtifactSectionRevisionView;
  /** True once the root proved the copy-on-write lineage, so a new draft really is a new revision. */
  readonly cowVerified?: boolean;
  /**
   * The prior head revision the root derived from the client's own pure
   * `expectedWikiHeadRevision(page)`. The feature never computes it, because a Wiki page carries its own
   * revision rather than the head it supersedes. Absent means the root has not derived it, so no publish
   * control renders.
   */
  readonly expectedPublishHead?: number;
  /**
   * The saved artifact this page maps to, supplied only by the root from the actual artifact DTO. A
   * WikiPageType page cannot derive an artifact reference, so absent means no artifact control renders.
   */
  readonly artifactRef?: { readonly id: string; readonly revision: number };
  /**
   * The declared section refs for the supplied artifact, from the artifact DTO's section contracts.
   * Absent means the feature cannot revise anything, because a section id is never fabricated.
   */
  readonly declaredSectionRefs?: readonly string[];
  /**
   * Optional capabilities. A root that supplies no artifact ref or declared section refs omits these
   * callbacks entirely, and the corresponding controls are absent rather than disabled.
   */
  readonly onOpenArtifact?: (artifactRef: { readonly id: string; readonly revision: number }) => void;
  readonly onReviseSection?: (sectionId: string) => void;
  readonly onOpenProposal: (summary: WikiProposalSummaryItem) => void;
  readonly onCreateEdit: (input: {
    readonly baseProposalRef: { readonly id: string; readonly revision: number };
    readonly basePageRef: { readonly id: string; readonly revision: number };
    readonly expectedHeadRevision: number;
    readonly title: string;
    readonly bodyText: string;
    readonly editNote: string;
  }) => void;
  readonly onPublish: (input: {
    readonly proposalRef: { readonly id: string; readonly revision: number };
    readonly pageRef: { readonly id: string; readonly revision: number };
    readonly expectedHeadRevision: number;
  }) => void;
  readonly onBack: () => void;
}

const ref = (value: { readonly id: string; readonly revision: number }) =>
  `${value.id}:${value.revision}`;

/**
 * The CAS target is derived by the client's own pure helper, never guessed here. This component passes
 * the loaded page and lets the root call it, so the number can only come from immutable lineage.
 */
function FreshnessDetail({ freshness, copy, locale }: {
  readonly freshness: WikiSourceFreshness;
  readonly copy: StudioFeatureCopy;
  readonly locale: "en" | "ru";
}) {
  if (freshness.state === "UNKNOWN" && freshness.changed_sources.length === 0) return null;
  return (
    <details className="er-studio-live__disclosure">
      <summary>{copy.freshness_detail}</summary>
      <ul className="er-studio-live__changes">
        {freshness.changed_sources.map((change) => (
          <li key={change.source_id}>
            <span>{change.source_id}</span>
            <span>{copy.saved_revision}: {change.saved_revision_ref}</span>
            <span>{copy.head_revision}: {change.head_revision_ref}</span>
          </li>
        ))}
      </ul>
      <p className="er-studio-live__hint" lang={locale}>{copy.changed_source}</p>
    </details>
  );
}

export function StudioFeature({
  locale,
  copy,
  state,
  proposals,
  selected,
  body,
  publication,
  revise,
  cowVerified = false,
  expectedPublishHead,
  artifactRef,
  declaredSectionRefs,
  onOpenProposal,
  onOpenArtifact,
  onCreateEdit,
  onPublish,
  onReviseSection,
  onBack,
}: StudioFeatureProps) {
  const notesId = useId();
  const [confirming, setConfirming] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBodyChoice, setEditBodyChoice] = useState<string | undefined>(undefined);
  const selectedRef = selected?.proposal_ref;
  const page = selected?.page;

  /**
   * Publish is offered only for a PROPOSED draft whose lineage the root proved AND whose prior head
   * revision the root derived with the client own pure helper, never from the page revision.
   * Anything else renders an explicit reason, never a disabled affordance standing in for a state.
   * Publish is offered only for a PROPOSED draft whose copy-on-write lineage the root proved. Anything
   * else renders an explicit reason, never a disabled affordance standing in for a different state.
   */
  const publishable =
    selected?.state === "PROPOSED" && page?.status === "DRAFT" &&
    expectedPublishHead !== undefined && cowVerified;
  const needsHead = expectedPublishHead !== undefined && cowVerified;
  const publishReason =
    selected?.state !== "PROPOSED"
      ? copy.publish_not_draft
      : page?.status !== "DRAFT"
        ? copy.publish_not_draft
        : needsHead
          ? copy.publish_ready
          : copy.publish_unavailable;

  /**
   * The edit body starts from the digest-verified body the root supplies. An untouched editor keeps
   * that exact text, so an edit is never saved as an empty page, and the control stays unavailable
   * until the root supplied a verified body and the reader has a non-empty body to send.
   */
  const chosenBody = editBodyChoice ?? body?.text ?? "";
  const editReady = body !== undefined && chosenBody.trim() !== "";

  const freshness = selected?.source_freshness;
  const freshnessWords =
    freshness?.state === "CURRENT_REVISIONS"
      ? copy.freshness_current
      : freshness?.state === "PREVIOUS_REVISIONS"
        ? copy.freshness_previous
        : copy.freshness_unknown;

  const publicationWords =
    publication === undefined
      ? copy.publication_other
      : publication === null
        ? copy.publication_none
        : publication.revision.status === "ACCEPTED"
          ? copy.publication_accepted
          : copy.publication_other;

  const reviseWords =
    revise === undefined
      ? undefined
      : revise.state === "COMMITTED"
        ? copy.revise_committed
        : revise.state === "UNKNOWN"
          ? copy.revise_unknown
          : revise.state === "CANCELLED"
            ? copy.revise_cancelled
            : copy.revise_open;

  return (
    <section className="er-studio-live" aria-label={copy.title} lang={locale} data-selected={selected ? "" : undefined}>
      <header className="er-studio-live__head">
        <h2 className="er-studio-live__title">{copy.title}</h2>
        {selected === undefined ? null : (
          <IconButton label={copy.back} icon="chevron" onClick={onBack} />
        )}
      </header>
      <p className="er-studio-live__intro">{copy.intro}</p>

      <div className="er-studio-live__panes">
        <aside className="er-studio-live__list" aria-label={copy.list_label}>
          {state === "loading" || state === "degraded" ? (
            <Status>{copy.loading}</Status>
          ) : state === "empty" ? (
            <Status>{copy.empty_list ?? copy.empty}</Status>
          ) : state === "error" ? (
            <Status tone="error">{copy.error}</Status>
          ) : proposals === undefined || proposals.items.length === 0 ? (
            <Status>{copy.empty_list ?? copy.empty}</Status>
          ) : (
            <ul className="er-studio-live__items">
              {proposals.items.map((item) => (
                <li key={ref(item.proposal_ref)}>
                  <button
                    type="button"
                    className="er-studio-live__item"
                    aria-current={selectedRef !== undefined && selectedRef.id === item.proposal_ref.id}
                    onClick={() => onOpenProposal(item)}
                  >
                    <strong className="er-studio-live__item-title">{item.title}</strong>
                    <span className="er-studio-live__item-meta">
                      {PROPOSAL_LABEL[locale][item.state]}
                    </span>
                  </button>
                </li>
              ))}
              {proposals.has_more ? (
                <li className="er-studio-live__more">{copy.has_more}</li>
              ) : null}
            </ul>
          )}
        </aside>

        <div className="er-studio-live__reader" aria-label={copy.reader_label}>
          {selected === undefined || page === undefined ? (
            <Status>{copy.empty_reader ?? copy.empty}</Status>
          ) : (
            <article className="er-studio-live__detail">
              <h3 className="er-studio-live__detail-title">{page.title}</h3>
              <details className="er-studio-live__disclosure">
              <summary>{copy.publish_review} · {copy.risk_label}</summary>
              <dl className="er-studio-live__facts">
                <div>
                  <dt>{copy.risk_label}</dt>
                  <dd>{RISK_LABEL[locale][selected.risk_class]}</dd>
                </div>
                <div>
                  <dt>{copy.publish_review}</dt>
                  <dd>{PROPOSAL_LABEL[locale][selected.state]}</dd>
                </div>
              </dl>
              </details>
              <p className="er-studio-live__freshness">{freshnessWords}</p>
              {freshness === undefined ? null : (
                <FreshnessDetail freshness={freshness} copy={copy} locale={locale} />
              )}
              <h4 className="er-studio-live__subhead">{copy.body_label}</h4>
              {body === undefined ? (
                <Status>{copy.body_unavailable}</Status>
              ) : (
                <p className="er-studio-live__body">{body.text}</p>
              )}
              {publication !== undefined && <p className="er-studio-live__publication">{publicationWords}</p>}
              {reviseWords === undefined ? null : (
                <Status>{reviseWords}</Status>
              )}
              {publishable === false ? (
                <p className="er-studio-live__publish-state">{publishReason}</p>
              ) : null}
              <div className="er-studio-live__actions">
                {publishable ? (
                  confirming ? (
                    <>
                      <Button
                        variant="primary"
                        icon="send"
                        onClick={() => {
                          onPublish({
                            proposalRef: selected.proposal_ref,
                            pageRef: page.page_ref,
                            expectedHeadRevision: expectedPublishHead,
                          });
                          setConfirming(false);
                        }}
                      >
                        {copy.publish_confirm}
                      </Button>
                      <Button variant="text" onClick={() => setConfirming(false)}>
                        {copy.close}
                      </Button>
                    </>
                  ) : (
                    <Button variant="primary" icon="send" onClick={() => setConfirming(true)}>
                      {copy.publish}
                    </Button>
                  )
                ) : null}
                {declaredSectionRefs !== undefined && declaredSectionRefs.length > 0 && onReviseSection !== undefined ? <Button
                  variant="tonal"
                  icon="more"
                  onClick={() => {
                    const sectionRef = declaredSectionRefs?.[0];
                    if (sectionRef === undefined) return;
                    onReviseSection(sectionRef);
                  }}
                >
                  {copy.revise_section}
                </Button> : null}
                {artifactRef !== undefined && onOpenArtifact !== undefined ? <Button
                  variant="text"
                  icon="file"
                  onClick={() => {
                    if (artifactRef === undefined) return;
                    onOpenArtifact(artifactRef);
                  }}
                >
                  {copy.open_artifact}
                </Button> : null}
              </div>
              <section className="er-studio-live__edit-section" aria-labelledby={`${notesId}-edit-review`}>
                <h4 className="er-studio-live__edit-heading" id={`${notesId}-edit-review`}>{copy.edit_note_label}</h4>
                <label className="er-studio-live__field">
                  <span>{copy.edit_title_label}</span>
                  <input
                    className="er-studio-live__note"
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                  />
                </label>
                <label className="er-studio-live__field">
                  <span>{copy.edit_body_field_label}</span>
                  <textarea
                    className="er-studio-live__note"
                    value={chosenBody}
                    onChange={(event) => setEditBodyChoice(event.target.value)}
                  />
                </label>
                <label className="er-studio-live__field">
                  <span>{copy.edit_note_field_label}</span>
                  <textarea
                    id={notesId}
                    className="er-studio-live__note"
                    value={editNote}
                    onChange={(event) => setEditNote(event.target.value)}
                  />
                </label>
                <div className="er-studio-live__actions">
                  <Button
                    variant="tonal"
                    icon="bookmarks"
                    disabled={!editReady}
                    onClick={() => {
                      onCreateEdit({
                        baseProposalRef: selected.proposal_ref,
                        basePageRef: page.page_ref,
                        expectedHeadRevision: page.page_ref.revision,
                        title: editTitle === "" ? page.title : editTitle,
                        bodyText: chosenBody,
                        editNote,
                      });
                    }}
                  >
                    {copy.create_edit}
                  </Button>
                </div>
              </section>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
const EN_COPY: StudioFeatureCopy = {
  title: "Studio",
  intro: "Saved drafts and Wiki proposals, with their acceptance and publication stated separately.",
  list_label: "Saved proposals",
  reader_label: "Selected proposal",
  open_proposal: "Open the selected proposal",
  open_artifact: "Open the saved report",
  more_pages: "More proposals are available.",
  has_more: "More proposals are available.",
  list_end: "No further proposals.",
  risk_label: "Risk class",
  risk_unknown: "Risk class unknown",
  freshness_current: "Sources match the revisions this page was written against.",
  freshness_previous: "This page uses earlier source revisions than the current ones.",
  freshness_unknown: "Source freshness is unknown for this page.",
  freshness_detail: "Show the changed sources",
  changed_source: "The revision each source had when this page was written, next to the current one.",
  saved_revision: "Saved revision",
  head_revision: "Current revision",
  body_label: "Proposal body",
  body_unavailable: "This proposal body is not available.",
  edit_title_label: "New title",
  edit_note_field_label: "Edit note",
  edit_body_field_label: "New body text",
  publication_none: "This revision has no owner acceptance yet.",
  publication_accepted: "This revision has an owner acceptance.",
  publication_other: "Publication state is unknown for this revision.",
  create_edit: "Create a new draft from this page",
  edit_note_label: "Prepare a new draft",
  publish_review: "Proposal state",
  publish: "Publish page",
  publish_confirm: "Confirm publication",
  publish_ready: "This draft is ready to publish after your review.",
  publish_not_draft: "This proposal is not a publishable draft.",
  publish_unavailable: "Publication is unavailable for this draft.",
  revise_section: "Revise and verify a section",
  revise_committed: "The section revision was committed.",
  revise_open: "The section revision is awaiting reconciliation.",
  revise_unknown: "The section effect is uncertain and is not retried for you.",
  revise_cancelled: "The section revision was cancelled.",
  revise_pending: "The section revision is still being written.",
  back: "Back to the list",
  close: "Close the review",
  loading: "Reading saved proposals.",
  empty: "No saved drafts or proposals are available yet.",
  empty_list: "No saved proposals yet.",
  empty_reader: "No proposal is selected.",
  degraded: "Some saved data could not be read. What is shown is what was verified.",
  error: "Saved proposals could not be read. Nothing was shown.",
};
const RU_COPY: StudioFeatureCopy = {
  title: "Студия",
  intro: "Сохранённые черновики и предложения Wiki, с принятием и публикацией отдельно.",
  list_label: "Сохранённые предложения",
  reader_label: "Выбранное предложение",
  open_proposal: "Открыть выбранное предложение",
  open_artifact: "Открыть сохранённый отчёт",
  more_pages: "Доступны дополнительные предложения.",
  has_more: "Доступны дополнительные предложения.",
  list_end: "Дополнительных предложений нет.",
  risk_label: "Класс риска",
  risk_unknown: "Класс риска неизвестен",
  freshness_current: "Источники соответствуют версиям, против которых написана страница.",
  freshness_previous: "Эта страница использует более ранние версии источников, чем текущие.",
  freshness_unknown: "Свежесть источников для этой страницы неизвестна.",
  freshness_detail: "Показать изменённые источники",
  changed_source: "Версия каждого источника на момент написания страницы рядом с текущей.",
  saved_revision: "Сохранённая версия",
  head_revision: "Текущая версия",
  body_label: "Текст предложения",
  body_unavailable: "Текст этого предложения недоступен.",
  edit_title_label: "Новый заголовок",
  edit_note_field_label: "Примечание к правке",
  edit_body_field_label: "Новый текст страницы",
  publication_none: "У этой версии пока нет принятия владельцем.",
  publication_accepted: "Эта версия имеет принятие владельцем.",
  publication_other: "Состояние публикации для этой версии неизвестно.",
  create_edit: "Создать новый черновик из этой страницы",
  edit_note_label: "Подготовить новый черновик",
  publish_review: "Состояние предложения",
  publish: "Опубликовать страницу",
  publish_confirm: "Подтвердить публикацию",
  publish_ready: "Этот черновик готов к публикации после вашей проверки.",
  publish_not_draft: "Это предложение не является публикуемым черновиком.",
  publish_unavailable: "Публикация этого черновика недоступна.",
  revise_section: "Пересмотреть и проверить раздел",
  revise_committed: "Версия раздела зафиксирована.",
  revise_open: "Версия раздела ожидает сверки.",
  revise_unknown: "Эффект раздела неопределён и не перезапускается за вас.",
  revise_cancelled: "Версия раздела отменена.",
  revise_pending: "Версия раздела ещё записывается.",
  back: "Назад к списку",
  close: "Закрыть проверку",
  loading: "Читаем сохранённые предложения.",
  empty: "Сохранённых черновиков или предложений пока нет.",
  empty_list: "Сохранённых предложений пока нет.",
  empty_reader: "Предложение не выбрано.",
  degraded: "Часть сохранённых данных не прочитана. Показано только проверенное.",
  error: "Сохранённые предложения не прочитаны. Ничего не показано.",
};

export const STUDIO_COPY: {
  readonly en: StudioFeatureCopy;
  readonly ru: StudioFeatureCopy;
} = { en: EN_COPY, ru: RU_COPY };
