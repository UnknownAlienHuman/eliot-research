// U2-S synthetic Sources fixture. No fetch, provider call, identifier or raw error
// text. Selection applies to the next question only; a current or completed
// report keeps its own scope. Conversion options are never claimed as chosen.
import { useState, type ReactNode } from "react";
import { Button, Dialog, Field, Status } from "../../../primitives/primitives";
import "./sources-fixture.css";

export type SourcesLocale = "en" | "ru";
export type SourcesView = "useful" | "loading" | "empty" | "degraded" | "error";
export type SourcesCaptureState = "OBSERVED" | "RESOLVING" | "CAPTURED" | "REJECTED" | "EXPIRED";
export type SourcesAdmissionState = "ADMITTED" | "DUPLICATE" | "QUARANTINED" | "REJECTED";
export type SourcesReadinessChannel =
  | "captured" | "normalized" | "structure_qualified" | "exact_ready" | "lexical_ready" | "semantic_ready"
  | "sourcecard_ready" | "atlas_included" | "distillates_ready" | "wiki_published";
export type SourcesReadinessState =
  | "not_requested" | "queued" | "running" | "ready" | "degraded" | "failed" | "stale" | "redacted";

export type SourcesSource = {
  readonly key: string;
  readonly title: Record<SourcesLocale, string>;
  readonly capture: SourcesCaptureState;
  readonly admission?: SourcesAdmissionState;
  readonly sampleRevision: string;
  readonly sampleExcerpt: Record<SourcesLocale, string>;
  readonly readiness: Readonly<Record<SourcesReadinessChannel, SourcesReadinessState>>;
};

type SourcesFacet = "ready" | "partial" | "unavailable" | "off";
type Ready = Partial<Record<SourcesReadinessChannel, SourcesReadinessState>>;
const SEARCH: readonly SourcesReadinessChannel[] = ["lexical_ready", "semantic_ready"];
const EVIDENCE: readonly SourcesReadinessChannel[] = ["structure_qualified", "exact_ready"];
const EVERY: readonly SourcesReadinessChannel[] = ["captured", "normalized",
  "structure_qualified", "exact_ready", "lexical_ready", "semantic_ready", "sourcecard_ready",
  "atlas_included", "distillates_ready", "wiki_published"];

function channels(ready: Ready): Record<SourcesReadinessChannel, SourcesReadinessState> {
  const base = {} as Record<SourcesReadinessChannel, SourcesReadinessState>;
  for (const name of EVERY) base[name] = ready[name] ?? "not_requested";
  return base;
}

/** A facet is ready only when every channel it covers is ready. */
function facet(source: SourcesSource, of: readonly SourcesReadinessChannel[]): SourcesFacet {
  const states = of.map((name) => source.readiness[name]);
  if (states.every((state) => state === "not_requested")) return "off";
  if (states.includes("failed") || states.includes("redacted")) return "unavailable";
  if (states.every((state) => state === "ready")) return "ready";
  return "partial";
}

const INITIAL: readonly SourcesSource[] = [
  { key: "notes-4", capture: "CAPTURED", admission: "ADMITTED", sampleRevision: "3 / 3",
    title: { en: "Notes on evidence and clear thinking", ru: "Заметки о доказательствах и ясном мышлении" },
    sampleExcerpt: {
      en: "Clarity starts with a clear relationship between the question, the source, and the claim.",
      ru: "Ясность начинается с понятной связи между вопросом, источником и утверждением.",
    },
    readiness: channels({ captured: "ready", normalized: "ready", structure_qualified: "ready", exact_ready: "ready", lexical_ready: "ready", semantic_ready: "ready", sourcecard_ready: "queued" }) },
  { key: "datasheets", capture: "CAPTURED", admission: "ADMITTED", sampleRevision: "1 / 1",
    title: { en: "A knowledge workspace: questions, source scope and uncertainty in everyday research",
      ru: "Рабочее пространство знаний: вопросы, набор источников и неопределённость в повседневной исследовательской работе" },
    sampleExcerpt: {
      en: "A saved draft preserves the material available at the time. Later additions belong to the next question, not the earlier report.",
      ru: "Сохранённый черновик сохраняет материалы, доступные на тот момент. Позднейшие дополнения относятся к следующему вопросу, а не к предыдущему отчёту.",
    },
    readiness: channels({ captured: "ready", normalized: "ready", structure_qualified: "ready", exact_ready: "ready", lexical_ready: "ready", semantic_ready: "degraded" }) },
  { key: "transcript", capture: "OBSERVED", sampleRevision: "",
    title: { en: "Reading list for the next review", ru: "Список чтения для следующего обзора" },
    sampleExcerpt: {
      en: "This source has not been captured yet, so there is no sample text to read.",
      ru: "Этот источник ещё не захвачен, поэтому образца текста для чтения нет.",
    },
    readiness: channels({}) },
];

