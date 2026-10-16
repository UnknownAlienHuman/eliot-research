import type { TrustedModelPromptParameters } from "@eliotr/cloudflare-research";

export type ResearchSynthesisOutputLanguage = "en" | "ru";

/** Add the immutable v4 language choice to the trusted synthesis request. */
export function bindResearchSynthesisOutputLanguage(
  parameters: TrustedModelPromptParameters,
  language: ResearchSynthesisOutputLanguage | undefined,
): TrustedModelPromptParameters {
  if (language === undefined) return parameters;
  if (language !== "en" && language !== "ru") throw new TypeError("research output language is invalid");
  const instruction = language === "en"
    ? "OUTPUT LANGUAGE: English. Write the complete synthesized answer, including headings and methodology, in English. Preserve source quotations in their original language."
    : "OUTPUT LANGUAGE: Russian. Write the complete synthesized answer, including headings and methodology, in Russian. Preserve source quotations in their original language.";
  return Object.freeze({ ...parameters, prompt: `${parameters.prompt}\n\n${instruction}` });
}
