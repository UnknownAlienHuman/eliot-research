// Bounded recognition of the nullable column CHECK predicates admitted by the guarded
// D1 migration operation. Root owns the surrounding ALTER TABLE parser, the NOT NULL and
// DEFAULT rules, and every other clause. This module answers one question about the
// already parenthesized CHECK expression and nothing else, so it deliberately re-parses
// the expression instead of re-tokenizing it.
//
// A true result authorizes D1 to validate every existing row against this CHECK while the
// ADD COLUMN is applied, which is a schema_constraint_validation effect with explicit cost.
// The guarded migration operation must supply an exact current row bound and admitted cost
// (ADR-0009 risk review plus count/byte/deadline bounds) before allowing this predicate to
// take effect. Recognition here grants no effect on its own.
//
// Admitted shapes, each about exactly one column:
//   <column> IS NULL OR <guard>
//   <column> IS NULL OR ( <guard> )
// where <guard> is exactly one of
//   LENGTH(<column>) = <nonnegative> AND <column> NOT GLOB '*[^0-9a-f]*'
//   <column> > <nonnegative>
//   JSON_VALID(<column>)
//   <column> = <single bounded literal>
//   LENGTH(<column>) BETWEEN <nonnegative> AND <nonnegative>
// Everything else is refused: another column, a subquery, an extra token, a different
// operator, a different function, a non-integer or negative bound, a reversed interval.

const HEX_GLOB_LITERAL = '*[^0-9a-f]*';
const MAX_LITERAL_LENGTH = 512;

function isWordToken(token, expected) {
  return token !== undefined && token !== null && token.type === "word" && token.value === expected;
}

function consumeWord(tokens, index, expected) {
  return isWordToken(tokens[index], expected) ? index + 1 : null;
}

function consumeSymbol(tokens, index, expected) {
  return tokens[index] !== undefined && tokens[index].type === "symbol" && tokens[index].value === expected
    ? index + 1
    : null;
}

function consumeColumn(tokens, index, name) {
  const token = tokens[index];
  if (token === undefined || token === null) return null;
  if (token.type !== "word" && token.type !== "identifier") return null;
  if (typeof token.value !== "string") return null;
  const raw = token.type === "word" ? token.raw : token.value;
  if (typeof raw !== "string" || raw.toLowerCase() !== name) return null;
  return index + 1;
}

function consumeColumnCall(tokens, index, functionName, name) {
  const afterFunction = consumeWord(tokens, index, functionName);
  if (afterFunction === null) return null;
  const afterOpen = consumeSymbol(tokens, afterFunction, "(");
  if (afterOpen === null) return null;
  const afterName = consumeColumn(tokens, afterOpen, name);
  if (afterName === null) return null;
  return consumeSymbol(tokens, afterName, ")");
}

// Digits arrive as individual single-character symbol tokens because the shared tokenizer
// has no numbers. The joined text must be a safe nonnegative integer.
function consumeNonnegativeInteger(tokens, index) {
  let cursor = index;
  let digits = "";
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token.type === "symbol" && /^[0-9]$/.test(token.value)) {
      digits += token.value;
      cursor += 1;
    } else {
      break;
    }
  }
  if (digits.length === 0 || !Number.isSafeInteger(Number(digits))) return null;
  return cursor;
}

function nonnegativeIntegerDigits(tokens, from, to) {
  let digits = "";
  for (let index = from; index < to; index += 1) digits += tokens[index].value;
  return digits;
}

function consumeBoundedLiteral(tokens, index) {
  const token = tokens[index];
  if (token === undefined || token === null) return null;
  if (token.type !== "literal") return null;
  if (token.value.length === 0 || token.value.length > MAX_LITERAL_LENGTH) return null;
  return index + 1;
}

