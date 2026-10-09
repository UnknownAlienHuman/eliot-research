import { useState } from "react";
import { Button, Status, type StatusTone } from "../../../primitives/primitives";
import "./connections-fixture.css";

export type ConnectionsRowId =
  | "worker" | "session" | "grant" | "provider" | "transport" | "observation" | "research";
export type ConnectionsRowState =
  | "ready" | "checking" | "unknown" | "configuration" | "authentication" | "transport";
export type ConnectionsScreenState = "useful" | "loading" | "empty" | "degraded" | "error";
export type ConnectionsLocale = "en" | "ru";

/** One independent public fact. No row is derived from any other row. */
export interface ConnectionsRow {
  readonly id: ConnectionsRowId;
  readonly state: ConnectionsRowState;
  readonly tone: StatusTone;
  readonly label: string;
  readonly detail: string;
}

export interface ConnectionsScreenText {
  readonly title: string;
  readonly detail: string;
}

export interface ConnectionsFixtureProps {
  readonly locale?: ConnectionsLocale;
  readonly state?: ConnectionsScreenState;
  readonly rows?: readonly ConnectionsRow[];
  readonly diagnostic?: string;
  readonly onSample?: () => void;
  readonly onRecover?: () => void;
}

/** Sample only. Never presented as a real server answer. */
export const SAMPLE_DIAGNOSTIC_TRACE = "sample-trace-0001";

const INITIAL_STATES: Record<ConnectionsScreenState, readonly ConnectionsRowState[]> = {
  useful: ["ready", "ready", "ready", "ready", "ready", "ready", "ready"],
  loading: ["checking", "checking", "checking", "checking", "checking", "checking", "checking"],
  empty: ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"],
  degraded: ["ready", "unknown", "ready", "unknown", "unknown", "unknown", "unknown"],
  error: ["configuration", "authentication", "transport", "unknown", "transport", "unknown", "unknown"],
};

const ROW_ORDER: readonly ConnectionsRowId[] = [
  "worker", "session", "grant", "provider", "transport", "observation", "research",
];

const ROW_LABEL: Record<ConnectionsLocale, Record<ConnectionsRowId, string>> = {
  en: {
    worker: "Server and API",
    session: "Owner session",
    grant: "Project permission",
    provider: "Model provider",
    transport: "Google transport",
    observation: "Observed client call",
    research: "Active research",
  },
  ru: {
    worker: "Сервер и интерфейс",
    session: "Сеанс владельца",
    grant: "Разрешение проекта",
    provider: "Поставщик модели",
    transport: "Транспорт Google",
    observation: "Зафиксированный вызов клиента",
    research: "Активное исследование",
  },
};

const SCREEN: Record<ConnectionsLocale, Record<ConnectionsScreenState, ConnectionsScreenText>> = {
  en: {
    useful: { title: "Sample connection facts", detail: "Each row is a separate fact. Sample wording marks every row." },
    loading: { title: "Checking", detail: "The sample check is in progress." },
    empty: { title: "No checked facts yet", detail: "Run the sample check to fill the rows." },
    degraded: { title: "Some facts are unknown", detail: "Unknown is a valid answer. Nothing here is assumed." },
    error: { title: "The check could not complete", detail: "No work was affected. Try the sample recovery." },
  },
  ru: {
    useful: { title: "Учебные сведения о подключении", detail: "Каждая строка — отдельный факт. Отметка «Учебный» стоит у каждой строки." },
    loading: { title: "Выполняется проверка", detail: "Учебная проверка выполняется." },
    empty: { title: "Проверенных сведений ещё нет", detail: "Запустите учебную проверку, чтобы заполнить строки." },
    degraded: { title: "Часть сведений неизвестна", detail: "«Неизвестно» — допустимый ответ. Здесь ничего не предполагается." },
    error: { title: "Проверка не завершилась", detail: "Работа не затронута. Попробуйте учебное восстановление." },
  },
};

const ACTION: Record<ConnectionsLocale, { check: string; signIn: string; clear: string }> = {
  en: { check: "Check sample", signIn: "Sample sign-in", clear: "Clear observation" },
  ru: { check: "Проверить учебный пример", signIn: "Учебный вход", clear: "Очистить наблюдение" },
};

