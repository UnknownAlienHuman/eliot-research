import { TextDecoder, TextEncoder } from "node:util";

export const PROTOCOL_HEADER = "# protocol=eliotr.test-vectors.scope-snapshot-identity.v1";
export const GENERATION_HEADER = "# schema_generation=1";
export const COLUMNS_HEADER =
  "# columns=case_id|operation|input_hex|expected|output_hex|error_code";

export const FRAME_BYTES = 1024 * 1024;
export const FRAME_CASES = 4096;
export const CASE_ID_BYTES = 128;
export const VECTOR_PAYLOAD_BYTES = 256 * 1024;

export const PROTOCOL = "eliotr.scope-snapshot.v1";
export const ID_PREFIX = "scope-";
export const ID_HEX_CHARS = 48;
export const ID_BYTES = ID_PREFIX.length + ID_HEX_CHARS;
export const INPUT_MAX_BYTES = 2 * 1024 * 1024;
export const OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const STRING_MAX_BYTES = 4096;
export const PARSER_DEPTH_MAX = 64;
export const OBJECT_MEMBERS_MAX = 51_000;
export const ARRAY_ITEMS_MAX = 50_000;
export const NODES_MAX = 250_000;
export const SAFE_INTEGER_MAX = 9_007_199_254_740_991;
export const SCOPE_DEPTH_MAX = 32;
export const SCOPE_ATOMS_MAX = 256;
export const SELECTED_SOURCES_MAX = 1_000;
export const MEMBERS_MAX = 50_000;
export const PARTICIPANTS_MAX = 257;
export const IDENTIFIER_MAX_UTF16 = 256;

export const CODES = Object.freeze({
  inputTooLarge: "ELIOTR_SNAPSHOT_INPUT_TOO_LARGE",
  utf8: "ELIOTR_SNAPSHOT_UTF8",
  syntax: "ELIOTR_SNAPSHOT_SYNTAX",
  duplicateKey: "ELIOTR_SNAPSHOT_DUPLICATE_KEY",
  unicode: "ELIOTR_SNAPSHOT_UNICODE",
  number: "ELIOTR_SNAPSHOT_NUMBER",
  depthLimit: "ELIOTR_SNAPSHOT_DEPTH_LIMIT",
  memberLimit: "ELIOTR_SNAPSHOT_MEMBER_LIMIT",
  nodeLimit: "ELIOTR_SNAPSHOT_NODE_LIMIT",
  stringTooLarge: "ELIOTR_SNAPSHOT_STRING_TOO_LARGE",
  outputTooLarge: "ELIOTR_SNAPSHOT_OUTPUT_TOO_LARGE",
  shape: "ELIOTR_SNAPSHOT_SHAPE",
  missingField: "ELIOTR_SNAPSHOT_MISSING_FIELD",
  unknownField: "ELIOTR_SNAPSHOT_UNKNOWN_FIELD",
  identifier: "ELIOTR_SNAPSHOT_IDENTIFIER",
  digest: "ELIOTR_SNAPSHOT_DIGEST",
  revision: "ELIOTR_SNAPSHOT_REVISION",
  timestamp: "ELIOTR_SNAPSHOT_TIMESTAMP",
  expression: "ELIOTR_SNAPSHOT_EXPRESSION",
  idMismatch: "ELIOTR_SNAPSHOT_ID_MISMATCH",
  digestMismatch: "ELIOTR_SNAPSHOT_DIGEST_MISMATCH",
});
export const DERIVE_CODES = new Set([
  CODES.inputTooLarge,
  CODES.utf8,
  CODES.syntax,
  CODES.duplicateKey,
  CODES.unicode,
  CODES.number,
  CODES.depthLimit,
  CODES.memberLimit,
  CODES.nodeLimit,
  CODES.stringTooLarge,
  CODES.outputTooLarge,
  CODES.shape,
  CODES.missingField,
  CODES.unknownField,
  CODES.identifier,
  CODES.digest,
  CODES.revision,
  CODES.timestamp,
  CODES.expression,
]);
export const VERIFY_CODES = new Set([...DERIVE_CODES, CODES.idMismatch, CODES.digestMismatch]);
export const ALL_CODES = new Set([...VERIFY_CODES]);
export const OPERATIONS = new Set(["derive_snapshot_identity", "verify_snapshot_identity"]);
export const encoder = new TextEncoder();
export const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
