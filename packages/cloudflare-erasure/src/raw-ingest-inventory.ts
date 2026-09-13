import {
  assertErasureIdentifier,
  assertErasureSha256,
  assertErasureText,
  canonicalErasureJson,
  erasureFail,
  erasureSha256Utf8,
  stableErasureId,
} from "./canonical.js";

const ROW_LIMIT = 10_000;
const FETCH_LIMIT = ROW_LIMIT + 1;

interface QueryResult<T> {
  readonly success?: boolean;
  readonly results?: readonly T[];
}

interface SourceIdentityRow {
  readonly source_revision_ref: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly content_sha256: unknown;
}

interface CaptureRow {
  readonly capture_id: unknown;
  readonly principal_ref: unknown;
  readonly owner_system_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_revision_ref: unknown;
  readonly source_owner_generation: unknown;
  readonly content_sha256: unknown;
  readonly state: unknown;
  readonly object_key: unknown;
  readonly updated_at: unknown;
  readonly expires_at: unknown;
}

interface ConversionRow {
  readonly operation_id: unknown;
  readonly principal_ref: unknown;
  readonly capture_id: unknown;
  readonly content_sha256: unknown;
  readonly state: unknown;
  readonly result_json: unknown;
  readonly result_sha256: unknown;
  readonly output_object_key: unknown;
  readonly receipt_object_key: unknown;
  readonly updated_at: unknown;
}

interface AdmissionRow {
  readonly admission_operation_id: unknown;
  readonly principal_ref: unknown;
  readonly capture_id: unknown;
  readonly conversion_operation_id: unknown;
  readonly source_revision_ref: unknown;
  readonly state: unknown;
  readonly updated_at: unknown;
  readonly expires_at: unknown;
}

