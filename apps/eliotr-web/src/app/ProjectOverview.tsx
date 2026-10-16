import { Button } from "@eliotr/ui";

/** Prompts are drafts: opening a project never starts or repeats a paid run. */
export function ProjectOverview({ locale, onSuggest }: {
  readonly locale: "en" | "ru"; readonly onSuggest: (question: string) => void;
}) {
  const ru = locale === "ru";
  const suggestions = ru ? [
    ["Обзор источников", "О чём эти источники? Кратко опиши основные темы и выводы, ссылаясь на использованные документы."],
    ["Сходства и различия", "В чём эти источники согласны, а где их выводы или подходы расходятся? Подкрепи сравнение цитатами."],
    ["Ограничения", "Какие ограничения и нерешённые вопросы авторы прямо признают в этих источниках?"],
  ] : [
    ["Source overview", "What are these sources about? Summarize their main topics and findings, citing the documents you use."],
    ["Compare the sources", "Where do these sources agree, and where do their findings or approaches differ? Support the comparison with citations."],
    ["Explore limitations", "What limitations and unresolved questions do the authors explicitly acknowledge in these sources?"],
  ];
  return <section aria-label={ru ? "Предлагаемые вопросы" : "Suggested questions"}>
    <h3>{ru ? "Что исследовать дальше" : "Explore your sources"}</h3>
    <div className="er-live-actions">{suggestions.map(([label, question]) => <Button key={label}
      variant="text" onClick={() => { if (question) onSuggest(question); }}>{label}</Button>)}</div>
  </section>;
}
