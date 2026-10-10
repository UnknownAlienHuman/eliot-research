export type UnicodeTextLengthUnit = "utf16-code-units" | "utf8-bytes";

export type UnicodeTextValidationReason = "ill-formed-unicode" | "too-long" | null;

export interface UnicodeTextValidationOptions {
  readonly unit: UnicodeTextLengthUnit;
  readonly maximum: number;
}

export interface UnicodeTextValidation {
  readonly text: string;
  readonly valid: boolean;
  readonly reason: UnicodeTextValidationReason;
}

function isWellFormedUnicode(text: string): boolean {
  const nativeCheck = String.prototype.isWellFormed;
  if (nativeCheck !== undefined) return nativeCheck.call(text);

  const encoded = new TextEncoder().encode(text);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) === text;
}

export function validateUnicodeText(
  text: string,
  options: UnicodeTextValidationOptions,
): UnicodeTextValidation {
  if (!isWellFormedUnicode(text)) {
    return { text, valid: false, reason: "ill-formed-unicode" };
  }

  const length = options.unit === "utf16-code-units"
    ? text.length
    : new TextEncoder().encode(text).byteLength;
  if (length > options.maximum) {
    return { text, valid: false, reason: "too-long" };
  }

  return { text, valid: true, reason: null };
}
