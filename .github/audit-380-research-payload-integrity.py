from pathlib import Path

path = Path("packages/cloudflare-research-runtime/src/research-session-application.ts")
text = path.read_text(encoding="utf-8")

old_write = '''  const sha256 = await digest(bytes);
  if ((await ports.work_bucket.head(objectKey).catch(() => null)) === null) {
    await ports.work_bucket.put(objectKey, bytes, { sha256 });
  }
  const currentPayload = await ports.work_bucket.get(objectKey).catch(() => null);
  if (currentPayload === null) {
    ports.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "payload readback is unavailable", 503, true);
  }
  const currentBytes = new Uint8Array(await currentPayload.arrayBuffer());
  if ((await digest(currentBytes)) !== sha256 || currentBytes.byteLength !== bytes.byteLength) {
    ports.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
  }
'''
new_write = '''  const sha256 = await digest(bytes);
  try {
    await ports.work_bucket.put(objectKey, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256,
    });
  } catch {
    // A conditional conflict and a committed write with a lost acknowledgement
    // are both settled by exact readback below.
  }
  const currentPayload = await ports.work_bucket.get(objectKey).catch(() =>
    ports.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "payload readback is unavailable", 503, true));
  if (currentPayload === null) {
    ports.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "payload readback is unavailable", 503, true);
  }
  if (currentPayload.size !== bytes.byteLength) {
    ports.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
  }
  const currentBytes = new Uint8Array(await currentPayload.arrayBuffer().catch(() =>
    ports.fail("RESEARCH_SETTLEMENT_UNCERTAIN", "payload body readback is unavailable", 503, true)));
  if ((await digest(currentBytes)) !== sha256 || currentBytes.byteLength !== bytes.byteLength) {
    ports.fail("RESEARCH_CONFLICT", "idempotency identity is bound to different bytes", 409);
  }
'''

old_handles = '''  const handles = {
    has: async (ref: string) => (await ports.work_bucket.head(ref).catch(() => null)) !== null,
    digestFor: async (ref: string) => {
      const head = await ports.work_bucket.head(ref).catch(() => null);
      if (head === null) return null;
      const raw = (head as unknown as { checksums?: { sha256?: unknown } }).checksums?.sha256;
      if (raw instanceof ArrayBuffer) {
        return Array.from(new Uint8Array(raw), (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      return payloadHash;
    },
  };
'''
new_handles = '''  const readPayloadHead = async (): Promise<R2Object | null> => ports.work_bucket.head(payloadKey);
  const handles = {
    has: async (ref: string) => ref === payloadKey && await readPayloadHead() !== null,
    digestFor: async (ref: string) => {
      if (ref !== payloadKey) return null;
      const head = await readPayloadHead();
      if (head === null || head.size !== payloadBytes.byteLength) return null;
      const observed = head.checksums.sha256;
      if (observed !== undefined) {
        if (observed.byteLength !== 32) return null;
        return Array.from(new Uint8Array(observed),
          (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      const object = await ports.work_bucket.get(payloadKey);
      if (object === null || object.size !== payloadBytes.byteLength) return null;
      const observedBytes = new Uint8Array(await object.arrayBuffer());
      return observedBytes.byteLength === payloadBytes.byteLength ? digest(observedBytes) : null;
    },
  };
'''

for label, old, new in (("conditional write", old_write, new_write), ("handle observation", old_handles, new_handles)):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one exact match, found {count}")
    text = text.replace(old, new)

path.write_text(text, encoding="utf-8")
