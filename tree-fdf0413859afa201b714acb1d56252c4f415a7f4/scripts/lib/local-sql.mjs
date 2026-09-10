export const localSqlIdentifier = (value) => typeof value === "string" && value.length > 0 && value === value.trim() &&
  new globalThis.TextEncoder().encode(value).byteLength <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
// Wrangler's CLI has no SQL parameter-binding option. Quote values, never identifiers or arbitrary expressions.
export const sqlLiteral = (value) => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (!localSqlIdentifier(value) && !(typeof value === "string" && value.startsWith("[") && value.length < 4096 && !value.includes("\0"))) {
    throw new Error("Invalid local policy SQL value");
  }
  return `'${value.replaceAll("'", "''")}'`;
};