/** Each row's readable detail is derived from its own state on every render. */
const DETAIL: Record<ConnectionsLocale, Record<ConnectionsRowId, Record<ConnectionsRowState, string>>> = {
  en: {
    worker: {
      ready: "Sample API answered",
      checking: "Checking the sample API",
      unknown: "Not checked yet",
      configuration: "Sample API needs configuration",
      authentication: "Not checked yet",
      transport: "Not checked yet",
    },
    session: {
      ready: "Sample session is valid",
      checking: "Checking the sample session",
      unknown: "Sample session is missing",
      configuration: "Not checked yet",
      authentication: "Sample sign-in required",
      transport: "Not checked yet",
    },
    grant: {
      ready: "Sample grant present",
      checking: "Checking the sample grant",
      unknown: "Not checked yet",
      configuration: "Not checked yet",
      authentication: "Not checked yet",
      transport: "Not checked yet",
    },
    provider: {
      ready: "Sample provider configured",
      checking: "Checking the sample provider",
      unknown: "Sample qualification unknown",
      configuration: "Sample provider needs configuration",
      authentication: "Not checked yet",
      transport: "Not checked yet",
    },
    transport: {
      ready: "Sample Google transport configured",
      checking: "Checking the sample transport",
      unknown: "Sample transport unverified",
      configuration: "Not checked yet",
      authentication: "Not checked yet",
      transport: "Sample transport check failed",
    },
    observation: {
      ready: "Sample client call checked",
      checking: "Checking the sample client call",
      unknown: "Sample client call unknown",
      configuration: "Not checked yet",
      authentication: "Not checked yet",
      transport: "Not checked yet",
    },
    research: {
      ready: "Sample run observed",
      checking: "Checking the sample run",
      unknown: "Sample run unknown",
      configuration: "Not checked yet",
      authentication: "Not checked yet",
      transport: "Not checked yet",
    },
  },
  ru: {
    worker: {
      ready: "Учебный интерфейс ответил",
      checking: "Проверяется учебный интерфейс",
      unknown: "Ещё не проверено",
      configuration: "Учебному интерфейсу нужна настройка",
      authentication: "Ещё не проверено",
      transport: "Ещё не проверено",
    },
    session: {
      ready: "Учебный сеанс действителен",
      checking: "Проверяется учебный сеанс",
      unknown: "Учебный сеанс отсутствует",
      configuration: "Ещё не проверено",
      authentication: "Учебный вход требуется",
      transport: "Ещё не проверено",
    },
    grant: {
      ready: "Учебное разрешение получено",
      checking: "Проверяется учебное разрешение",
      unknown: "Ещё не проверено",
      configuration: "Ещё не проверено",
      authentication: "Ещё не проверено",
      transport: "Ещё не проверено",
    },
    provider: {
      ready: "Учебный поставщик настроен",
      checking: "Проверяется учебный поставщик",
      unknown: "Учебная квалификация неизвестна",
      configuration: "Учебному поставщику нужна настройка",
      authentication: "Ещё не проверено",
      transport: "Ещё не проверено",
    },
    transport: {
      ready: "Учебный транспорт Google настроен",
      checking: "Проверяется учебный транспорт",
      unknown: "Учебный транспорт не проверен",
      configuration: "Ещё не проверено",
      authentication: "Ещё не проверено",
      transport: "Учебная проверка транспорта не выполнена",
    },
    observation: {
      ready: "Учебный вызов клиента проверен",
      checking: "Проверяется учебный вызов клиента",
      unknown: "Учебный вызов клиента неизвестен",
      configuration: "Ещё не проверено",
      authentication: "Ещё не проверено",
      transport: "Ещё не проверено",
    },
    research: {
      ready: "Учебный запуск зафиксирован",
      checking: "Проверяется учебный запуск",
      unknown: "Учебный запуск неизвестен",
      configuration: "Ещё не проверено",
      authentication: "Ещё не проверено",
      transport: "Ещё не проверено",
    },
  },
};

const NOTE: Record<ConnectionsLocale, { independent: string; diagnostic: string; sample: string; checkedAt: string }> = {
  en: {
    independent: "There is no overall status. No row is inferred from another row.",
    diagnostic: "Sample diagnostic",
    sample: "Sample",
    checkedAt: "local observation recorded during this review",
  },
  ru: {
    independent: "Общего статуса нет. Ни одна строка не выводится из другой.",
    diagnostic: "Учебная диагностика",
    sample: "Учебный",
    checkedAt: "локальное наблюдение записано при этом просмотре",
  },
};

