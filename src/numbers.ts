// Shared source-number verification for distillation, Wiki and real eval callers.
const DIGIT_RUN_RE = /[0-9]+/g;
const NUMERIC_TOKEN_RE = /[0-9]+(?:[.,][0-9]+)*(?:[eE][+\-\u2212]?[0-9]+)?/g;
const COMPOUND_POWER_RE = /(?<![\p{L}\p{N}.,_+\-\u2212])(?<mantissa>[+\-\u2212]?(?:[0-9]+(?:[.,][0-9]+)*|\.[0-9]+))[ \t\u00a0\u2009]*(?:[×·*]|times)[ \t\u00a0\u2009]*10(?<power>\^[ \t\u00a0\u2009]*[+\-\u2212]?[0-9]+|[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?![\p{L}\p{N}])/giu;
const SINGLE_NUMBER_RE = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function quoteRuns(text: string): Set<string> {
  return new Set(text.match(DIGIT_RUN_RE) ?? []);
}

function decimalTokens(text: string): Set<string> {
  return new Set((text.match(NUMERIC_TOKEN_RE) ?? []).filter((token) => {
    const parts = token.split(/[eE]/);
    // A scientific token keeps its literal sign/exponent identity even with
    // an integer mantissa: 1e8 is not supported by 1e-8.
    if (parts.length > 1) return true;
    const mantissa = parts[0] ?? "";
    // A single comma can be a decimal separator; an ordinary thousands group stays ambiguous.
    return mantissa.includes(".") || (/^\d+,\d+$/.test(mantissa) && !/^[1-9]\d{0,2},\d{3}$/.test(mantissa));
  }).map((token) => token.replace(",", ".").replace("\u2212", "-").toLowerCase()));
}

const SUPER_DIGITS: Readonly<Record<string, string>> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};

interface CompoundPowerToken { readonly value: string; readonly start: number; readonly end: number }

function compoundPowerTokens(text: string): CompoundPowerToken[] {
  const tokens: CompoundPowerToken[] = [];
  for (const match of text.matchAll(COMPOUND_POWER_RE)) {
    const groups = match.groups;
    if (!groups) continue;
    let mantissa = (groups.mantissa ?? "").replace("\u2212", "-");
    const sign = /^[+-]/.exec(mantissa)?.[0] ?? "";
    let magnitude = mantissa.slice(sign.length);
    if (!magnitude.includes(".") && /^\d+,\d+$/.test(magnitude)
      && !/^[1-9]\d{0,2},\d{3}$/.test(magnitude)) {
      magnitude = magnitude.replace(",", ".");
    }
    mantissa = sign + magnitude;

    const rawPower = groups.power ?? "";
    const powerText = rawPower.startsWith("^")
      ? rawPower.slice(1).replace(/[ \t\u00a0\u2009]/g, "").replace("\u2212", "-")
      : [...rawPower].map((character) => character === "⁻" ? "-" : character === "⁺" ? "+" : SUPER_DIGITS[character] ?? character).join("");
    const powerSign = powerText.startsWith("-") ? "-" : "";
    const powerDigits = powerText.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
    const power = powerSign + (powerDigits || "0");
    const start = match.index ?? 0;
    tokens.push({ value: `${mantissa}×10^${power}`, start, end: start + match[0].length });
  }
  return tokens;
}

function withoutCompoundPowers(text: string, tokens: readonly CompoundPowerToken[]): string {
  if (tokens.length === 0) return text;
  const parts: string[] = [];
  let offset = 0;
  for (const token of tokens) {
    parts.push(text.slice(offset, token.start), " ");
    offset = token.end;
  }
  parts.push(text.slice(offset));
  return parts.join("");
}

/**
 * Shared maximal-digit-group rule: every digit run in text must occur as a
 * whole maximal digit run in quote. Decimal fractions additionally require
 * a complete token, including its exponent: 41.8/41,8 is not supported by
 * 41.0 plus a lone 8, and 1e8 is not supported by 1e-8. Only unambiguous
 * decimal-comma notation is folded; e/E case and U+2212 minus are
 * normalized, other signs stay literal. Integer/thousands digit rules and
 * source names remain unchanged.
 */
export function unsupportedNumbers(text: string, quote: string): string[] {
  if (typeof text !== "string" || typeof quote !== "string") return ["invalid-number-input"];
  const requestedPowers = compoundPowerTokens(text);
  const supportedPowers = new Set(compoundPowerTokens(quote).map((token) => token.value));
  const powers = requestedPowers.filter((token) => !supportedPowers.has(token.value)).map((token) => token.value);
  if (powers.length > 0) return [...new Set(powers)];

  // Compound tokens are checked as a unit so their mantissa/exponent digits
  // cannot be satisfied by unrelated occurrences elsewhere in the quote.
  const remainingText = withoutCompoundPowers(text, requestedPowers);
  const remainingQuote = withoutCompoundPowers(quote, compoundPowerTokens(quote));
  const groups = remainingText.match(DIGIT_RUN_RE) ?? [];
  const supported = quoteRuns(remainingQuote);
  const missingGroups = groups.filter((group) => !supported.has(group));
  if (missingGroups.length > 0) return [...new Set(missingGroups)];
  const decimals = decimalTokens(remainingQuote);
  return [...decimalTokens(remainingText)].filter((token) => !decimals.has(token));
}

export function numbersSupported(text: string, quote: string): boolean {
  return unsupportedNumbers(text, quote).length === 0;
}


export function parseSingleNumber(valueText: string): number | null {
  let cleaned = valueText.trim();
  if (cleaned.endsWith("%")) cleaned = cleaned.slice(0, -1);
  if (!SINGLE_NUMBER_RE.test(cleaned)) return null;
  const parsed = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
