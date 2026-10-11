// Local byte vectors and in-memory SQLite regression; no native D1 acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  SQL_COMMENTLESS_PROTOCOL,
  NATIVE_COMMENTLESS_TRIGGER_PROTOCOL,
  projectDeploymentCommentlessSql,
  projectDeploymentNativeCommentlessSql,
} from "./lib/deployment-native-sql-representation.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 4 * 1024 * 1024;
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("SQLite ASCII separators reject Unicode identifier joining", () => {
  for (const unicode of ["\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"]) {
    for (const source of ["a" + unicode + "/*c*/b", "a/*c*/" + unicode + "b"]) {
      assert.throws(() => projectDeploymentCommentlessSql(source), /unproven adjacent token boundary/u);
      assert.throws(() => projectDeploymentNativeCommentlessSql(source), /unproven adjacent token boundary/u);
    }
  }
});

function check(project, source, expected, removed, inserted) {
  const result = project(source);
  assert.deepEqual(result, { sql: expected, source_sha256: sha(Buffer.from(source, "utf8")),
    sha256: sha(Buffer.from(expected, "utf8")), source_bytes: Buffer.byteLength(source, "utf8"),
    bytes: Buffer.byteLength(expected, "utf8"),
    ...(inserted === undefined ? {} : { inserted_parentheses: inserted }), removed_comments: removed });
  assert.equal(Object.isFrozen(result), true);
  assert.throws(() => { result.sql = "changed"; }, TypeError);
  return result;
}

test("protocols and empty/comment-only outputs have exact frozen pins", () => {
  assert.equal(SQL_COMMENTLESS_PROTOCOL, "eliotr.d1-sql-commentless-bytes.v1");
  assert.equal(NATIVE_COMMENTLESS_TRIGGER_PROTOCOL, "eliotr.d1-native-trigger-case-commentless.v1");
  const empty = check(projectDeploymentCommentlessSql, "", "", 0);
  assert.equal(empty.source_sha256, EMPTY_SHA);
  assert.equal(check(projectDeploymentCommentlessSql, "/*a*//*b*/--EOF", "", 3).sha256, EMPTY_SHA);
  check(projectDeploymentNativeCommentlessSql, "", "", 0, 0);
});

test("quoted delimiters doubled escapes identifiers and literal bytes stay exact", () => {
  const tokens = ["'it''s -- /* quoted */'", '"a""--/*identifier*/"',
    "`a``--/*identifier*/`", "[a--/*identifier*/]", "'é😀\r\n--literal\uFEFF'"];
  const body = `\tSeLeCt  ${tokens.join(", ")} ; `;
  check(projectDeploymentCommentlessSql, `/*outside*/${body}--tail\r\n`, `${body}\n`, 2);
});

test("whitespace spelling Unicode operators and non-comment lexemes are never canonicalized", () => {
  const before = "\uFEFF\tSeLeCt  α_β, X'CAfe', 1.20e+3, 0xFe, ?1, :name, @name, $name::suffix \r\n";
  const after = '  FROM "T" WHERE a!=b AND a->>b;\n';
  check(projectDeploymentCommentlessSql, `${before}/* gone */${after}`, before + after, 1);
  check(projectDeploymentCommentlessSql, before + after, before + after, 0);
  check(projectDeploymentCommentlessSql, "SELECT 1;", "SELECT 1;", 0);
  assert.notEqual(projectDeploymentCommentlessSql("SELECT 1;").sha256,
    projectDeploymentCommentlessSql("select 1;").sha256);
});

test("line comments terminate only at LF or EOF and preserve bytes outside comments", () => {
  for (const ending of ["\n", "\r\n"]) {
    check(projectDeploymentCommentlessSql, `\uFEFF--head${ending}SELECT 1;--tail${ending}\uFEFF`,
      "\uFEFF\nSELECT 1;\n\uFEFF", 2);
  }
  check(projectDeploymentCommentlessSql, "\uFEFF--head\rSELECT 1;--tail\r\uFEFF", "\uFEFF", 1);
  check(projectDeploymentCommentlessSql, "\rSELECT 1;\r--tail\rhidden", "\rSELECT 1;\r", 1);
  check(projectDeploymentCommentlessSql, "SELECT 1;-- EOF", "SELECT 1;", 1);
  check(projectDeploymentCommentlessSql, " \t/*\r\n inside */\n", " \t\n", 1);
});

