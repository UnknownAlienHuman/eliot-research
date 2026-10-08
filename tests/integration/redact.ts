// Shared redaction + digest helpers for tests/integration probe runners.
//
// Step 0 of the T5-erasure-restore packet: lifted verbatim out of
// d1-write-readback-runner.ts so the T4 and T5 runners share one
// implementation. Probe discipline: raw input values, prompts, source text
// and secrets never reach output — only digests and redacted text do.
import { createHash } from "node:crypto";

const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PEM]"],
  [/\bxox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  [/\bbearer\s+\S+/gi, "[REDACTED_BEARER]"],
  [/(?:token|cookie|session)\s*[:=]\s*\S+/gi, "[REDACTED_CREDENTIAL]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
];

export function redactSecretsText(text: string): string {
  let out = text;
  for (const [shape, marker] of REDACTIONS) out = out.replace(shape, marker);
  return out;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