function detailFor(id: ConnectionsRowId, state: ConnectionsRowState, locale: ConnectionsLocale): string {
  return DETAIL[locale][id][state];
}

function rowsFromStates(
  locale: ConnectionsLocale,
  states: readonly ConnectionsRowState[],
  observedAt: boolean,
): readonly ConnectionsRow[] {
  return ROW_ORDER.map((id, index) => ({
    id,
    state: states[index] ?? "unknown",
    tone: "neutral",
    label: ROW_LABEL[locale][id],
    detail: id === "observation" && states[index] === "ready" && observedAt
      ? DETAIL[locale][id].ready + " · " + NOTE[locale].checkedAt
      : detailFor(id, states[index] ?? "unknown", locale),
  }));
}

export function ConnectionsFixture(props: ConnectionsFixtureProps) {
  // Changing the deterministic scenario resets only this local sample, not a route/breakpoint root.
  return <ConnectionsScenario key={props.state ?? "useful"} {...props} />;
}

function ConnectionsScenario({
  locale = "en",
  state = "useful",
  rows: providedRows,
  diagnostic,
  onSample,
  onRecover,
}: ConnectionsFixtureProps) {
  const text = SCREEN[locale][state];
  const note = NOTE[locale];
  const action = ACTION[locale];
  // Row states are the only stored data. Labels and readable details are derived
  // on every render, so a locale or state change never leaves stale text.
  const [rowStates, setRowStates] = useState<readonly ConnectionsRowState[]>(
    () => INITIAL_STATES[state],
  );
  const [observedAt, setObservedAt] = useState<boolean>(false);
  const shown = providedRows ?? rowsFromStates(locale, rowStates, observedAt);

  // Check sample sets only two independent facts: the sample server answer and the
  // historical client-call observation. It never authenticates or touches session,
  // grant, provider, Google transport or an active run.
  const runCheck = () => {
    setRowStates((previous) => previous.map((rowState, index) =>
      index === 0 || index === 5 ? "ready" : rowState));
    setObservedAt(true);
    onSample?.();
  };
  const signInMissing = rowStates[1] !== "ready";
  const runSignIn = () => {
    setRowStates((previous) => previous.map((rowState, index) =>
      index === 1 ? "ready" : rowState));
    onRecover?.();
  };
  const clearObservation = () => {
    setObservedAt(false);
    setRowStates((previous) => previous.map((rowState, index) =>
      index === 5 ? "unknown" : rowState));
  };
  return (
    <section className="connections-fixture" aria-label={ROW_LABEL[locale].observation}>
      <h2 className="connections-fixture__title">{text.title}</h2>
      <Status tone={state === "error" ? "error" : "neutral"}>{text.detail}</Status>
      <p className="connections-fixture__note">{note.independent}</p>
      <ul className="connections-fixture__rows">
        {shown.map((row) => (
          <li className="connections-fixture__row" key={row.id}>
            <span className="connections-fixture__label">{ROW_LABEL[locale][row.id]}</span>
            <span className="connections-fixture__detail">{row.detail}</span>
            {row.state === "ready" ? <span className="connections-fixture__sample">{note.sample}</span> : null}
          </li>
        ))}
      </ul>
      {providedRows === undefined && <div className="connections-fixture__actions">
        <Button
          variant="primary"
          loading={state === "loading"}
          disabled={state === "loading"}
          onClick={runCheck}
        >
          {action.check}
        </Button>
        <Button variant="tonal" disabled={signInMissing === false} onClick={runSignIn}>
          {action.signIn}
        </Button>
        <Button variant="text" disabled={observedAt === false} onClick={clearObservation}>
          {action.clear}
        </Button>
      </div>}
      <details className="connections-fixture__diagnostic">
        <summary className="connections-fixture__diagnostic-label">{note.diagnostic}</summary>
        <span className="connections-fixture__diagnostic-value">
          {diagnostic ?? SAMPLE_DIAGNOSTIC_TRACE}
        </span>
      </details>
    </section>
  );
}
