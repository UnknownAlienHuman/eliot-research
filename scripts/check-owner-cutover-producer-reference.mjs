import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createServer } from "vite";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_CUTOVER_FIXTURE = join(
  REPO_ROOT,
  "crates",
  "eliotr-test-vectors",
  "fixtures",
  "owner-cutover-canonical.v1.txt",
);

function fail(message) {
  throw new Error(`owner-cutover producer reference: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeHex(value, label) {
  if (!/^(?:[a-f0-9]{2})*$/u.test(value)) {
    fail(`${label} is not lowercase even-length hex`);
  }
  return Buffer.from(value, "hex");
}

function parseCases(source) {
  const lines = source.trimEnd().split(/\r?\n/u);
  const expectedHeaders = [
    "# protocol=eliotr.test-vectors.canonical-body.v1",
    "# schema_generation=1",
    "# columns=case_id|operation|input_hex|expected|output_hex|error_code",
  ];
  for (let index = 0; index < expectedHeaders.length; index += 1) {
    if (lines[index] !== expectedHeaders[index]) {
      fail(`fixture header ${index + 1} does not match canonical-body.v1`);
    }
  }

  const cases = new Map();
  for (const [offset, line] of lines.slice(expectedHeaders.length).entries()) {
    const columns = line.split("|");
    if (columns.length !== 6) {
      fail(`fixture line ${offset + expectedHeaders.length + 1} has ${columns.length} columns`);
    }
    const [caseId, operation, inputHex, expected, outputHex, errorCode] = columns;
    if (cases.has(caseId)) fail(`duplicate fixture case ${caseId}`);
    cases.set(caseId, { caseId, operation, inputHex, expected, outputHex, errorCode });
  }
  return cases;
}

function requireCase(cases, caseId) {
  const vector = cases.get(caseId);
  if (vector === undefined) fail(`missing retained case ${caseId}`);
  return vector;
}

function requireError(result, code, label) {
  if (result.ok || result.error.code !== code) {
    fail(`${label} expected ${code}, received ${result.ok ? "success" : result.error.code}`);
  }
  return { code: result.error.code, message: result.error.message };
}

export async function verifyOwnerCutoverProducerReference() {
  const server = await createServer({
    configFile: false,
    root: REPO_ROOT,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true, watch: null },
    ssr: { noExternal: [/^@eliotr\//u] },
  });

  try {
    return await verifyOwnerCutoverProducerReferenceWithServer(server);
  } finally {
    await server.close();
  }
}

async function verifyOwnerCutoverProducerReferenceWithServer(server) {
  const [contract, registry, contractValidation, domain] = await Promise.all([
    server.ssrLoadModule(resolve(REPO_ROOT, "packages", "contracts", "src", "owner-cutover.ts")),
    server.ssrLoadModule(resolve(REPO_ROOT, "packages", "contracts", "src", "schema-registry.ts")),
    server.ssrLoadModule(resolve(REPO_ROOT, "packages", "contracts", "src", "validation", "cross-field.ts")),
    server.ssrLoadModule(resolve(REPO_ROOT, "packages", "domain", "src", "owner-cutover.ts")),
  ]);
  const source = readFileSync(OWNER_CUTOVER_FIXTURE, "utf8");
  const cases = parseCases(source);
  const producerCaseIds = [
    "owner_cutover_fenced_shuffled",
    "owner_cutover_fenced_idempotent",
    "owner_cutover_fenced_second_order",
    "owner_cutover_retired_unicode",
  ];
  const producerResults = producerCaseIds.map((caseId) => {
    const vector = requireCase(cases, caseId);
    if (vector.operation !== "canonicalize_json" || vector.expected !== "ok") {
      fail(`${caseId} must remain an accepted canonicalize_json vector`);
    }
    const input = decodeHex(vector.inputHex, `${caseId} input_hex`);
    const parsedInput = JSON.parse(input.toString("utf8"));
    const receipt = contract.SourceOwnerCutoverReceiptSchema.parse(parsedInput);
    const produced = Buffer.from(
      registry.serializeCanonicalContractJson(receipt),
      "utf8",
    );
    const literalOracle = decodeHex(vector.outputHex, `${caseId} output_hex`);
    if (!produced.equals(literalOracle)) {
      fail(`${caseId} TypeScript producer bytes differ from the committed literal oracle`);
    }
    return {
      caseId,
      inputBytes: input.length,
      inputSha256: sha256(input),
      admittedBy: "SourceOwnerCutoverReceiptSchema",
      producer: "serializeCanonicalContractJson",
      outputBytes: produced.length,
      outputSha256: sha256(produced),
      literalOracleBytes: literalOracle.length,
      literalOracleSha256: sha256(literalOracle),
      result: "MATCH",
    };
  });

  for (const caseId of [
    "owner_cutover_duplicate_protocol",
    "owner_cutover_duplicate_nested_digest",
  ]) {
    const vector = requireCase(cases, caseId);
    if (
      vector.operation !== "canonicalize_json" ||
      vector.expected !== "error" ||
      vector.errorCode !== "ELIOTR_JSON_DUPLICATE_KEY"
    ) {
      fail(`${caseId} duplicate-key error fixture changed`);
    }
  }

  const acceptedReceipt = contract.SourceOwnerCutoverReceiptSchema.parse(
    JSON.parse(
      decodeHex(
        requireCase(cases, producerCaseIds[0]).inputHex,
        `${producerCaseIds[0]} input_hex`,
      ).toString("utf8"),
    ),
  );
  const contractFields = {
    protocol: acceptedReceipt.protocol,
    cutover: acceptedReceipt.cutover,
    old_owner: acceptedReceipt.old_owner,
    new_owner: acceptedReceipt.new_owner,
    authorization: acceptedReceipt.authorization,
  };
  if (contractValidation.validateSourceOwnerCutover(contractFields).length !== 0) {
    fail("accepted receipt failed the existing cross-field validator");
  }
  const contractSourceSetIssues = contractValidation.validateSourceOwnerCutover({
    ...contractFields,
    new_owner: {
      ...acceptedReceipt.new_owner,
      admitted_revision_set_digest: "c".repeat(64),
    },
  });
  if (!contractSourceSetIssues.some((issue) => issue.code === "CUTOVER_REVISION_SET_MISMATCH")) {
    fail("existing cross-field source-set negative no longer rejects");
  }

  const oldOwnerRecord = {
    source_namespace_id: acceptedReceipt.cutover.source_namespace_id,
    owner_system_id: acceptedReceipt.old_owner.owner_system_id,
    status: acceptedReceipt.old_owner.terminal_status,
    source_owner_generation: acceptedReceipt.old_owner.source_owner_generation_before_fence,
  };
  const newOwnerRecord = {
    source_namespace_id: acceptedReceipt.cutover.source_namespace_id,
    owner_system_id: acceptedReceipt.new_owner.owner_system_id,
    status: "ACTIVE",
    source_owner_generation: acceptedReceipt.new_owner.source_owner_generation_after_activation,
  };
  const context = {
    expectedIdentityMappingDigest: acceptedReceipt.cutover.identity_mapping_digest,
    expectedFinalSourceViewRef: acceptedReceipt.old_owner.final_source_view_ref,
  };
  const domainValidation = domain.validateSourceOwnerCutover;
  const acceptedDomainResult = domainValidation(acceptedReceipt, {
    oldOwnerRecord,
    newOwnerRecord,
    ...context,
  });
  if (!acceptedDomainResult.ok) {
    fail(`accepted receipt failed domain validation: ${acceptedDomainResult.error.code}`);
  }
  const domainSourceSetError = requireError(
    domainValidation(
      {
        ...acceptedReceipt,
        new_owner: {
          ...acceptedReceipt.new_owner,
          admitted_revision_set_digest: "c".repeat(64),
        },
      },
      { oldOwnerRecord, newOwnerRecord, ...context },
    ),
    "REVISION_SET_MISMATCH",
    "domain source-set negative",
  );
  const domainFinalViewError = requireError(
    domainValidation(acceptedReceipt, {
      oldOwnerRecord,
      newOwnerRecord,
      ...context,
      expectedFinalSourceViewRef: "view-deliberately-different",
    }),
    "CUTOVER_RECEIPT_INVALID",
    "domain final-view negative",
  );
  if (domainFinalViewError.message !== "final source view mismatch") {
    fail("domain final-view error message changed");
  }

  console.log(JSON.stringify({
    ownerCutoverProducerReference: "PASS",
    fixtureBytes: Buffer.byteLength(source, "utf8"),
    fixtureSha256: sha256(Buffer.from(source, "utf8")),
    producerCases: producerResults,
    retainedDuplicateErrors: [
      "owner_cutover_duplicate_protocol:ELIOTR_JSON_DUPLICATE_KEY",
      "owner_cutover_duplicate_nested_digest:ELIOTR_JSON_DUPLICATE_KEY",
    ],
    semanticNegatives: {
      contractSourceSet: contractSourceSetIssues
        .filter((issue) => issue.code === "CUTOVER_REVISION_SET_MISMATCH")
        .map(({ code, path, message }) => ({ code, path, message })),
      domainSourceSet: domainSourceSetError,
      domainFinalView: domainFinalViewError,
    },
    rustExecution: "NOT RUN; this invocation compared TypeScript producer bytes with committed literals; native/Wasm gates remain pending",
  }, null, 2));
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await verifyOwnerCutoverProducerReference();
}
