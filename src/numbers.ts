// Shared source-number verification for distillation, Wiki and real eval callers.
const NUMERIC_TOKEN_RE = /[0-9]+(?:[.,][0-9]+)*(?:[eE][+\-\u2212]?[0-9]+)?/g;
const NUMERIC_LITERAL_RE = /(?:[+\-\u2212][ \t\u00a0\u2009]*)?(?:[0-9]+(?:[.,][0-9]+)*|\.[0-9]+)(?:[eE][+\-\u2212]?[0-9]+)?/g;
const COMPOUND_POWER_RE = /(?<![\p{L}\p{N}.,_+\-\u2212])(?<mantissa>[+\-\u2212]?(?:[0-9]+(?:[.,][0-9]+)*|\.[0-9]+))[ \t\u00a0\u2009]*(?:[×·*]|times|\\(?:times|cdot))[ \t\u00a0\u2009]*10(?<power>\^[ \t\u00a0\u2009]*(?:\{[ \t\u00a0\u2009]*[+\-\u2212]?[0-9]+[ \t\u00a0\u2009]*\}|[+\-\u2212]?[0-9]+)|[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?![\p{L}\p{N}])/giu;
const SINGLE_NUMBER_RE = /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// Bare 10^N / 10^{N} / 10-superscript without a mantissa x (for example 10^-8):
// one unambiguous scientific quantity, not two numbers. Shares the
// same power suffix logic as compound powers; no paper pattern is added.
const BARE_POWER_RE = /(?<![\p{L}\p{N}.,_+\-\u2212])(?<sign>[+\-\u2212]?)10(?<power>\^[ \t\u00a0\u2009]*(?:\{[ \t\u00a0\u2009]*[+\-\u2212]?[0-9]+[ \t\u00a0\u2009]*\}|[+\-\u2212]?[0-9]+)|[⁺⁻]?[⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?![\p{L}\p{N}])/giu;

function normalizeNumericLiteral(value: string): string {
  const [raw = "", exponent] = value.replace(/[ \t\u00a0\u2009]/g, "").replace(/\u2212/g, "-").toLowerCase().split("e");
  let mantissa = raw;
  if (/^[+-]?\d+,\d+$/.test(mantissa) && !/^[+-]?[1-9]\d{0,2},\d{3}$/.test(mantissa)) mantissa = mantissa.replace(",", ".");
  mantissa = mantissa.replace(/^([+-]?)\./, (_match, sign: string) => sign + "0.");
  if (/^[+-]?\d+\.\d+$/.test(mantissa)) mantissa = mantissa.replace(/0+$/, "").replace(/\.$/, "");
  return mantissa + (exponent === undefined ? "" : "e" + exponent);
}

const SUPER_DIGITS: Readonly<Record<string, string>> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};

interface CompoundPowerToken { readonly value: string; readonly start: number; readonly end: number }

function normalizePower(raw: string): string {
  const text = raw.startsWith("^")
    ? raw.slice(1).replace(/[ \t\u00a0\u2009]/g, "").replace("\u2212", "-").replace(/^\{([+-]?[0-9]+)\}$/u, "$1")
    : [...raw].map((char) => char === "⁻" ? "-" : char === "⁺" ? "+" : SUPER_DIGITS[char] ?? char).join("");
  const sign = text.startsWith("-") ? "-" : "";
  return sign + (text.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "") || "0");
}

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

    const start = match.index ?? 0;
    tokens.push({ value: `${mantissa}×10^${normalizePower(groups.power ?? "")}`, start, end: start + match[0].length });
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

function barePowerTokens(text: string): CompoundPowerToken[] {
  const tokens: CompoundPowerToken[] = [];
  for (const match of text.matchAll(BARE_POWER_RE)) {
    const start = match.index ?? 0;
    const sign = (match.groups?.sign ?? "").replace("\u2212", "-");
    tokens.push({ value: sign + "10^" + normalizePower(match.groups?.power ?? ""), start, end: start + match[0].length });
  }
  return tokens;
}

function withParenthesizedSign(text: string, token: CompoundPowerToken): string {
  const sign = /([+\-\u2212])\s*\(\s*$/u.exec(text.slice(0, token.start))?.[1];
  // Only a sign around one atom, optionally with its percent marker; no algebra.
  const closes = /^(?:\s|~|\\[,;:! ])*(?:\\?%(?:\s|~|\\[,;:! ])*)?\)/u.test(text.slice(token.end));
  return sign && closes && !/^[+-]/.test(token.value) ? sign.replace("\u2212", "-") + token.value : token.value;
}

function numericLiterals(text: string): Set<string> {
  const values = new Set<string>();
  let remaining = text;
  for (const tokenize of [compoundPowerTokens, barePowerTokens]) {
    const tokens = tokenize(remaining);
    for (const token of tokens) values.add(withParenthesizedSign(remaining, token));
    remaining = withoutCompoundPowers(remaining, tokens);
  }
  for (const match of remaining.matchAll(NUMERIC_LITERAL_RE)) {
    const start = match.index ?? 0;
    values.add(withParenthesizedSign(remaining, {
      value: normalizeNumericLiteral(match[0]), start, end: start + match[0].length,
    }));
  }
  return values;
}

/**
 * Require complete numeric literals, preserving signs and exponent identity.
 * Decimal commas and insignificant fractional zeros are formatting; ambiguous
 * comma grouping stays literal, and source spaces never join separate numbers.
 * Unit, row, metric and condition association remain own-quote semantic checks;
 * the absence of literal percent typography does not change numeric identity.
 */
export function unsupportedNumbers(text: string, quote: string): string[] {
  if (typeof text !== "string" || typeof quote !== "string") return ["invalid-number-input"];
  const supported = numericLiterals(quote);
  // Preserve accepted authored space-group spelling only when the quote
  // explicitly supplies that same written comma grouping; never join source tokens.
  const writtenText = text.replace(/(?<![\d.,])[+\-\u2212]?\d{1,3}(?:[ \u00a0\u2009]\d{3})+(?![\d.,])/g, (spaced, start: number) => {
    const grouped = spaced.replace(/[ \u00a0\u2009]/g, ",");
    const token = { value: normalizeNumericLiteral(grouped), start, end: start + spaced.length };
    return supported.has(withParenthesizedSign(text, token)) ? grouped : spaced;
  });
  return [...numericLiterals(writtenText)].filter((token) => !supported.has(token));
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