test("safe retained whitespace and input edges allow adjacent comment runs", () => {
  for (const [source, expected, removed] of [
    ["a/*c*/ b", "a b", 1], ["a /*c*/b", "a b", 1],
    ["a /*one*//*two*/ b", "a  b", 2], ["/*c*/'x'/*d*/", "'x'", 2],
    ["a/*block*/--line\nb", "a\nb", 2],
    ["/* outer /* not nested */ SELECT 1;", " SELECT 1;", 1],
  ]) check(projectDeploymentCommentlessSql, source, expected, removed);
});

test("operator word number blob parameter and quoted-token joins refuse without inserting spaces", () => {
  const sources = [
    "-/*c*/-", "//*c*/*", "</*c*/=", ">/*c*/=", "!/*c*/=", "|/*c*/|", "-/*c*/>", "->/*c*/>",
    "SEL/*c*/ECT", "α/*c*/β", "a/*one*//*two*/b", "1/*c*/2", "1/*c*/.5", "1e/*c*/+2", "0/*c*/xFE",
    "X/*c*/'AB'", "x/*c*/'0F'", "X'AA'/*c*/'BB'", "?/*c*/12", ":/*c*/name", "@/*c*/name",
    "$/*c*/name", "$name/*c*/::suffix", "'a'/*c*/'b'", '"a"/*c*/"b"', "[a]/*c*/[b]",
    "1/*c*/;", // Conservative refusal includes punctuation not proven safe.
  ];
  for (const source of sources) {
    for (const project of [projectDeploymentCommentlessSql, projectDeploymentNativeCommentlessSql]) {
      assert.throws(() => project(source), /unproven adjacent token boundary/u, source);
    }
  }
});

test("unterminated block comments and every supported quote reject", () => {
  for (const source of ["/*never closed", "SELECT /* --\n", "'no end", '"no end', "`no end", "[no end",
    "'a''", '"a""', "`a``", "SELECT 1; --tail\n/*open"]) {
    for (const project of [projectDeploymentCommentlessSql, projectDeploymentNativeCommentlessSql]) {
      assert.throws(() => project(source), /Unterminated/u, source);
    }
  }
});

test("commentless projection is byte-idempotent with fresh original source pins", () => {
  const first = check(projectDeploymentCommentlessSql, " /*c*/ SELECT '/*kept*/';--end\r\n",
    "  SELECT '/*kept*/';\n", 2);
  const replay = check(projectDeploymentCommentlessSql, first.sql, first.sql, 0);
  assert.equal(replay.source_sha256, first.sha256);
  assert.equal(replay.sha256, first.sha256);
  assert.notEqual(first.source_sha256, first.sha256);
});

