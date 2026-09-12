export type FederationRuntimeAuthorityErrorCode =
  | "FEDERATION_RUNTIME_CONFIG_INVALID"
  | "FEDERATION_BUNDLE_BYTES_MISSING"
  | "FEDERATION_BUNDLE_INTEGRITY_MISMATCH"
  | "FEDERATION_BUNDLE_TOO_LARGE"
  | "FEDERATION_BUNDLE_RANGE_INVALID"
  | "FEDERATION_RUNTIME_CURSOR_INVALID"
  | "FEDERATION_RUNTIME_CURSOR_EXPIRED"
  | "FEDERATION_RUNTIME_CURSOR_AUTHORITY_MISMATCH"
  | "FEDERATION_RUNTIME_CURSOR_STALE"
  | "FEDERATION_RUNTIME_SCOPE_INVALID"
  | "FEDERATION_RUNTIME_READBACK_CORRUPT"
  | "FEDERATION_RUNTIME_READ_FAILED";

export class FederationRuntimeAuthorityError extends Error {
  public constructor(
    public readonly code: FederationRuntimeAuthorityErrorCode,
    message: string,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FederationRuntimeAuthorityError";
  }
}

export function federationRuntimeFail(
  code: FederationRuntimeAuthorityErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new FederationRuntimeAuthorityError(code, message, retryable, cause);
}

export function decodeFederationCursorHmacKey(raw: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/u.test(raw)) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CONFIG_INVALID",
      "federation cursor key must contain exactly 32 lowercase hexadecimal bytes",
    );
  }
  return Uint8Array.from(
    raw.match(/../gu)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

export async function federationSha256Bytes(
  bytes: Uint8Array,
): Promise<string> {
  const stable = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stable.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