function consumeHexLengthGuard(tokens, index, name) {
  const afterLength = consumeColumnCall(tokens, index, "LENGTH", name);
  if (afterLength === null) return null;
  const afterEquals = consumeSymbol(tokens, afterLength, "=");
  if (afterEquals === null) return null;
  const afterCount = consumeNonnegativeInteger(tokens, afterEquals);
  if (afterCount === null) return null;
  const afterAnd = consumeWord(tokens, afterCount, "AND");
  if (afterAnd === null) return null;
  const afterColumn = consumeColumn(tokens, afterAnd, name);
  if (afterColumn === null) return null;
  const afterNot = consumeWord(tokens, afterColumn, "NOT");
  if (afterNot === null) return null;
  const afterGlob = consumeWord(tokens, afterNot, "GLOB");
  if (afterGlob === null) return null;
  const pattern = tokens[afterGlob];
  if (pattern === undefined || pattern === null || pattern.type !== "literal") return null;
  if (pattern.value !== HEX_GLOB_LITERAL) return null;
  return afterGlob + 1;
}

function consumeGreaterThanGuard(tokens, index, name) {
  const afterColumn = consumeColumn(tokens, index, name);
  if (afterColumn === null) return null;
  const afterOperator = consumeSymbol(tokens, afterColumn, ">");
  if (afterOperator === null) return null;
  return consumeNonnegativeInteger(tokens, afterOperator);
}

function consumeSingleLiteralGuard(tokens, index, name) {
  const afterColumn = consumeColumn(tokens, index, name);
  if (afterColumn === null) return null;
  const afterOperator = consumeSymbol(tokens, afterColumn, "=");
  if (afterOperator === null) return null;
  return consumeBoundedLiteral(tokens, afterOperator);
}

function consumeBoundedLengthGuard(tokens, index, name) {
  const afterLength = consumeColumnCall(tokens, index, "LENGTH", name);
  if (afterLength === null) return null;
  const afterBetween = consumeWord(tokens, afterLength, "BETWEEN");
  if (afterBetween === null) return null;
  const afterLower = consumeNonnegativeInteger(tokens, afterBetween);
  if (afterLower === null) return null;
  const afterAnd = consumeWord(tokens, afterLower, "AND");
  if (afterAnd === null) return null;
  const afterUpper = consumeNonnegativeInteger(tokens, afterAnd);
  if (afterUpper === null) return null;
  // The lower bound occupies the inclusive range afterBetween..afterLower and the upper
  // bound the inclusive range afterAnd..afterUpper. Reading the AND token as a bound
  // yields NaN and silently admits a reversed interval, so the ranges are exact.
  const lower = Number(nonnegativeIntegerDigits(tokens, afterBetween, afterLower));
  const upper = Number(nonnegativeIntegerDigits(tokens, afterAnd, afterUpper));
  if (lower > upper) return null;
  return afterUpper;
}

function consumeGuard(tokens, index, name) {
  const parsers = [consumeHexLengthGuard, consumeGreaterThanGuard, consumeSingleLiteralGuard,
    consumeBoundedLengthGuard];
  for (const parse of parsers) {
    const after = parse(tokens, index, name);
    if (after !== null) return after;
  }
  return consumeColumnCall(tokens, index, "JSON_VALID", name);
}

export function supportsNullableColumnCheck(expression, columnName) {
  if (typeof columnName !== "string" || columnName.length === 0) return false;
  if (Array.isArray(expression) !== true || expression.length === 0) return false;
  const name = columnName.toLowerCase();

  const afterColumn = consumeColumn(expression, 0, name);
  if (afterColumn === null) return false;
  const afterIs = consumeWord(expression, afterColumn, "IS");
  if (afterIs === null) return false;
  const afterNull = consumeWord(expression, afterIs, "NULL");
  if (afterNull === null) return false;
  const afterOr = consumeWord(expression, afterNull, "OR");
  if (afterOr === null) return false;

  const afterOpen = consumeSymbol(expression, afterOr, "(");
  const afterGuard = consumeGuard(expression, afterOpen === null ? afterOr : afterOpen, name);
  if (afterGuard === null) return false;

  // The whole expression must be consumed. An ungrouped guard ends exactly at afterGuard,
  // so returning true whenever end equals afterGuard already happens; the only accepted
  // terminator is the final token of the expression itself.
  const end = afterOpen === null ? afterGuard : consumeSymbol(expression, afterGuard, ")");
  return end === expression.length;
}
