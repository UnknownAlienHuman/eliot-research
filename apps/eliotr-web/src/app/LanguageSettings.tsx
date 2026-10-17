import { useId } from "react";
import "./settings.css";

export function LanguageSettings({ locale, onChange }: {
  readonly locale: "en" | "ru"; readonly onChange: (locale: "en" | "ru") => void;
}) {
  const id = useId();
  // One settings row: what it is and what it does on the left, the choice on the right.
  return <section className="er-settings-card er-settings-card--row" aria-labelledby={id}>
    <div className="er-settings-card__text">
      <h2 id={id}>{locale === "ru" ? "Язык интерфейса" : "Interface language"}</h2>
      <p>{locale === "ru" ? "Сохраняется в этом браузере. Новые отчёты пишутся на выбранном языке."
        : "Saved in this browser. New reports are written in the selected language."}</p>
    </div>
    <label className="er-settings-card__hidden-label" htmlFor={`${id}-language`}>{locale === "ru" ? "Язык" : "Language"}</label>
    <select id={`${id}-language`} className="er-field__control er-settings-card__select" value={locale} onChange={event => {
      if (event.target.value === "en" || event.target.value === "ru") onChange(event.target.value);
    }}>
      <option value="en" lang="en">English</option>
      <option value="ru" lang="ru">Русский</option>
    </select>
  </section>;
}