interface WorkspaceBindingRow {
  readonly binding_id: unknown;
  readonly principal_ref: unknown;
  readonly capture_id: unknown;
  readonly capture_content_sha256: unknown;
  readonly conversion_operation_id: unknown;
  readonly admission_operation_id: unknown;
  readonly state: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface RefRow {
  readonly source_revision_ref: unknown;
}

export interface RawIngestBlobDependency {
  readonly object_key: string;
  readonly shared_live_reference_count: number;
}

export interface RawIngestPendingState {
  readonly retention_or_hold_ref: string;
  readonly next_review_at: string;
}

export interface RawIngestDependencyInventory {
  readonly source_revision_ref: string;
  readonly d1_canonical_ref: string;
  readonly capture_ids: readonly string[];
  readonly conversion_operation_ids: readonly string[];
  readonly admission_operation_ids: readonly string[];
  readonly workspace_binding_ids: readonly string[];
  readonly blobs: readonly RawIngestBlobDependency[];
  readonly pending?: RawIngestPendingState;
}

export interface RawIngestInventoryRequest {
  readonly source_revision_ref: string;
  readonly content_sha256: string;
  readonly selected_source_revision_refs: ReadonlySet<string>;
}

function boundedRows<T>(result: QueryResult<T>, label: string): readonly T[] {
  if (result.success === false) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} failed`, true);
  const rows = result.results ?? [];
  if (rows.length > ROW_LIMIT) erasureFail("ERASURE_CLOSURE_INCOMPLETE", `${label} exceeds its bounded inventory`);
  return rows;
}

function timestamp(value: unknown, label: string): string {
  const text = assertErasureText(value, label, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", `${label} is not canonical`);
  }
  return text;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function earliest(current: string | undefined, candidate: string): string {
  return current === undefined || compare(candidate, current) < 0 ? candidate : current;
}

async function pendingState(
  sourceRevisionRef: string,
  nextReviewAt: string | undefined,
): Promise<RawIngestPendingState | undefined> {
  return nextReviewAt === undefined
    ? undefined
    : {
        retention_or_hold_ref: await stableErasureId("raw-ingest-inflight", sourceRevisionRef),
        next_review_at: nextReviewAt,
      };
}

function sourceIdentity(row: SourceIdentityRow, expectedRef: string, expectedSha: string): {
  readonly source_revision_ref: string;
  readonly source_namespace_id: string;
  readonly source_owner_system_id: string;
  readonly source_owner_generation: string;
  readonly content_sha256: string;
} {
  const sourceRevisionRef = assertErasureIdentifier(row.source_revision_ref, "source revision ref");
  const contentSha = assertErasureSha256(row.content_sha256, "source content digest");
  if (sourceRevisionRef !== expectedRef || contentSha !== expectedSha) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "source revision identity changed during raw inventory");
  }
  return {
    source_revision_ref: sourceRevisionRef,
    source_namespace_id: assertErasureIdentifier(row.source_namespace_id, "source namespace ID"),
    source_owner_system_id: assertErasureIdentifier(row.source_owner_system_id, "source owner system ID"),
    source_owner_generation: assertErasureIdentifier(row.source_owner_generation, "source owner generation"),
    content_sha256: contentSha,
  };
}

function validateCapture(row: CaptureRow, source: ReturnType<typeof sourceIdentity>): {
  readonly capture_id: string;
  readonly principal_ref: string;
  readonly content_sha256: string;
  readonly object_key: string;
  readonly expires_at: string;
} {
  const captureId = assertErasureIdentifier(row.capture_id, "raw capture ID");
  const principalRef = assertErasureIdentifier(row.principal_ref, "raw capture principal");
  if (
    assertErasureIdentifier(row.owner_system_id, "raw capture owner system") !== source.source_owner_system_id ||
    assertErasureIdentifier(row.source_namespace_id, "raw capture namespace") !== source.source_namespace_id ||
    assertErasureIdentifier(row.source_revision_ref, "raw capture source revision") !== source.source_revision_ref ||
    assertErasureIdentifier(row.source_owner_generation, "raw capture owner generation") !== source.source_owner_generation
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw capture is bound to a different source revision");
  }
  const contentSha = assertErasureSha256(row.content_sha256, "raw capture content digest");
  if (row.state !== "INTENT" && row.state !== "CAPTURED") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw capture state is invalid");
  }
  return {
    capture_id: captureId,
    principal_ref: principalRef,
    content_sha256: contentSha,
    object_key: assertErasureText(row.object_key, "raw capture object key", 1024),
    expires_at: timestamp(row.expires_at, "raw capture expiry"),
  };
}

async function normalizedContentSha(row: ConversionRow, operationId: string, captureId: string, contentSha: string): Promise<string | undefined> {
  if (row.state === "STARTED") {
    if (row.result_json !== null && row.result_json !== undefined) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "started raw conversion already has a result");
    }
    return undefined;
  }
  if (row.result_json === null || row.result_json === undefined || typeof row.result_json !== "string") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "terminal raw conversion is missing its result witness");
  }
  if (row.state !== "COMPLETE") return undefined;
  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.result_json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "raw conversion result witness is not an object");
    }
    result = parsed as Record<string, unknown>;
  } catch (cause) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw conversion result witness is malformed", false, cause);
  }
  const expectedKeys = [
    "protocol", "state", "operation_id", "capture_id", "content_sha256", "output_sha256",
    "output_bytes", "detected_mime", "format", "tokens",
  ];
  if (Object.keys(result).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(result, key)) ||
      result.protocol !== "eliotr.raw-markdown-conversion.v1" || result.state !== "COMPLETE" ||
      assertErasureIdentifier(result.operation_id, "raw conversion result operation ID") !== operationId ||
      assertErasureIdentifier(result.capture_id, "raw conversion result capture ID") !== captureId ||
      assertErasureSha256(result.content_sha256, "raw conversion result input digest") !== contentSha) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw conversion result is bound to a different capture");
  }
  const outputSha = assertErasureSha256(result.output_sha256, "raw conversion normalized output digest");
  if (!Number.isSafeInteger(result.output_bytes) || (result.output_bytes as number) < 1 ||
      typeof result.detected_mime !== "string" || (result.format !== "markdown" && result.format !== "text") ||
      !Number.isSafeInteger(result.tokens) || (result.tokens as number) < 0) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw conversion normalized output witness is invalid");
  }
  if (row.result_sha256 === null || row.result_sha256 === undefined) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "complete raw conversion is missing its result digest");
  }
  const resultDigest = assertErasureSha256(row.result_sha256, "raw conversion result digest");
  if (row.result_json !== canonicalErasureJson(result) || resultDigest !== await erasureSha256Utf8(row.result_json)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw conversion result bytes do not match their digest");
  }
  return outputSha;
}

async function validateConversion(
  row: ConversionRow,
  capture: { readonly capture_id: string; readonly principal_ref: string; readonly content_sha256: string },
): Promise<{ readonly operation_id: string; readonly content_sha256: string; readonly normalized_content_sha256?: string; readonly output_object_key: string; readonly receipt_object_key: string }> {
  const operationId = assertErasureSha256(row.operation_id, "raw conversion operation ID");
  const contentSha = assertErasureSha256(row.content_sha256, "raw conversion content digest");
  if (
    assertErasureIdentifier(row.principal_ref, "raw conversion principal") !== capture.principal_ref ||
    assertErasureIdentifier(row.capture_id, "raw conversion capture ID") !== capture.capture_id ||
    contentSha !== capture.content_sha256
  ) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw conversion is bound to a different capture");
  }
  if (row.state !== "STARTED" && row.state !== "COMPLETE" && row.state !== "FAILED" && row.state !== "UNKNOWN") {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "raw conversion state is invalid");
  }
  const normalizedSha = await normalizedContentSha(row, operationId, capture.capture_id, contentSha);
  return {
    operation_id: operationId,
    content_sha256: contentSha,
    ...(normalizedSha === undefined ? {} : { normalized_content_sha256: normalizedSha }),
    output_object_key: assertErasureText(row.output_object_key, "raw conversion output key", 1024),
    receipt_object_key: assertErasureText(row.receipt_object_key, "raw conversion receipt key", 1024),
  };
}

export async function referencesForKey(
  database: D1Database,
  objectKey: string,
  selected: ReadonlySet<string>,
): Promise<number> {
  const captures = boundedRows(
    await database.prepare(
      `SELECT DISTINCT source_revision_ref FROM raw_file_capture WHERE object_key=?1 LIMIT ${FETCH_LIMIT}`,
    ).bind(objectKey).all<RefRow>(),
    "raw capture shared-reference inventory",
  );
  const conversions = boundedRows(
    await database.prepare(
      `SELECT DISTINCT c.source_revision_ref FROM raw_markdown_conversion m ` +
      `JOIN raw_file_capture c ON c.capture_id=m.capture_id ` +
      `WHERE m.output_object_key=?1 OR m.receipt_object_key=?1 LIMIT ${FETCH_LIMIT}`,
    ).bind(objectKey).all<RefRow>(),
    "raw conversion shared-reference inventory",
  );
  const sourceRevisions = boundedRows(
    await database.prepare(
      `SELECT source_revision_ref FROM source_revision WHERE purge_state='LIVE' ` +
      `AND (original_r2_key=?1 OR normalized_artifact_ref=?1) LIMIT ${FETCH_LIMIT}`,
    ).bind(objectKey).all<RefRow>(),
    "source revision shared-reference inventory",
  );
  const refs = new Set<string>();
  for (const row of [...captures, ...conversions, ...sourceRevisions]) {
    const ref = assertErasureIdentifier(row.source_revision_ref, "raw shared source revision ref");
    if (!selected.has(ref)) refs.add(ref);
  }
  return refs.size;
}

export async function enumerateRawIngestDependencies(
  database: D1Database,
  input: RawIngestInventoryRequest,
): Promise<RawIngestDependencyInventory | null> {
  const sourceRevisionRef = assertErasureIdentifier(input.source_revision_ref, "source revision ref");
  const contentSha = assertErasureSha256(input.content_sha256, "source content digest");
  if (!input.selected_source_revision_refs.has(sourceRevisionRef)) {
    erasureFail("ERASURE_INPUT_INVALID", "raw inventory selection does not include the source revision");
  }
  const sourceRow = await database.prepare(
    "SELECT sr.source_revision_ref,s.source_namespace_id,s.source_owner_system_id," +
    "sr.source_owner_generation,sr.content_sha256 FROM source_revision sr " +
    "JOIN source s ON s.source_id=sr.source_id WHERE sr.source_revision_ref=?1 LIMIT 1",
  ).bind(sourceRevisionRef).first<SourceIdentityRow>();
  if (sourceRow === null) erasureFail("ERASURE_INPUT_INVALID", "source revision is unavailable for raw inventory");
  const source = sourceIdentity(sourceRow, sourceRevisionRef, contentSha);
  const captures = boundedRows(
    await database.prepare(
      `SELECT capture_id,principal_ref,owner_system_id,source_namespace_id,source_revision_ref,` +
      `source_owner_generation,content_sha256,state,object_key,updated_at,expires_at ` +
      `FROM raw_file_capture WHERE source_revision_ref=?1 ORDER BY capture_id LIMIT ${FETCH_LIMIT}`,
    ).bind(sourceRevisionRef).all<CaptureRow>(),
    "raw capture inventory",
  );
  if (captures.length === 0) {
    const orphanAdmissions = boundedRows(
      await database.prepare(
        `SELECT admission_operation_id FROM raw_normalized_admission WHERE source_revision_ref=?1 LIMIT ${FETCH_LIMIT}`,
      ).bind(sourceRevisionRef).all<{ readonly admission_operation_id: unknown }>(),
      "orphan raw normalized admission inventory",
    );
    if (orphanAdmissions.length > 0) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "raw normalized admission has no capture parent");
    }
    return null;
  }

  const captureIds: string[] = [];
  const conversionIds: string[] = [];
  const admissionIds: string[] = [];
  const bindingIds: string[] = [];
  const conversions = new Map<string, {
    readonly operation_id: string;
    readonly content_sha256: string;
    readonly normalized_content_sha256?: string;
    readonly output_object_key: string;
    readonly receipt_object_key: string;
    readonly capture_id: string;
  }>();
  const admissions = new Map<string, { readonly conversion_operation_id: string; readonly capture_id: string }>();
  const objectKeys = new Set<string>();
  let nextReviewAt: string | undefined;
  let rawRowCount = 0;
  const countRawRow = (): void => {
    rawRowCount += 1;
    if (rawRowCount > ROW_LIMIT) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "raw ingest dependency inventory exceeds its bounded closure");
  };

  for (const row of captures) {
    countRawRow();
    const capture = validateCapture(row, source);
    if (captureIds.includes(capture.capture_id)) erasureFail("ERASURE_IDENTITY_CONFLICT", "duplicate raw capture identity");
    captureIds.push(capture.capture_id);
    objectKeys.add(capture.object_key);
    timestamp(row.updated_at, "raw capture updated_at");
    if (row.state === "INTENT") nextReviewAt = earliest(nextReviewAt, capture.expires_at);

    const conversionRows = boundedRows(
      await database.prepare(
        `SELECT operation_id,principal_ref,capture_id,content_sha256,state,result_json,result_sha256,output_object_key,` +
        `receipt_object_key,updated_at FROM raw_markdown_conversion WHERE capture_id=?1 ` +
        `ORDER BY operation_id LIMIT ${FETCH_LIMIT}`,
    ).bind(capture.capture_id).all<ConversionRow>(),
      "raw conversion inventory",
    );
    for (const conversionRow of conversionRows) {
      countRawRow();
      const conversion = await validateConversion(conversionRow, capture);
      timestamp(conversionRow.updated_at, "raw conversion updated_at");
      if (conversions.has(conversion.operation_id)) erasureFail("ERASURE_IDENTITY_CONFLICT", "duplicate raw conversion identity");
      conversions.set(conversion.operation_id, { ...conversion, capture_id: capture.capture_id });
      conversionIds.push(conversion.operation_id);
      objectKeys.add(conversion.output_object_key);
      objectKeys.add(conversion.receipt_object_key);
      if (conversionRow.state === "STARTED" || conversionRow.state === "UNKNOWN") {
        nextReviewAt = earliest(nextReviewAt, capture.expires_at);
      }
    }

    const admissionRows = boundedRows(
      await database.prepare(
        `SELECT admission_operation_id,principal_ref,capture_id,conversion_operation_id,source_revision_ref,` +
        `state,updated_at,expires_at FROM raw_normalized_admission WHERE capture_id=?1 ` +
        `ORDER BY admission_operation_id LIMIT ${FETCH_LIMIT}`,
      ).bind(capture.capture_id).all<AdmissionRow>(),
      "raw normalized admission inventory",
    );
    for (const admissionRow of admissionRows) {
      countRawRow();
      const admissionId = assertErasureSha256(admissionRow.admission_operation_id, "raw admission operation ID");
      const admissionCapture = assertErasureIdentifier(admissionRow.capture_id, "raw admission capture ID");
      const admissionPrincipal = assertErasureIdentifier(admissionRow.principal_ref, "raw admission principal");
      const admissionSource = assertErasureIdentifier(admissionRow.source_revision_ref, "raw admission source revision");
      const conversionId = assertErasureSha256(admissionRow.conversion_operation_id, "raw admission conversion ID");
      const conversion = conversions.get(conversionId);
      if (admissionCapture !== capture.capture_id || admissionPrincipal !== capture.principal_ref || admissionSource !== source.source_revision_ref || conversion === undefined) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "raw admission is bound to a different raw chain");
      }
      if (admissionRow.state !== "PREPARING" && admissionRow.state !== "UPLOAD_REQUIRED" && admissionRow.state !== "VERIFIED" &&
          admissionRow.state !== "AUTHORIZED" && admissionRow.state !== "PROMOTED" && admissionRow.state !== "COMMITTED" &&
          admissionRow.state !== "QUARANTINED" && admissionRow.state !== "REJECTED" && admissionRow.state !== "UNKNOWN") {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "raw normalized admission state is invalid");
      }
      if (admissionRow.state === "COMMITTED" && conversion.normalized_content_sha256 !== source.content_sha256) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "committed raw admission lacks the source normalized output witness");
      }
      timestamp(admissionRow.updated_at, "raw admission updated_at");
      const expiresAt = timestamp(admissionRow.expires_at, "raw admission expiry");
      if (admissions.has(admissionId)) erasureFail("ERASURE_IDENTITY_CONFLICT", "duplicate raw admission identity");
      admissions.set(admissionId, { conversion_operation_id: conversionId, capture_id: capture.capture_id });
      admissionIds.push(admissionId);
      if (!["COMMITTED", "QUARANTINED", "REJECTED"].includes(String(admissionRow.state))) nextReviewAt = earliest(nextReviewAt, expiresAt);
    }

    const bindingRows = boundedRows(
      await database.prepare(
        `SELECT binding_id,principal_ref,capture_id,capture_content_sha256,conversion_operation_id,admission_operation_id,state,` +
        `created_at,updated_at FROM workspace_mcp_raw_normalized_admission WHERE capture_id=?1 ` +
        `ORDER BY binding_id LIMIT ${FETCH_LIMIT}`,
      ).bind(capture.capture_id).all<WorkspaceBindingRow>(),
      "workspace raw admission inventory",
    );
    for (const bindingRow of bindingRows) {
      countRawRow();
      const bindingId = assertErasureSha256(bindingRow.binding_id, "workspace raw binding ID");
      const bindingPrincipal = assertErasureIdentifier(bindingRow.principal_ref, "workspace raw binding principal");
      const bindingCapture = assertErasureIdentifier(bindingRow.capture_id, "workspace raw binding capture ID");
      const bindingContentSha = assertErasureSha256(bindingRow.capture_content_sha256, "workspace raw binding content digest");
      const bindingConversion = assertErasureSha256(bindingRow.conversion_operation_id, "workspace raw binding conversion ID");
      const bindingAdmission = bindingRow.admission_operation_id === null || bindingRow.admission_operation_id === undefined
        ? undefined
        : assertErasureSha256(bindingRow.admission_operation_id, "workspace raw binding admission ID");
      if (bindingPrincipal !== capture.principal_ref || bindingCapture !== capture.capture_id || bindingContentSha !== capture.content_sha256 || !conversions.has(bindingConversion) ||
          (bindingAdmission !== undefined && !admissions.has(bindingAdmission)) ||
          (bindingRow.state === "RESERVED" && bindingAdmission !== undefined) ||
          (bindingRow.state === "BOUND" && bindingAdmission === undefined)) {
        erasureFail("ERASURE_IDENTITY_CONFLICT", "workspace raw binding is bound to a different raw chain");
      }
      if (bindingRow.state !== "RESERVED" && bindingRow.state !== "BOUND") erasureFail("ERASURE_IDENTITY_CONFLICT", "workspace raw binding state is invalid");
      timestamp(bindingRow.created_at, "workspace raw binding created_at");
      timestamp(bindingRow.updated_at, "workspace raw binding updated_at");
      if (bindingIds.includes(bindingId)) erasureFail("ERASURE_IDENTITY_CONFLICT", "duplicate workspace raw binding identity");
      bindingIds.push(bindingId);
      if (bindingRow.state === "RESERVED") nextReviewAt = earliest(nextReviewAt, capture.expires_at);
    }
  }

  const blobs = [...objectKeys].sort(compare).map((objectKey) => ({ object_key: objectKey, shared_live_reference_count: 0 }));
  for (const blob of blobs) {
    blob.shared_live_reference_count = await referencesForKey(
      database,
      blob.object_key,
      input.selected_source_revision_refs,
    );
  }
  const pending = await pendingState(source.source_revision_ref, nextReviewAt);
  return {
    source_revision_ref: source.source_revision_ref,
    d1_canonical_ref: `d1-core:raw-ingest:${source.source_revision_ref}`,
    capture_ids: captureIds.sort(compare),
    conversion_operation_ids: conversionIds.sort(compare),
    admission_operation_ids: admissionIds.sort(compare),
    workspace_binding_ids: bindingIds.sort(compare),
    blobs,
    ...(pending === undefined ? {} : { pending }),
  };
}
