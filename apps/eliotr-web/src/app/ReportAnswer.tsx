import { MaterialSymbol, SafeMarkdown } from '@eliotr/ui';
import type { ArtifactRevisionRead } from '@eliotr/owner-api-client';
import './report-answer.css';

/**
 * The draft writer appends a "Coverage and method" part (scope, encountered and cited revisions, limits).
 * It is the record of how the answer was found, not the answer: it stays one tap away, folded.
 */
const METHOD_HEADING = /^#{1,3}[ \t]+(?:Coverage and method|Охват и метод)[ \t]*$/mu;

type StatementLabels = ArtifactRevisionRead['sections'][number]['statement_labels'];

/** One plain line about the saved statement checks: "All 3 statements are supported by sources". */
export function StatementChecks({ labels, locale }: { readonly labels: StatementLabels; readonly locale: 'en' | 'ru' }) {
  const names = locale === 'ru' ? {
    SOURCE_SUPPORTED: 'подтверждены источниками', DERIVED_INFERENCE: 'выводы из источников',
    HYPOTHESIS: 'гипотезы', CONTESTED: 'оспариваются', UNRESOLVED: 'не удалось проверить',
    EDITORIAL_RECOMMENDATION: 'рекомендации', REDACTED_DEPENDENCY: 'зависят от недоступных данных',
  } : {
    SOURCE_SUPPORTED: 'supported by sources', DERIVED_INFERENCE: 'inferences from sources',
    HYPOTHESIS: 'hypotheses', CONTESTED: 'contested', UNRESOLVED: 'could not be checked',
    EDITORIAL_RECOMMENDATION: 'recommendations', REDACTED_DEPENDENCY: 'depend on unavailable evidence',
  };
  const values = Object.values(labels);
  if (values.length === 0) return null;
  const supported = values.filter(value => value === 'SOURCE_SUPPORTED').length;
  const text = supported === values.length
    ? locale === 'ru' ? `Все утверждения (${values.length}) подтверждены источниками` : `All ${values.length} statements are supported by sources`
    : (Object.keys(names) as (keyof typeof names)[]).flatMap(label => {
      const count = values.filter(value => value === label).length;
      return count === 0 ? [] : [`${names[label]}: ${count}`];
    }).join(' · ');
  return <p className="er-live-report-checks" role="note" data-all-supported={supported === values.length ? 'true' : 'false'}>
    <MaterialSymbol name={supported === values.length ? 'fact-check' : 'info'} /><span>{text}</span>
  </p>;
}

/** Inline quote numbers for answer paragraphs, NotebookLM-style; the numbers match the quotes list beside the answer. */
export interface AnswerCitations {
  readonly numbersFor: (paragraph: string) => readonly number[];
  readonly label: (number: number) => string;
  readonly open: (number: number) => void;
}

function CitedAnswer({ answer, cite }: { readonly answer: string; readonly cite: AnswerCitations }) {
  // Paragraphs that state an audited claim carry its quote numbers; the rest stay one markdown block,
  // so lists and code keep their structure.
  const parts: { readonly text: string; readonly numbers: readonly number[] }[] = [];
  let plain: string[] = [];
  const flush = () => { if (plain.length > 0) { parts.push({ text: plain.join('\n\n'), numbers: [] }); plain = []; } };
  for (const paragraph of answer.split(/\n{2,}/u)) {
    const numbers = cite.numbersFor(paragraph);
    if (numbers.length === 0) { plain.push(paragraph); continue; }
    flush(); parts.push({ text: paragraph, numbers });
  }
  flush();
  return <>{parts.map((part, index) => part.numbers.length === 0 ? <SafeMarkdown key={index} text={part.text} />
    : <div key={index} className="er-live-report-cited">
      <SafeMarkdown text={part.text} />
      <span className="er-live-report-cite-marks">{part.numbers.map(number =>
        <button key={number} type="button" className="er-live-report-cite-mark" aria-label={cite.label(number)}
          title={cite.label(number)} onClick={() => cite.open(number)}>{number}</button>)}</span>
    </div>)}</>;
}

export function ReportMarkdown({ body, method, locale, cite }: {
  readonly body: string; readonly method: string; readonly locale: 'en' | 'ru'; readonly cite?: AnswerCitations | undefined;
}) {
  const match = METHOD_HEADING.exec(body);
  const answer = match === null ? body : body.slice(0, match.index).trimEnd();
  const record = match === null ? '' : body.slice(match.index + match[0].length).trim();
  const counts = /Evidence uses (\d+) sources; (\d+) sources are cited\./u.exec(record)
    ?? /В доказательствах использовано источников: (\d+); процитировано: (\d+)\./u.exec(record);
  const sampled = /Coverage is sampled|Охват выборочный/u.test(record);
  const localizedRecord = counts === null ? record : locale === 'ru'
    ? `В доказательствах использовано источников: ${counts[1]}; процитировано: ${counts[2]}.\n\n${sampled ? 'Охват выборочный; полнота корпуса не установлена.' : 'Область исследования зафиксирована.'} Метод и ограничения сохранены в квитанции охвата.`
    : `Evidence uses ${counts[1]} sources; ${counts[2]} sources are cited.\n\n${sampled ? 'Coverage is sampled; corpus completeness is not established.' : 'The research scope is fixed.'} The coverage receipt retains the method and limitations.`;
  return <>
    {answer ? cite ? <CitedAnswer answer={answer} cite={cite} /> : <SafeMarkdown text={answer} /> : null}
    {record ? <details className="er-live-report-method"><summary>{method}</summary><SafeMarkdown text={localizedRecord} /></details> : null}
  </>;
}
