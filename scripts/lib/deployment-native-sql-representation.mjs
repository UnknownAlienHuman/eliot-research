import { createHash } from "node:crypto";
import { projectDeploymentNativeTriggerSql } from "./deployment-native-trigger-representation.mjs";

export const SQL_COMMENTLESS_PROTOCOL = "eliotr.d1-sql-commentless-bytes.v1";
export const NATIVE_COMMENTLESS_TRIGGER_PROTOCOL = "eliotr.d1-native-trigger-case-commentless.v1";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const invalid = message => { throw new Error(message); };
const sqlWhitespace = char => /[ \t\n\r\f\v]/u.test(char);

function sourceBytes(sql) {
  if (typeof sql !== "string" || Buffer.byteLength(sql, "utf8") > MAX_SOURCE_BYTES) {
    invalid("Invalid commentless SQL input: expected a string of at most 4 MiB");
  }
  const bytes = Buffer.from(sql, "utf8");
  if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== sql) {
    invalid("Commentless SQL input is not lossless UTF-8");
  }
  return bytes;
}

function quotedEnd(sql, start) {
  const open = sql[start], close = open === "[" ? "]" : open;
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== close) continue;
    // SQLite doubles quote delimiters; bracket identifiers end at the first ].
    if (open !== "[" && sql[index + 1] === close) { index += 1; continue; }
    return index + 1;
  }
  invalid("Unterminated quoted SQL token in commentless representation");
}

// A deletion is proven safe only at an input edge or with retained whitespace
// on at least one side. This deliberately refuses even unproven punctuation
// boundaries: single-symbol lexemes cannot prove numbers/operators unchanged.
function removeComments(sql) {
  const pieces = [];
  let index = 0, retainedStart = 0, lastRetained = null, pendingDeletion = false, removed = 0;
  while (index < sql.length) {
    const char = sql[index], next = sql[index + 1];
    if ((char === "-" && next === "-") || (char === "/" && next === "*")) {
      pieces.push(sql.slice(retainedStart, index));
      if (char === "-") {
        index += 2;
        // SQLite line comments end only at LF (ASCII 0x0a) or EOF.
        // A bare CR and any SQL following it still belong to the comment.
        while (index < sql.length && sql[index] !== "\n") index += 1;
      } else {
        const end = sql.indexOf("*/", index + 2);
        if (end < 0) invalid("Unterminated SQL block comment in commentless representation");
        index = end + 2;
      }
      retainedStart = index;
      pendingDeletion = true;
      removed += 1;
      continue;
    }
    if (pendingDeletion) {
      if (lastRetained !== null && !sqlWhitespace(lastRetained) && !sqlWhitespace(char)) {
        invalid("SQL comment deletion has an unproven adjacent token boundary");
      }
      pendingDeletion = false;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      index = quotedEnd(sql, index);
      lastRetained = sql[index - 1];
    } else {
      lastRetained = char;
      index += 1;
    }
  }
  pieces.push(sql.slice(retainedStart));
  return { sql: pieces.join(""), removed_comments: removed };
}

function receipt(source, projection, extra = {}) {
  const output = Buffer.from(projection.sql, "utf8");
  return Object.freeze({ sql: projection.sql, source_sha256: sha(source), sha256: sha(output),
    source_bytes: source.byteLength, bytes: output.byteLength, ...extra,
    removed_comments: projection.removed_comments });
}

export function projectDeploymentCommentlessSql(sql) {
  const source = sourceBytes(sql);
  return receipt(source, removeComments(sql));
}

export function projectDeploymentNativeCommentlessSql(sql) {
  const source = sourceBytes(sql);
  // Remove comments before CASE admission so the legacy CASE tokenizer never
  // interprets tokens hidden after a CR inside a SQLite line comment.
  const commentless = removeComments(sql);
  const native = projectDeploymentNativeTriggerSql(commentless.sql);
  // Only the caller's original input has the 4 MiB limit; CASE parentheses can
  // grow its derived representation. Preserve original, not intermediate pins.
  return receipt(source, { sql: native.sql, removed_comments: commentless.removed_comments },
    { inserted_parentheses: native.inserted_parentheses });
}
