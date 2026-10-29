// Shared source-number verification for distillation, Wiki and real eval callers.
const DIGIT_RUN_RE = /[0-9]+/g;
const NUMERIC_TOKEN_RE = /[0-9]+(?:[.,][0-9]+)*(?:[eE][+\-\u2212]?[0-9]+)?/g;
const PERCENT_NUMBER_RE = /(?<![\p{N}.,+^\-\u2212])[+\-\u2212]?(?:[0-9]+(?:[.,][0-9]+)*|\.[0-9]+)(?:[eE][+\-\u2212]?[0-9]+)?/gu;
const PERCENT_UNIT_RE = /^(?:\s|~|\\[,;:! ])*\\?%(?![\p{N}_%])/u;
const UNSUPPORTED_PERCENT_FORMAT = "unsupported-percentage-format";
const COMPOUND_POWER_RE = /(?<![\p{L}\p{N}.,_+\-\u2212])(?<mantissa>[+\-\u2212]?(?:[0-9]+(?:[.,][0-9]+)*|\.[0-9]+))[ \t\u00a0\u2009]*(?:[×·*]|times)[ \t\u00a0\u2009]*10(?<power>\^[ \t\u00a0\u2009]*[+\-\u2212]?[0-9]+|[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?![\p{L}\p{N}])/giu;
const SINGLE_NUMBER_RE = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// Bare 10^N / 10-superscript without a mantissa x (for example 10^-8):
// one unambiguous scientific quantity, not two numbers. Shares the
// same power suffix logic as compound powers; no paper pattern is added.
const BARE_POWER_RE = /(?<![\p{L}\p{N}.,_+\-\u2212])10(?<power>\^[ \t\u00a0\u2009]*[+\-\u2212]?[0-9]+|[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?![\p{L}\p{N}])/giu;
const SIGNED_BARE_POWER_RE = /(?<![\p{L}\p{N}.,_+\-\u2212])[+\-\u2212]10(?<power>\^[ \t\u00a0\u2009]*[+\-\u2212]?[0-9]+|[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?![\p{L}\p{N}])/giu;

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
interface PercentageToken { readonly value: string; readonly percentIndex: number }
interface OpaquePercentLexeme { readonly value: string; readonly boundariesProven: boolean }

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

function barePowerTokens(text: string, pattern: RegExp = BARE_POWER_RE): CompoundPowerToken[] {
  const tokens: CompoundPowerToken[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    tokens.push({ value: match[0], start, end: start + match[0].length });
  }
  return tokens;
}

function signedBarePowerTokens(text: string): CompoundPowerToken[] {
  return barePowerTokens(text, SIGNED_BARE_POWER_RE);
}

function structuralPowerTokens(text: string): CompoundPowerToken[] {
  const tokens: CompoundPowerToken[] = [];
  for (const candidate of [
    ...compoundPowerTokens(text),
    ...signedBarePowerTokens(text),
    ...barePowerTokens(text),
  ]) {
    if (tokens.some((token) => candidate.start < token.end && token.start < candidate.end)) continue;
    tokens.push(candidate);
  }
  return tokens.sort((left, right) => left.start - right.start);
}

function normalizePercentMagnitude(magnitude: string): string {
  const leadingZero = magnitude.startsWith(".") ? "0" + magnitude : magnitude;
  const normalized = [...decimalTokens(leadingZero)][0] ?? leadingZero;
  if (/[eE]/u.test(normalized) || !/^\d+\.\d+$/u.test(normalized)) return normalized;
  return normalized.replace(/0+$/u, "").replace(/\.$/u, "");
}

function percentageTokens(text: string): PercentageToken[] {
  const tokens: PercentageToken[] = [];
  const powerTokens = structuralPowerTokens(text);
  for (const token of powerTokens) {
    const unit = PERCENT_UNIT_RE.exec(text.slice(token.end));
    if (unit) {
      tokens.push({
        value: token.value.replace(/\u2212/gu, "-") + "%",
        percentIndex: token.end + unit[0].indexOf("%"),
      });
    }
  }
  for (const match of text.matchAll(PERCENT_NUMBER_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (powerTokens.some((token) => start < token.end && token.start < end)) continue;
    const unit = PERCENT_UNIT_RE.exec(text.slice(end));
    if (!unit) continue;
    const number = match[0].replace("\u2212", "-");
    const sign = /^[+-]/.exec(number)?.[0] ?? "";
    const magnitude = number.slice(sign.length);
    const normalized = normalizePercentMagnitude(magnitude);
    tokens.push({ value: sign + normalized + "%", percentIndex: end + unit[0].indexOf("%") });
  }
  return tokens;
}

function percentPrefixWithoutFormatting(prefix: string): string {
  if (prefix.endsWith("\\")) prefix = prefix.slice(0, -1);
  return prefix.replace(/(?:\s|~|\\[,;:! ])+$/u, "");
}

function inlineCodeContentAt(text: string, percentIndex: number): { start: number; end: number } | null {
  let openingStart = -1;
  let openingLength = 0;
  for (let cursor = 0; cursor < text.length;) {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let runEnd = cursor + 1;
    while (runEnd < text.length && text[runEnd] === "`") runEnd += 1;
    const runLength = runEnd - cursor;
    if (openingStart < 0) {
      openingStart = cursor;
      openingLength = runLength;
    } else if (runLength === openingLength) {
      if (openingStart + openingLength <= percentIndex && percentIndex < cursor) {
        return { start: openingStart + openingLength, end: cursor };
      }
      openingStart = -1;
      openingLength = 0;
    }
    cursor = runEnd;
  }
  return null;
}

function isOpenDelimiter(char: string): boolean {
  return char === "(" || char === "[" || char === "{";
}

function isMatchingDelimiter(open: string, close: string): boolean {
  return (open === "(" && close === ")") || (open === "[" && close === "]") || (open === "{" && close === "}");
}

function opaqueNumericPercentAt(text: string, percentIndex: number): OpaquePercentLexeme | null {
  const code = inlineCodeContentAt(text, percentIndex);
  if (code) {
    const prefix = percentPrefixWithoutFormatting(text.slice(code.start, percentIndex));
    if (!/\p{N}/u.test(prefix)) return null;
    return { value: text.slice(code.start, code.end), boundariesProven: true };
  }

  const prefixEnd = percentPrefixWithoutFormatting(text.slice(0, percentIndex)).length;
  const stack: string[] = [];
  let start = 0;
  for (let cursor = 0; cursor < prefixEnd; cursor += 1) {
    const char = text[cursor] ?? "";
    if (isOpenDelimiter(char)) stack.push(char);
    else if (char === ")" || char === "]" || char === "}") {
      const opening = stack[stack.length - 1];
      if (opening === undefined || !isMatchingDelimiter(opening, char)) {
        const prefix = percentPrefixWithoutFormatting(text.slice(start, prefixEnd));
        return /\p{N}/u.test(prefix) ? { value: "", boundariesProven: false } : null;
      }
      stack.pop();
    } else if (/\s/u.test(char) && stack.length === 0) start = cursor + 1;
  }

  const numericPrefix = percentPrefixWithoutFormatting(text.slice(start, prefixEnd));
  if (!/\p{N}/u.test(numericPrefix)) return null;
  let end = percentIndex + 1;
  let boundariesProven = true;
  const forwardStack = [...stack];
  let stoppedAtBoundary = false;
  for (let cursor = percentIndex + 1; cursor < text.length; cursor += 1) {
    const char = text[cursor] ?? "";
    if (isOpenDelimiter(char)) forwardStack.push(char);
    else if (char === ")" || char === "]" || char === "}") {
      const opening = forwardStack[forwardStack.length - 1];
      if (opening === undefined || !isMatchingDelimiter(opening, char)) {
        boundariesProven = false;
        break;
      }
      forwardStack.pop();
    } else if (/\s/u.test(char) && forwardStack.length === 0) {
      stoppedAtBoundary = true;
      break;
    }
    end = cursor + 1;
  }
  if (!stoppedAtBoundary && forwardStack.length > 0) boundariesProven = false;

  let lexemeStart = start;
  let beforeStart = lexemeStart - 1;
  while (beforeStart >= 0 && /\s/u.test(text[beforeStart] ?? "")) beforeStart -= 1;
  const sign = text[beforeStart] ?? "";
  if (sign === "+" || sign === "-" || sign === "\u2212") {
    const lineStart = Math.max(text.lastIndexOf("\n", beforeStart - 1), text.lastIndexOf("\r", beforeStart - 1)) + 1;
    const markdownBullet = (sign === "+" || sign === "-")
      && /^[ \t]*$/u.test(text.slice(lineStart, beforeStart))
      && /\s/u.test(text[beforeStart + 1] ?? "");
    if (!markdownBullet) lexemeStart = beforeStart;
  }

  const raw = text.slice(lexemeStart, end);
  if (raw.includes("`")) boundariesProven = false;
  return { value: raw.replace(/[.,;:!?]+$/u, ""), boundariesProven };
}

function numericPercentLexemes(text: string, accountedPercentIndexes: ReadonlySet<number> = new Set()): OpaquePercentLexeme[] {
  const lexemes: OpaquePercentLexeme[] = [];
  for (const match of text.matchAll(/%/gu)) {
    const percentIndex = match.index ?? 0;
    if (accountedPercentIndexes.has(percentIndex)) continue;
    const lexeme = opaqueNumericPercentAt(text, percentIndex);
    if (lexeme) lexemes.push(lexeme);
  }
  return lexemes;
}

/**
 * Shared maximal-digit-group rule: every digit run in text must occur as a
 * whole maximal digit run in quote. Decimal fractions additionally require
 * a complete token, including its exponent: 41.8/41,8 is not supported by
 * 41.0 plus a lone 8, and 1e8 is not supported by 1e-8. Only unambiguous
 * decimal-comma notation is folded; e/E case and U+2212 minus are
 * normalized, other signs stay literal. Percentages additionally require
 * the whole signed quantity and percent unit, including escaped LaTeX units.
 * Integer/thousands digit rules and source names remain unchanged.
 */
export function unsupportedNumbers(text: string, quote: string): string[] {
  if (typeof text !== "string" || typeof quote !== "string") return ["invalid-number-input"];
  if (text.includes("%")) {
    const requestedPercentages = percentageTokens(text);
    const supportedPercentages = new Set(percentageTokens(quote).map((token) => token.value));
    const accountedPercentIndexes = new Set(requestedPercentages.map((token) => token.percentIndex));
    // An unparsed numeric percent lexeme must not fall through to digit-only support.
    const unparsedPercentLexemes = numericPercentLexemes(text, accountedPercentIndexes);
    const quotedPercentLexemes = new Set(numericPercentLexemes(quote)
      .filter((token) => token.boundariesProven)
      .map((token) => token.value));
    if (unparsedPercentLexemes.some((token) => !token.boundariesProven || !quotedPercentLexemes.has(token.value))) {
      return [UNSUPPORTED_PERCENT_FORMAT];
    }
    const percentages = requestedPercentages.map((token) => token.value).filter((token) => !supportedPercentages.has(token));
    if (percentages.length > 0) return percentages;
  }
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

/**
 * Count distinct numeric quantities in a stored valueText for the K3
 * one-scalar-per-result contract. Compound powers (for example 4.9x10^-5)
 * and bare 10^N / 10-superscript (for example 10^-8) each
 * count as one quantity via the shared power suffix logic; remaining
 * numeric tokens use the shared numeric tokenizer. A compound list such as
 * +27.1% / 8.3% counts as two and must be rejected by the caller. Zero
 * counts (non-numeric literals) are left to the caller; this helper only
 * identifies compounds (>1). No paper-specific patterns are added.
 */
export function countNumericQuantities(valueText: string): number {
  if (typeof valueText !== "string") return 0;
  const powers = compoundPowerTokens(valueText);
  const afterCompound = withoutCompoundPowers(valueText, powers);
  const bare = barePowerTokens(afterCompound);
  const remaining = withoutCompoundPowers(afterCompound, bare);
  const tokens = remaining.match(NUMERIC_TOKEN_RE) ?? [];
  return powers.length + bare.length + tokens.length;
}


export function parseSingleNumber(valueText: string): number | null {
  let cleaned = valueText.trim();
  if (cleaned.endsWith("%")) cleaned = cleaned.slice(0, -1);
  if (!SINGLE_NUMBER_RE.test(cleaned)) return null;
  const parsed = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