const COPY = {
  en: { title: "Your source library", details: "Processing details", subtitle: "Pick sources for your next question.",
    scope: "A current or completed report keeps its own scope. This selection never changes it.",
    conversionLabel: "Text conversion", conversion: "Options not chosen",
    capture: "Capture", admission: "Admission",
    search: "Search ready", evidence: "Evidence ready",
    noAdmission: "No admission decision yet; an observed candidate is not admitted.",
    add: "Add source", addTitle: "Add a source", addLabel: "Source title", save: "Save source",
    titleRequired: "Enter a source title.", open: "Open", closeReader: "Close reader",
    close: "Cancel",
    sampleRevision: "Sample revision", coordinates: "Native coordinates",
    noRevision: "No sample revision yet", unknownCoordinates: "Unknown for this sample",
    loading: "Loading project sources…", empty: "No sources yet. Add a source to ask a question.",
    degraded: "Readiness is temporarily unavailable. Selection still works.",
    error: "Sources could not be loaded." },
  ru: {
    title: "Библиотека источников", details: "Сведения об обработке", subtitle: "Выберите источники для следующего вопроса.",
    scope: "Текущее или выполненное исследование сохраняет свою область. Этот выбор её не меняет.",
    conversionLabel: "Преобразование в текст", conversion: "Параметры не выбраны",
    capture: "Захват", admission: "Допуск",
    search: "Готовность к поиску", evidence: "Готовность к доказательствам",
    noAdmission: "Решения о допуске нет: наблюдаемый кандидат не допущен.",
    add: "Добавить источник", addTitle: "Добавить источник", addLabel: "Название источника", save: "Сохранить источник",
    titleRequired: "Введите название источника.", open: "Открыть", closeReader: "Закрыть чтение",
    close: "Отмена",
    sampleRevision: "Образец ревизии", coordinates: "Нативные координаты",
    noRevision: "Образца ревизии пока нет", unknownCoordinates: "Неизвестны для этого образца",
    loading: "Загрузка источников проекта…", empty: "Источников пока нет. Добавьте источник, чтобы задать вопрос.",
    degraded: "Готовность временно недоступна. Выбор по-прежнему работает.",
    error: "Не удалось загрузить источники." },
} as const;

const CAPTURE_LABEL = {
  en: { OBSERVED: "Waiting to be captured", RESOLVING: "Resolving source", CAPTURED: "Captured", REJECTED: "Not captured", EXPIRED: "Capture expired" },
  ru: { OBSERVED: "Ожидает захвата", RESOLVING: "Уточняется", CAPTURED: "Захвачен", REJECTED: "Не захвачен", EXPIRED: "Захват истёк" },
} as const;

const ADMISSION_LABEL = {
  en: { ADMITTED: "Admitted", DUPLICATE: "Already in the library", QUARANTINED: "Quarantined", REJECTED: "Rejected" },
  ru: { ADMITTED: "Допущен", DUPLICATE: "Уже в библиотеке", QUARANTINED: "На карантине", REJECTED: "Отклонён" },
} as const;

const FACET_LABEL = {
  en: { ready: "Ready", partial: "Partly ready", unavailable: "Unavailable", off: "Not requested" },
  ru: { ready: "Готов", partial: "Частично готов", unavailable: "Недоступно", off: "Не запрашивалось" },
} as const;

export type SourcesFixtureDialog = { readonly kind: "add" } | { readonly kind: "reader"; readonly key: string } | null;
export type SourcesFixtureProps = {
  readonly view?: SourcesView;
  readonly locale?: SourcesLocale;
  /** False while this destination is hidden; closes any open dialog. */
  readonly active?: boolean;
  /** A composition root may own local context history. Undefined uses standalone dialog state. */
  readonly dialog?: SourcesFixtureDialog;
  readonly onDialogChange?: (dialog: SourcesFixtureDialog) => void;
  readonly sources?: readonly SourcesSource[];
  readonly selection?: readonly string[];
  readonly onSelection?: (keys: readonly string[]) => void;
  readonly onOpenSource?: (key: string) => void;
  readonly onAddSource?: (title: string) => void;
  readonly children?: ReactNode;
};

