import { useState } from "react";
import { ReportMarkdown, StatementChecks, type AnswerCitations } from "./ReportAnswer";

// The live C4 answer shape: three claim paragraphs, then a list that states no audited claim, then the method record.
const body = [
  "The original Transformer adds positional encodings to the input embeddings because the model has no recurrence.",
  "It uses sine and cosine functions of different frequencies; learned embeddings gave nearly identical results.",
  "BERT sums token, segment and position embeddings for each token.",
  "- a list item without a claim\n- another item",
  "## Coverage and method",
  "Evidence uses 5 sources; 2 sources are cited.\nCoverage is sampled; corpus completeness is not established.",
].join("\n\n");
const claims: readonly { readonly text: string; readonly quotes: readonly number[] }[] = [
  { text: "The original Transformer adds positional encodings to the input embeddings because the model has no recurrence.", quotes: [2] },
  { text: "It uses sine and cosine functions of different frequencies; learned embeddings gave nearly identical results.", quotes: [2, 3] },
  { text: "BERT sums token, segment and position embeddings for each token.", quotes: [1] },
];

function Preview({ locale = "en" }: { readonly locale?: "en" | "ru" }) {
  const [opened, setOpened] = useState<number>();
  const cite: AnswerCitations = {
    numbersFor: paragraph => claims.filter(claim => paragraph.includes(claim.text)).flatMap(claim => claim.quotes)
      .filter((number, index, all) => all.indexOf(number) === index).sort((left, right) => left - right),
    label: number => locale === "ru" ? `Цитата ${number}` : `Quote ${number}`,
    open: setOpened,
  };
  return <article className="er-live-report-body">
    <StatementChecks locale={locale} labels={{ a: "SOURCE_SUPPORTED", b: "SOURCE_SUPPORTED", c: "SOURCE_SUPPORTED" }} />
    <ReportMarkdown body={body} method={locale === "ru" ? "Как проводилось исследование" : "How it was researched"} locale={locale} cite={cite} />
    <p data-opened>{opened === undefined ? "No quote opened" : `Opened quote ${opened}`}</p>
  </article>;
}

interface Play {
  readonly canvasElement: HTMLElement;
  readonly canvas: { findByRole(role: string, options: { readonly name: string; readonly exact?: boolean }): Promise<HTMLElement> };
  readonly userEvent: { click(element: HTMLElement): Promise<void> };
}
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };

export default { title: "Workspace/Report answer", component: Preview, parameters: { layout: "padded" } };
export const InlineQuoteNumbers = {
  args: { locale: "en" },
  play: async ({ canvasElement, canvas, userEvent }: Play) => {
    const cited = [...canvasElement.querySelectorAll<HTMLElement>(".er-live-report-cited")];
    assert(cited.length === 3, "Every claim paragraph carries its quote numbers");
    assert(cited.map(row => [...row.querySelectorAll("button")].map(button => button.textContent).join(",")).join("|") === "2|2,3|1",
      "Quote numbers follow each claim's own supporting quotes");
    const list = canvasElement.querySelector(".er-safe-markdown ul");
    assert(list && list.querySelectorAll("li").length === 2 && !list.closest(".er-live-report-cited"), "A paragraph without a claim stays plain markdown");
    assert(!canvasElement.querySelector("details.er-live-report-method")?.hasAttribute("open"), "The method record stays folded");
    await userEvent.click(await canvas.findByRole("button", { name: "Quote 3", exact: true }));
    assert(canvasElement.querySelector("[data-opened]")?.textContent === "Opened quote 3", "A quote number opens that quote");
    assert(canvasElement.querySelector(".er-live-report-checks")?.textContent === "All 3 statements are supported by sources",
      "Statement checks read as one plain line");
  },
};
export const InlineQuoteNumbersRussian = { args: { locale: "ru" } };
