import { useState } from "react";
import { Button, IconButton, Status } from "../../../primitives/primitives";
import "../../../tokens/theme.css";
import "./studio-fixture.css";

/**
 * StudioFixture — private U2-T fixture. Local synthetic sample only. No fetch, no
 * endpoint, no contract identifier enters the visible copy. The fact that a report is
 * saved is shown explicitly, and a Wiki proposal is never presented as accepted.
 */
export type StudioEvidence = "saved" | "unknown";
export type StudioProposalState = "none" | "proposed";

export interface StudioCopy {
  readonly studio: string;
  readonly savedFact: string;
  readonly openReport: string;
  readonly createProposal: string;
  readonly proposalCreated: string;
  readonly proposalState: string;
  readonly riskLabel: string;
  readonly riskUnknown: string;
  readonly evidenceUnknown: string;
}

export interface StudioFixtureCopy extends StudioCopy {
  readonly loading: string;
  readonly empty: string;
  readonly cancelled: string;
  readonly interrupted: string;
  readonly error: string;
  readonly reset: string;
}

export interface StudioFixtureProps {
  readonly locale?: "en" | "ru";
  readonly copy?: StudioFixtureCopy;
  readonly reportBody?: string;
  readonly onOpenReport?: () => void;
  readonly onCreateProposal?: () => void;
  readonly state?: "useful" | "loading" | "empty" | "degraded" | "error" | "cancelled";
}

const EN_COPY: StudioFixtureCopy = {
  studio: "Saved drafts",
  savedFact: "A sample draft is saved locally. Acceptance and publication are unknown.",
  openReport: "Open sample draft",
  createProposal: "Create sample Wiki proposal",
  proposalCreated: "A sample Wiki proposal was created locally.",
  proposalState: "State: proposed",
  riskLabel: "Sample risk class: additive change, low risk",
  riskUnknown: "Sample risk class unknown",
  evidenceUnknown: "Current evidence for this report is unknown.",
  loading: "Opening the saved draft…",
  empty: "No saved drafts or runs are available yet.",
  cancelled: "This run was cancelled by its owner. No retry is offered.",
  interrupted: "Reading the draft was interrupted before it finished. Nothing was shown.",
  error: "The sample draft could not be opened. Its saved state is unknown.",
  reset: "Close sample draft and clear proposal",
};

const RU_COPY: StudioFixtureCopy = {
  studio: "Сохранённые черновики",
  savedFact: "Учебный черновик сохранён локально. Принятие и публикация неизвестны.",
  openReport: "Открыть учебный черновик",
  createProposal: "Создать образец предложения Wiki",
  proposalCreated: "Образец предложения Wiki создан локально.",
  proposalState: "Состояние: предложено",
  riskLabel: "Образец класса риска: добавление с низким риском",
  riskUnknown: "Образец класса риска неизвестен",
  evidenceUnknown: "Текущие доказательства по этому отчёту неизвестны.",
  loading: "Открытие сохранённого черновика…",
  empty: "Сохранённых черновиков и запусков пока нет.",
  cancelled: "Этот запуск отменён его владельцем. Повтор не предлагается.",
  interrupted: "Чтение черновика было прервано до завершения. Ничего не было показано.",
  error: "Не удалось открыть учебный черновик. Состояние сохранения неизвестно.",
  reset: "Закрыть учебный черновик и убрать предложение",
};

const EN_BODY = "Sample saved draft. This is fixture text, not a server result. Read it in full before acting on it.";
const RU_BODY = "Образец сохранённого черновика. Это текст фикстуры, а не результат сервера. Прочитайте его полностью, прежде чем действовать по нему.";

export function StudioFixture({
  locale = "en",
  copy,
  reportBody,
  onOpenReport,
  onCreateProposal,
  state = "useful",
}: StudioFixtureProps) {
  const strings = copy ?? (locale === "ru" ? RU_COPY : EN_COPY);
  const body = reportBody ?? (locale === "ru" ? RU_BODY : EN_BODY);
  const [open, setOpen] = useState(false);
  const [proposal, setProposal] = useState<StudioProposalState>("none");
  if (state === "loading") {
    return (
      <section className="er-studio" lang={locale} aria-label={strings.studio}>
        <Status tone="neutral" icon="evidence">{strings.loading}</Status>
      </section>
    );
  }
  if (state === "empty") {
    return (
      <section className="er-studio" lang={locale} aria-label={strings.studio}>
        <Status tone="neutral" icon="bookmarks">{strings.empty}</Status>
      </section>
    );
  }
  if (state === "degraded") {
    return (
      <section className="er-studio" lang={locale} aria-label={strings.studio} role="status">
        <p className="er-studio__saved">{strings.interrupted}</p>
      </section>
    );
  }
  if (state === "error" || state === "cancelled") {
    return (
      <section className="er-studio" lang={locale} aria-label={strings.studio} role="alert">
        <Status tone={state === "error" ? "error" : "neutral"} icon="close">{state === "error" ? strings.error : strings.cancelled}</Status>
      </section>
    );
  }
  return (
    <section className="er-studio" lang={locale} aria-label={strings.studio}>
      <header className="er-studio__head">
        <h2 className="er-studio__title">{strings.studio}</h2>
        <Status tone="neutral" icon="evidence">{strings.evidenceUnknown}</Status>
      </header>
      <p className="er-studio__saved">{strings.savedFact}</p>
      <div className="er-studio__actions">
        <Button
          variant="primary"
          icon="file"
          aria-expanded={open}
          onClick={() => { setOpen((current) => !current); onOpenReport?.(); }}
        >
          {strings.openReport}
        </Button>
        {open && <Button
          variant="tonal"
          icon="bookmarks"
          disabled={proposal === "proposed"}
          onClick={() => { setProposal("proposed"); onCreateProposal?.(); }}
        >
          {strings.createProposal}
        </Button>}
        {open && <IconButton label={strings.reset} icon="close" onClick={() => { setOpen(false); setProposal("none"); }} />}
      </div>
      {open ? <p className="er-studio__report">{body}</p> : null}
      {proposal === "proposed" ? (
        <div className="er-studio__proposal" role="status">
          <p>{strings.proposalCreated}</p>
          <strong>{strings.proposalState}</strong>
          <span>{strings.riskLabel}</span>
        </div>
      ) : null}
    </section>
  );
}
