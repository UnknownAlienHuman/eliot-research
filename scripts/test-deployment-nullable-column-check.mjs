import assert from "node:assert/strict";
import { supportsNullableColumnCheck } from "./lib/deployment-nullable-column-check.mjs";

// Focused fixture for the bounded nullable column CHECK recognizer. The tokenizer below
// mirrors the root-owned token contract so the real token shape is exercised: word tokens
// keep the original spelling in raw and the uppercase form in value, and every digit is its
// own single-character symbol token. Nothing else is imported, and no live, network or
// Wrangler call is made.

function tokenize(sql) {
  const tokens = [];
  const wordPattern = /[A-Za-z_][A-Za-z0-9_$]*/uy;
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    if (char === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated SQL comment");
      index = end + 2;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let value = "";
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (sql[index + 1] === close && char !== "[") { value += close; index += 2; continue; }
          index += 1;
          closed = true;
          break;
        }
        value += sql[index];
        index += 1;
      }
      if (!closed) throw new Error("Unterminated quoted SQL token");
      tokens.push({ type: char === "'" ? "literal" : "identifier", value });
      continue;
    }
    wordPattern.lastIndex = index;
    const word = wordPattern.exec(sql);
    if (word) {
      tokens.push({ type: "word", value: word[0].toUpperCase(), raw: word[0] });
      index += word[0].length;
      continue;
    }
    tokens.push({ type: "symbol", value: char });
    index += 1;
  }
  return tokens;
}

function accepts(sql, column) {
  return supportsNullableColumnCheck(tokenize(sql), column === undefined ? "target" : column);
}

function rejects(sql, column) {
  return accepts(sql, column) === false;
}

const groups = [
  ["admits the equivalent greater-than form", () => {
    assert.equal(accepts("target IS NULL OR target > 0"), true);
  }],
  ["admits the LENGTH hex form with and without optional grouping", () => {
    assert.equal(accepts("target IS NULL OR LENGTH(target) = 64 AND target NOT GLOB '*[^0-9a-f]*'"), true);
    assert.equal(accepts("target IS NULL OR (LENGTH(target) = 64 AND target NOT GLOB '*[^0-9a-f]*')"), true);
    assert.equal(accepts("target IS NULL OR length(target) = 64 and target not glob '*[^0-9a-f]*'"), true);
  }],
  ["admits JSON_VALID, one bounded literal and an ordered BETWEEN interval", () => {
    assert.equal(accepts("target IS NULL OR JSON_VALID(target)"), true);
    assert.equal(accepts("target IS NULL OR (JSON_VALID(target))"), true);
    assert.equal(accepts("target IS NULL OR target = 'eliotr.managed-item-effects.v1'"), true);
    assert.equal(accepts("target IS NULL OR (LENGTH(target) BETWEEN 1 AND 256)"), true);
    assert.equal(accepts("target IS NULL OR LENGTH(target) BETWEEN 0 AND 0"), true);
  }],
  ["matches the column name against its raw spelling case-insensitively", () => {
    assert.equal(accepts("Target IS NULL OR TARGET > 0", "target"), true);
    assert.equal(accepts("target IS NULL OR TARGET > 0", "TARGET"), true);
  }],
  ["rejects trailing tokens after an ungrouped guard", () => {
    // Regression: the terminator was previously accepted at any position, not only at the end.
    assert.equal(rejects("target IS NULL OR target > 0 AND 1 = 1"), true);
    assert.equal(rejects("target IS NULL OR target > 0 junk"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) BETWEEN 1 AND 4 target"), true);
    assert.equal(rejects("target IS NULL OR JSON_VALID(target) junk"), true);
    assert.equal(rejects("target IS NULL OR (target > 0) AND target > 1"), true);
  }],
  ["rejects a reversed BETWEEN interval", () => {
    // Regression: the lower bound was read from the AND token and compared as NaN.
    assert.equal(rejects("target IS NULL OR LENGTH(target) BETWEEN 256 AND 1"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) BETWEEN 4 AND 2"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) BETWEEN 2 AND 1"), true);
  }],
  ["rejects another column, a cross-column reference or a subquery", () => {
    assert.equal(rejects("other IS NULL OR target > 0"), true);
    assert.equal(rejects("target IS NULL OR other > 0"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(other) = 4"), true);
    assert.equal(rejects("target IS NULL OR target > (SELECT 0)"), true);
    assert.equal(rejects("target IS NULL OR target > 0 AND other = 1"), true);
  }],
  ["rejects unadmitted operators, an inverted NOT NULL and a bare guard", () => {
    for (const operator of ["<", "<=", ">=", "=", "<>", "!=", "LIKE"]) {
      assert.equal(rejects("target IS NULL OR target " + operator + " target"), true, operator);
    }
    assert.equal(rejects("target IS NOT NULL OR target > 0"), true);
    assert.equal(rejects("target IS NULL OR target IS NULL"), true);
    assert.equal(rejects("target IS NULL OR target GLOB '*[^0-9a-f]*'"), true);
    assert.equal(rejects("target > 0"), true);
    assert.equal(rejects("target IS NULL OR"), true);
  }],
  ["rejects unadmitted functions and the wrong argument count", () => {
    for (const name of ["json_quote", "json_type", "json_extract", "hex", "substr", "upper", "abs"]) {
      assert.equal(rejects("target IS NULL OR " + name + "(target)"), true, name);
    }
    assert.equal(rejects("target IS NULL OR JSON_VALID(target, '$.a')"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target, 1)"), true);
    assert.equal(rejects("target IS NULL OR JSON_VALID"), true);
  }],
  ["rejects a weakened hex glob pattern and a non-integer bound", () => {
    assert.equal(rejects("target IS NULL OR LENGTH(target) = 64 AND target NOT GLOB '*[^0-9a-fA-F]*'"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) = 64 AND target GLOB '*[^0-9a-f]*'"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) > 64"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) = -1"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) = 1.5"), true);
    assert.equal(rejects("target IS NULL OR target > -1"), true);
    assert.equal(rejects("target IS NULL OR LENGTH(target) BETWEEN -1 AND 4"), true);
  }],
  ["enforces the 512-byte bounded literal limit", () => {
    assert.equal(accepts("target IS NULL OR target = '" + "a".repeat(512) + "'"), true);
    assert.equal(rejects("target IS NULL OR target = '" + "a".repeat(513) + "'"), true);
    assert.equal(rejects("target IS NULL OR target = ''"), true);
  }],
  ["returns a bare false for malformed arguments instead of throwing", () => {
    assert.equal(supportsNullableColumnCheck(undefined, "target"), false);
    assert.equal(supportsNullableColumnCheck(null, "target"), false);
    assert.equal(supportsNullableColumnCheck("target IS NULL OR target > 0", "target"), false);
    assert.equal(supportsNullableColumnCheck([], "target"), false);
    assert.equal(supportsNullableColumnCheck(tokenize("target IS NULL OR target > 0"), ""), false);
    assert.equal(supportsNullableColumnCheck(tokenize("target IS NULL OR target > 0"), 7), false);
    assert.equal(supportsNullableColumnCheck([{ type: "symbol", value: "(" }], "target"), false);
  }],
];

let failures = 0;
for (const [name, action] of groups) {
  try {
    action();
  } catch (error) {
    failures += 1;
    console.log("nullable column check: FAIL " + name + ": " + (error && error.message ? error.message : error));
  }
}
if (failures > 0) {
  console.log("nullable column check: " + failures + " of " + groups.length + " groups failed");
  process.exitCode = 1;
} else {
  console.log("nullable column check: " + groups.length + " groups passed; negative cases asserted above");
}
