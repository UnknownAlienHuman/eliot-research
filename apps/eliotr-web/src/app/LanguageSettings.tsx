import { useId } from "react";

export function LanguageSettings({ locale, onChange }: {
  readonly locale: "en" | "ru"; readonly onChange: (locale: "en" | "ru") => void;
}) {
  const id = useId();
  return <section className="er-live-callout" aria-labelledby={id}>
    <h2 id={id}>{locale === "ru" ? "Язык интерфейса" : "Interface language"}</h2>
    <label htmlFor={`${id}-language`}>{locale === "ru" ? "Язык" : "Language"}</label>
    <select id={`${id}-language`} value={locale} onChange={event => {
      if (event.target.value === "en" || event.target.value === "ru") onChange(event.target.value);
    }}>
      <option value="en" lang="en">English</option>
      <option value="ru" lang="ru">Русский</option>
    </select>
    <p>{locale === "ru" ? "Выбор сохраняется в этом браузере. Язык ответов следует языку вопроса."
      : "Your choice is saved in this browser. Answers follow the language of your question."}</p>
  </section>;
}