export function SourcesFixture({ view = "useful", locale = "en", active = true, dialog, onDialogChange, sources, selection,
  onSelection, onOpenSource, onAddSource, children }: SourcesFixtureProps) {
  const copy = COPY[locale];
  const [addedRows, setAddedRows] = useState<readonly SourcesSource[]>([]);
  const rows = [...(sources ?? (view === "empty" ? [] : INITIAL)), ...addedRows];
  const [own, setOwn] = useState<readonly string[]>(view === "empty" ? [] : ["notes-4"]);
  const [ownDialog, setOwnDialog] = useState<SourcesFixtureDialog>(null);
  if (!active && ownDialog !== null) setOwnDialog(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string>();
  const [added, setAdded] = useState(0);
  const selected = selection ?? own;
  const currentDialog = dialog === undefined ? ownDialog : dialog;
  const addVisible = active && currentDialog?.kind === "add";
  const source = active && currentDialog?.kind === "reader" ? rows.find(item => item.key === currentDialog.key) : undefined;
  const list = rows;
  const requestDialog = (next: SourcesFixtureDialog) => {
    if (dialog === undefined) setOwnDialog(next);
    onDialogChange?.(next);
  };

  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((value) => value !== key) : [...selected, key];
    setOwn(next);
    onSelection?.(next);
  };

  const openReader = (key: string) => {
    requestDialog({ kind: "reader", key });
    onOpenSource?.(key);
  };

  const save = () => {
    const value = draft.trim();
    if (value.length === 0) {
      setDraftError(copy.titleRequired);
      return;
    }
    setAddedRows((previous) => [...previous, {
      key: "added-" + String(added), title: { en: value, ru: value }, capture: "CAPTURED",
      sampleRevision: "",
      sampleExcerpt: { en: "This source was just captured. No sample text is available yet.",
        ru: "Этот источник только что захвачен. Образец текста пока недоступен." },
      readiness: channels({ captured: "ready" }),
    }]);
    setAdded(added + 1); setDraft(""); setDraftError(undefined); requestDialog(null);
    onAddSource?.(value);
  };

  const rowList = (items: readonly SourcesSource[]) => (
    <ul className="er-sources-fixture__list">
      {items.map((item) => (
        <li key={item.key} className="er-sources-fixture__row">
          <div className="er-sources-fixture__lead">
            <label className="er-sources-fixture__select">
              <input type="checkbox" checked={selected.includes(item.key)} disabled={item.admission !== "ADMITTED"} onChange={() => toggle(item.key)} />
              <span className="er-sources-fixture__name">{item.title[locale]}</span>
            </label>
            <Button
              variant="text"
              aria-label={copy.open + ": " + item.title[locale]}
              onClick={() => openReader(item.key)}
            >
              {copy.open}
            </Button>
          </div>
          <details className="er-sources-fixture__processing"><summary>{copy.details}</summary><dl className="er-sources-fixture__facts">
            <dt>{copy.capture}</dt><dd>{CAPTURE_LABEL[locale][item.capture]}</dd>
            <dt>{copy.conversionLabel}</dt><dd>{copy.conversion}</dd>
            <dt>{copy.admission}</dt>
            <dd>{item.admission === undefined ? copy.noAdmission : ADMISSION_LABEL[locale][item.admission]}</dd>
            <dt>{copy.search}</dt><dd>{FACET_LABEL[locale][facet(item, SEARCH)]}</dd>
            <dt>{copy.evidence}</dt><dd>{FACET_LABEL[locale][facet(item, EVIDENCE)]}</dd>
          </dl></details>
        </li>
      ))}
    </ul>
  );

  if (view === "loading") {
    return (
      <section className="er-sources-fixture" aria-busy="true">
        <header className="er-sources-fixture__head"><h2 className="er-sources-fixture__heading">{copy.title}</h2></header>
        <ul className="er-sources-fixture__list">
          {[0, 1, 2].map((row) => <li key={row} className="er-sources-fixture__skeleton" aria-hidden="true" />)}
        </ul>
        <Status>{copy.loading}</Status>
      </section>
    );
  }

  return (
    <section className="er-sources-fixture">
      <header className="er-sources-fixture__head">
        <h2 className="er-sources-fixture__heading">{copy.title}</h2>
        <p className="er-sources-fixture__hint">{copy.subtitle}</p>
        <Button icon="add" onClick={() => requestDialog({ kind: "add" })}>{copy.add}</Button>
      </header>
      {view === "degraded" || view === "error" ? <Status tone="error">{view === "error" ? copy.error : copy.degraded}</Status> : null}
      {list.length === 0 ? (
        <Status>{copy.empty}</Status>
      ) : (
        rowList(list)
      )}
      <p className="er-sources-fixture__note">{copy.scope}</p>
      {children}
      <Dialog open={addVisible} title={copy.addTitle} onClose={() => requestDialog(null)}>
        <Field
          label={copy.addLabel}
          value={draft}
          {...(draftError === undefined ? {} : { error: draftError })}
          required
          onChange={(event) => { setDraft(event.target.value); setDraftError(undefined); }}
        />
        <div className="er-sources-fixture__actions">
          <Button onClick={save}>{copy.save}</Button>
          <Button variant="text" onClick={() => requestDialog(null)}>{copy.close}</Button>
        </div>
      </Dialog>
      <Dialog open={source !== undefined} title={source === undefined ? "" : source.title[locale]}
        onClose={() => requestDialog(null)}>
        {source === undefined ? null : (
          <>
            <p className="er-sources-fixture__excerpt">{source.sampleExcerpt[locale]}</p>
            <dl className="er-sources-fixture__facts">
              <dt>{copy.sampleRevision}</dt>
              <dd>{source.sampleRevision === "" ? copy.noRevision : source.sampleRevision}</dd>
              <dt>{copy.coordinates}</dt><dd>{copy.unknownCoordinates}</dd>
              <dt>{copy.admission}</dt>
              <dd>{source.admission === undefined ? copy.noAdmission : ADMISSION_LABEL[locale][source.admission]}</dd>
            </dl>
            <div className="er-sources-fixture__actions">
              <Button variant="text" onClick={() => requestDialog(null)}>{copy.closeReader}</Button>
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}
