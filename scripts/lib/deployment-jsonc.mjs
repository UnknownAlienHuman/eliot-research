import ts from "typescript";

/** Data-only JSONC parser: comments/trailing commas accepted, syntax diagnostics rejected. */
export function parseDeploymentJsonc(text, label = "deployment JSONC") {
  if (typeof text !== "string") throw new Error(label + " must contain JSONC text");
  const result = ts.parseConfigFileTextToJson(label, text);
  if (result.error !== undefined) {
    throw new Error(label + " contains invalid JSONC (TypeScript diagnostic " + result.error.code + ")");
  }
  const value = result.config;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must contain a JSONC object");
  }
  function requirePlainData(node) {
    if (node === null || typeof node !== "object") return;
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== (Array.isArray(node) ? Array.prototype : Object.prototype) && prototype !== null) {
      throw new Error(label + " contains a non-data object");
    }
    for (const child of Object.values(node)) requirePlainData(child);
  }
  requirePlainData(value);
  return value;
}
