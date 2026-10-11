const invalid = message => { throw new Error(message); };

export function tokenizeDeploymentSql(sql) {
  const result = [];
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
      if (end < 0) invalid("Unterminated SQL comment in approved migration");
      index = end + 2;
      continue;
    }
    const start = index;
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
      if (!closed) invalid("Unterminated quoted SQL token in approved migration");
      if (result.length >= 100_000) invalid("Migration SQL exceeds the bounded token admission limit");
      result.push({ type: char === "'" ? "literal" : "identifier", value, start, end: index });
      continue;
    }
    wordPattern.lastIndex = index;
    const word = wordPattern.exec(sql);
    if (word) {
      if (result.length >= 100_000) invalid("Migration SQL exceeds the bounded token admission limit");
      index += word[0].length;
      result.push({ type: "word", value: word[0].toUpperCase(), raw: word[0], start, end: index });
      continue;
    }
    if (result.length >= 100_000) invalid("Migration SQL exceeds the bounded token admission limit");
    result.push({ type: "symbol", value: char, start, end: index + 1 });
    index += 1;
  }
  return result;
}
