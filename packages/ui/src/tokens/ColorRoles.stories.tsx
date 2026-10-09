import type { Meta, StoryObj } from "@storybook/react-vite";

import catalog from "./catalog.json";

type Role = { pair: string; light: Record<string, string>; dark: Record<string, string> };
const roles = catalog.consumed_roles as Role[];

const swatchClass = "eliot-token-swatch";
const rowClass = "eliot-token-row";
const labelClass = "eliot-token-label";
const sampleClass = "eliot-token-sample";

const meta: Meta = {
  title: "Tokens/ColorRoles",
  parameters: {
    layout: "padded",
  },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const LightAndDark: Story = {
  name: "Light / Dark / forced-colors",
  render: () => (
    <div className="eliot-token-story">
      {roles.map((role) => (
        <div className={rowClass} key={role.pair}>
          <span className={labelClass}>{role.pair}</span>
          <span className={swatchClass} data-role={role.pair} data-theme="light">Light · Светлая</span>
          <span className={swatchClass} data-role={role.pair} data-theme="dark">Dark · Тёмная</span>
        </div>
      ))}
      <ul className={sampleClass}>
        <li>Ответ с цитатой: источники, охват и состояние остаются раздельными.</li>
        <li lang="en">Answer with a citation: scope, coverage and status stay distinct.</li>
      </ul>
    </div>
  ),
};
export const SemanticPairings: Story = {
  name: "Semantic pairings",
  render: () => (
    <div className="eliot-token-story">
      {roles.map((role) => (
        <div className={rowClass} key={role.pair}>
          <span className={labelClass}>{role.pair}</span>
          <span className={swatchClass} data-role={role.pair}>Текст и фон · Text and surface</span>
        </div>
      ))}
      <div className="eliot-token-pairings">
        <p className={swatchClass} data-role="surface/on-surface">
          Отчёт: центральная область чтения.
        </p>
        <p className={swatchClass} data-role="surface-container/on-surface-variant">
          Область: 3 источника · охват выборочный.
        </p>
        <p className={swatchClass} data-role="surface-container-high/on-surface">
          Доказательство: выделенный фрагмент источника.
        </p>
      </div>
    </div>
  ),
};

export const EnglishSample: Story = {
  name: "Long English sample",
  render: () => (
    <div className="eliot-token-story">
      <p className="eliot-token-reader">
        Every claim keeps its citation, its scope snapshot and its evidence state separate. The reading
        surface uses the surface and on-surface roles; scope and counts use the recessive container pair;
        the contextual evidence panel appears only while a citation is selected, and it is dismissed
        again by the reader.
      </p>
      <p className="eliot-token-reader" lang="en">
        Status is never carried by colour alone: it is stated in words, with an icon and a text label.
      </p>
    </div>
  ),
};

export const LongRussian: Story = {
  render: () => (
    <article className="eliot-token-story" lang="ru">
      <h1>Источники, исследование и точное доказательство</h1>
      <p className="eliot-token-reader">Каждый вывод сохраняет связь с цитатой и областью исследования. Готовность источника к поиску, принятие документа и завершение вычисления отображаются раздельно. Если состояние неизвестно, интерфейс сообщает об этом прямо и предлагает доступный способ восстановления.</p>
      <p className="eliot-token-reader">Проверка кириллицы: Ёё Йй Ъъ Ыы Ьь Ээ Юю Яя. Числа: 0123456789. Знаки: № § ± →. Изменение выбора источников не переписывает сохранённую область выполненного исследования.</p>
    </article>
  ),
};