test("comments before native CASE wrapping keeps literals and original pins and is idempotent", () => {
  const source = '/*heading*/\r\nCREATE TRIGGER "t--/*" AFTER INSERT ON x\r\nBEGIN\r\n' +
    "  SELECT CASE /*observe*/ WHEN NEW.x=0 THEN 'END /*kept*/' ELSE (CASE WHEN 1 THEN 2 END) END; --tail\r\nEND;\r\n";
  const expected = '\r\nCREATE TRIGGER "t--/*" AFTER INSERT ON x\r\nBEGIN\r\n' +
    "  SELECT (CASE  WHEN NEW.x=0 THEN 'END /*kept*/' ELSE (CASE WHEN 1 THEN 2 END) END); \nEND;\r\n";
  const first = check(projectDeploymentNativeCommentlessSql, source, expected, 3, 2);
  const replay = check(projectDeploymentNativeCommentlessSql, expected, expected, 0, 0);
  assert.equal(replay.source_sha256, first.sha256);
  assert.equal(replay.sha256, first.sha256);
  assert.notEqual(first.source_sha256, first.sha256);
  check(projectDeploymentNativeCommentlessSql,
    "SELECT CASE WHEN 1 THEN 2 END; /*outside trigger*/", "SELECT CASE WHEN 1 THEN 2 END; ", 1, 0);
  check(projectDeploymentNativeCommentlessSql,
    "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2 END + CASE WHEN 3 THEN 4 END; END;",
    "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT (CASE WHEN 1 THEN 2 END) + (CASE WHEN 3 THEN 4 END); END;", 0, 4);
  assert.throws(() => projectDeploymentNativeCommentlessSql(
    "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2; END;"), /Unbalanced/u);
});

test("SQLite regression keeps bare CR hidden columns and CASE tokens inside line comments", () => {
  const source = "CREATE TABLE t(x TEXT -- note\r, y TEXT\n);";
  for (const project of [projectDeploymentCommentlessSql, projectDeploymentNativeCommentlessSql]) {
    const projected = project(source);
    assert.equal(projected.sql, "CREATE TABLE t(x TEXT \n);");
    for (const sql of [source, projected.sql]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(sql);
        assert.deepEqual(db.prepare("PRAGMA table_info(t)").all().map(row => row.name), ["x"]);
      } finally { db.close(); }
    }
  }
  for (const hidden of ["CASE", "END;", "CASE END ' /* unterminated"]) {
    const trigger = "CREATE TRIGGER t AFTER INSERT ON x BEGIN\n-- hidden\r" + hidden +
      "\nINSERT INTO hits(v) SELECT CASE WHEN NEW.v=1 THEN 7 ELSE 8 END;\nEND;";
    const projected = projectDeploymentNativeCommentlessSql(trigger);
    assert.equal(projected.inserted_parentheses, 2);
    assert.equal(projected.removed_comments, 1);
    assert.equal(projected.source_sha256, sha(trigger));
    for (const sql of [trigger, projected.sql]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec("CREATE TABLE x(v INTEGER); CREATE TABLE hits(v INTEGER);");
        db.exec(sql);
        db.exec("INSERT INTO x VALUES(1),(2);");
        assert.deepEqual(db.prepare("SELECT v FROM hits ORDER BY rowid").all().map(row => row.v), [7, 8]);
      } finally { db.close(); }
    }
  }
});

test("original UTF-8 byte bound is inclusive and derived CASE bytes may grow", () => {
  const exact = `'${"é".repeat((MAX_BYTES - 2) / 2)}'`;
  check(projectDeploymentCommentlessSql, exact, exact, 0);
  const body = "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2 END; END;";
  const padding = " ".repeat(MAX_BYTES - Buffer.byteLength(body, "utf8"));
  check(projectDeploymentNativeCommentlessSql, body + padding,
    "CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT (CASE WHEN 1 THEN 2 END); END;" + padding, 0, 2);
  for (const project of [projectDeploymentCommentlessSql, projectDeploymentNativeCommentlessSql]) {
    assert.throws(() => project(exact + " "), /at most 4 MiB/u);
    assert.throws(() => project(`/*${"é".repeat(MAX_BYTES / 2)}*/`), /at most 4 MiB/u);
  }
});

test("non-string and lossy UTF-8 inputs reject before projection can hide them", () => {
  for (const project of [projectDeploymentCommentlessSql, projectDeploymentNativeCommentlessSql]) {
    for (const source of [null, undefined, 7, {}, [], Buffer.from("SELECT 1;")]) {
      assert.throws(() => project(source), /expected a string/u);
    }
    for (const source of ["\uD800", "\uDC00", "/*\uD800*/", "'\uDC00'", "--\uD800"]) {
      assert.throws(() => project(source), /lossless UTF-8/u);
    }
  }
});
