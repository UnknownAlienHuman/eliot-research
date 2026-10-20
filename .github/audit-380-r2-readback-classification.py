from pathlib import Path

path = Path("packages/platform-cloudflare/src/r2.ts")
text = path.read_text(encoding="utf-8")

old_helpers = '''function immutableConflict(key: string, cause: unknown): never {
  throw new R2IntegrityError(
    "R2_IMMUTABLE_KEY_CONFLICT",
    `immutable key ${key} already contains incompatible bytes or metadata`,
    false,
    cause,
  );
}

async function reconcileConditionalWrite(
'''
new_helpers = '''function immutableConflict(key: string, cause: unknown): never {
  throw new R2IntegrityError(
    "R2_IMMUTABLE_KEY_CONFLICT",
    `immutable key ${key} already contains incompatible bytes or metadata`,
    false,
    cause,
  );
}

function readbackProvesImmutableConflict(error: R2IntegrityError): boolean {
  return error.code === "R2_READBACK_SIZE_MISMATCH"
    || error.code === "R2_READBACK_DIGEST_MISMATCH"
    || error.code === "R2_READBACK_METADATA_MISMATCH";
}

function preserveReadbackFailure(error: R2IntegrityError, writeError?: unknown): never {
  if (writeError === undefined) throw error;
  throw new R2IntegrityError(error.code, error.message, error.retryable, {
    write_error: writeError,
    readback_error: error,
  });
}

async function reconcileConditionalWrite(
'''

old_catch = '''  } catch (readbackError) {
    if (readbackError instanceof R2IntegrityError && readbackError.code !== "R2_READBACK_MISSING") {
      immutableConflict(key, readbackError);
    }
    if (writeError !== undefined) {
      throw new R2IntegrityError(
        "R2_WRITE_REJECTED",
        `R2 write for ${key} failed and exact readback could not prove success`,
        true,
        { write_error: writeError, readback_error: readbackError },
      );
    }
    throw new R2IntegrityError(
      "R2_CONDITIONAL_WRITE_INCONSISTENT",
      `conditional write for ${key} did not create an object and no exact winner is readable`,
      true,
      readbackError,
    );
  }
'''
new_catch = '''  } catch (readbackError) {
    if (readbackError instanceof R2IntegrityError) {
      if (readbackProvesImmutableConflict(readbackError)) immutableConflict(key, readbackError);
      if (readbackError.code !== "R2_READBACK_MISSING") {
        preserveReadbackFailure(readbackError, writeError);
      }
    }
    if (writeError !== undefined) {
      throw new R2IntegrityError(
        "R2_WRITE_REJECTED",
        `R2 write for ${key} failed and exact readback could not prove success`,
        true,
        { write_error: writeError, readback_error: readbackError },
      );
    }
    throw new R2IntegrityError(
      "R2_CONDITIONAL_WRITE_INCONSISTENT",
      `conditional write for ${key} did not create an object and no exact winner is readable`,
      true,
      readbackError,
    );
  }
'''

for label, old, new in (("helper insertion", old_helpers, new_helpers), ("reconciliation catch", old_catch, new_catch)):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one exact match, found {count}")
    text = text.replace(old, new)

path.write_text(text, encoding="utf-8")
