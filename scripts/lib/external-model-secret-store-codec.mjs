import { createHash } from "node:crypto";

const API_ORIGIN = "https://api.cloudflare.com";
const GATEWAY_ID = "eliotr-reasoning";
const MAX_SECRET_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ACCOUNT_ID = /^[a-f0-9]{32}$/iu;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,32}$/u;
const PROVIDER_SLUG = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const INPUT_KEYS = new Set([
  "alias", "operation", "operation_id", "protocol", "provider_slug", "secret_id",
]);
const STORE_KEYS = new Set(["account_id", "created", "id", "modified", "name"]);
const SECRET_KEYS = new Set([
  "comment", "created", "id", "modified", "name", "scopes", "status", "store_id",
]);
const ENVELOPE_KEYS = new Set(["errors", "messages", "result", "result_info", "success"]);
const PAGINATION_KEYS = new Set(["count", "page", "per_page", "total_count", "total_pages"]);
const ALLOWED_SCOPES = new Set([
  "access", "ai_gateway", "containers", "dex", "websearch", "workers",
]);

export const EXTERNAL_MODEL_SECRET_STORE_NAME = "eliotr-ai-gateway";
export const EXTERNAL_MODEL_SECRET_SCOPE = Object.freeze(["ai_gateway"]);
export const EXTERNAL_MODEL_SECRET_PAGE_SIZE = 100;
export const EXTERNAL_MODEL_SECRET_MAX_PAGES = 100;

export class ExternalModelSecretStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExternalModelSecretStoreError";
    this.code = code;
    this.effect = options.effect ?? "NONE";
    this.retryable = options.retryable ?? false;
    if (options.http_status !== undefined) this.http_status = options.http_status;
  }
}

export function externalModelSecretStoreFail(code, message, options) {
  throw new ExternalModelSecretStoreError(code, message, options);
}

function plainObject(value, label, allowed, code, effect) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    externalModelSecretStoreFail(code, `${label} must be an object`, { effect });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    externalModelSecretStoreFail(code, `${label} must be a plain object`, { effect });
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      externalModelSecretStoreFail(code, `${label} cannot contain accessors`, { effect });
    }
    if (allowed !== undefined && !allowed.has(key)) {
      externalModelSecretStoreFail(code, `${label} contains unsupported field ${key}`, { effect });
    }
  }
  return value;
}

function boundedString(value, label, maximum, code, effect, pattern) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value) || (pattern !== undefined && !pattern.test(value))) {
    externalModelSecretStoreFail(code, `${label} is invalid`, { effect });
  }
  return value;
}

function resourceId(value, label, code, effect) {
  return boundedString(value, label, 32, code, effect, RESOURCE_ID).toLowerCase();
}

function timestamp(value, label, effect) {
  const observed = boundedString(
    value,
    label,
    64,
    "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
    effect,
  );
  if (!Number.isFinite(Date.parse(observed))) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      `${label} is invalid`,
      { effect },
    );
  }
  return observed;
}

function nonNegativeInteger(value, label, effect) {
  if (!Number.isSafeInteger(value) || value < 0) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      `${label} is invalid`,
      { effect },
    );
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      externalModelSecretStoreFail("EXTERNAL_MODEL_SECRET_INTERNAL", "Non-finite canonical number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = plainObject(
    value,
    "canonical value",
    undefined,
    "EXTERNAL_MODEL_SECRET_INTERNAL",
    "NONE",
  );
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function externalModelSecretMetadataSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function parseExternalModelSecretInput(raw) {
  const input = plainObject(
    raw,
    "external model secret input",
    INPUT_KEYS,
    "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
    "NONE",
  );
  if (input.protocol !== "eliotr.external-model-secret.v1") {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
      "External model secret protocol is unsupported",
    );
  }
  if (input.operation !== "CREATE" && input.operation !== "ROTATE") {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
      "External model secret operation is invalid",
    );
  }
  const providerSlug = boundedString(
    input.provider_slug,
    "provider slug",
    96,
    "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
    "NONE",
    PROVIDER_SLUG,
  );
  const alias = boundedString(
    input.alias,
    "provider alias",
    64,
    "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
    "NONE",
    ALIAS,
  );
  const operationId = boundedString(
    input.operation_id,
    "operation ID",
    128,
    "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
    "NONE",
    OPERATION_ID,
  );
  const name = `${GATEWAY_ID}_${providerSlug}_${alias}`;
  if (name.length > 256) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
      "Derived secret name exceeds its bound",
    );
  }
  const secretId = input.secret_id === undefined
    ? null
    : resourceId(
        input.secret_id,
        "secret ID",
        "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
        "NONE",
      );
  if ((input.operation === "ROTATE") !== (secretId !== null)) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_INPUT_INVALID",
      "ROTATE requires secret_id and CREATE forbids it",
    );
  }
  return Object.freeze({
    operation: input.operation,
    operation_id: operationId,
    provider_slug: providerSlug,
    alias,
    secret_id: secretId,
    secret_name: name,
    marker: `eliotr:external-model-secret:${input.operation.toLowerCase()}:${operationId}`,
  });
}

export function validateExternalModelSecretAccount(value) {
  return boundedString(
    value,
    "Cloudflare account ID",
    32,
    "EXTERNAL_MODEL_SECRET_ACCOUNT_INVALID",
    "NONE",
    ACCOUNT_ID,
  ).toLowerCase();
}

export function validateExternalModelSecretValue(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_VALUE_INVALID",
      "Provider key must be a non-empty control-free string without surrounding whitespace",
    );
  }
  if (new TextEncoder().encode(value).byteLength > MAX_SECRET_BYTES) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_VALUE_INVALID",
      "Provider key exceeds 65536 UTF-8 bytes",
    );
  }
  return value;
}

export function validateExternalModelSecretBearer(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 ||
      value !== value.trim() || /\s/u.test(value) || value.toLowerCase().startsWith("bearer")) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_CREDENTIAL_INVALID",
      "Cloudflare credential is invalid",
    );
  }
  return value;
}

export function decodeExternalModelSecretStore(raw, expectedAccount, effect) {
  const value = plainObject(
    raw,
    "Secrets Store readback",
    STORE_KEYS,
    "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
    effect,
  );
  const observedAccount = value.account_id === undefined
    ? expectedAccount
    : boundedString(
        value.account_id,
        "Secrets Store account ID",
        32,
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        effect,
        ACCOUNT_ID,
      ).toLowerCase();
  if (observedAccount !== expectedAccount) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_READBACK_MISMATCH",
      "Secrets Store belongs to another account",
      { effect },
    );
  }
  return Object.freeze({
    id: resourceId(
      value.id,
      "Secrets Store ID",
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      effect,
    ),
    account_id: observedAccount,
    name: boundedString(
      value.name,
      "Secrets Store name",
      256,
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      effect,
    ),
    created: timestamp(value.created, "Secrets Store created timestamp", effect),
    modified: timestamp(value.modified, "Secrets Store modified timestamp", effect),
  });
}

function decodeScopes(raw, effect) {
  if (!Array.isArray(raw) || raw.length > ALLOWED_SCOPES.size ||
      raw.some((scope) => typeof scope !== "string" || !ALLOWED_SCOPES.has(scope))) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      "Secret scopes are invalid",
      { effect },
    );
  }
  const scopes = [...raw];
  if (new Set(scopes).size !== scopes.length) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      "Secret scopes contain duplicates",
      { effect },
    );
  }
  return Object.freeze(scopes.sort());
}

export function decodeExternalModelSecret(raw, expectedStoreId, effect) {
  const value = plainObject(
    raw,
    "Secrets Store secret readback",
    SECRET_KEYS,
    "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
    effect,
  );
  const storeId = resourceId(
    value.store_id,
    "secret store ID",
    "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
    effect,
  );
  if (storeId !== expectedStoreId) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_READBACK_MISMATCH",
      "Secret belongs to another store",
      { effect },
    );
  }
  if (value.status !== "pending" && value.status !== "active" && value.status !== "deleted") {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      "Secret status is invalid",
      { effect },
    );
  }
  return Object.freeze({
    id: resourceId(
      value.id,
      "secret ID",
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      effect,
    ),
    store_id: storeId,
    name: boundedString(
      value.name,
      "secret name",
      256,
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      effect,
    ),
    comment: value.comment === undefined
      ? ""
      : boundedString(
          value.comment,
          "secret comment",
          1024,
          "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
          effect,
        ),
    scopes: decodeScopes(value.scopes ?? [], effect),
    status: value.status,
    created: timestamp(value.created, "secret created timestamp", effect),
    modified: timestamp(value.modified, "secret modified timestamp", effect),
  });
}

export function requireExternalModelSecretMetadata(secret, desired, effect) {
  if (secret.name !== desired.secret_name || secret.comment !== desired.marker ||
      secret.scopes.length !== 1 || secret.scopes[0] !== "ai_gateway" ||
      secret.status === "deleted") {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_EXISTING_CONFLICT",
      "Secret identity exists with different metadata",
      { effect },
    );
  }
}

export function decodeExternalModelSecretPagination(raw, requestedPage, observedCount, effect) {
  if (raw === undefined || raw === null) {
    if (observedCount === EXTERNAL_MODEL_SECRET_PAGE_SIZE) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Pagination metadata is required for a full page",
        { effect },
      );
    }
    return Object.freeze({ total_pages: requestedPage, total_count: observedCount });
  }
  const value = plainObject(
    raw,
    "Secrets Store pagination",
    PAGINATION_KEYS,
    "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
    effect,
  );
  const page = nonNegativeInteger(value.page, "pagination page", effect);
  const perPage = nonNegativeInteger(value.per_page, "pagination per_page", effect);
  const totalPages = nonNegativeInteger(value.total_pages, "pagination total_pages", effect);
  const totalCount = nonNegativeInteger(value.total_count, "pagination total_count", effect);
  if (page !== requestedPage || perPage > EXTERNAL_MODEL_SECRET_PAGE_SIZE ||
      totalPages > EXTERNAL_MODEL_SECRET_MAX_PAGES || totalCount > 10_000 ||
      (totalPages !== 0 && totalPages < requestedPage)) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      "Secrets Store pagination is inconsistent",
      { effect },
    );
  }
  return Object.freeze({ total_pages: totalPages, total_count: totalCount });
}

export function createExternalModelSecretRestClient({ account, token, fetchImpl }) {
  const accountBase = `${API_ORIGIN}/client/v4/accounts/${account}/secrets_store`;
  return Object.freeze({
    accountBase,
    async request(method, url, body, effect) {
      const bodyJson = body === undefined ? undefined : canonicalJson(body);
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(bodyJson === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(bodyJson === undefined ? {} : { body: bodyJson }),
          redirect: "error",
        });
      } catch {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_TRANSPORT_FAILED",
          "Cloudflare Secrets Store request failed",
          { effect, retryable: true },
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_RESPONSE_TOO_LARGE",
          "Cloudflare Secrets Store response exceeds 1 MiB",
          { effect, http_status: response.status },
        );
      }
      let bytes;
      try { bytes = new Uint8Array(await response.arrayBuffer()); }
      catch (cause) {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
          "Cloudflare Secrets Store response could not be read",
          { effect, http_status: response.status, cause },
        );
      }
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_RESPONSE_TOO_LARGE",
          "Cloudflare Secrets Store response exceeds 1 MiB",
          { effect, http_status: response.status },
        );
      }
      let raw;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch (cause) {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
          "Cloudflare Secrets Store response is not valid JSON",
          { effect, http_status: response.status, cause },
        );
      }
      const envelope = plainObject(
        raw,
        "Cloudflare API envelope",
        ENVELOPE_KEYS,
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        effect,
      );
      if (!response.ok || envelope.success !== true) {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_HTTP_FAILED",
          "Cloudflare Secrets Store API rejected the request",
          {
            effect,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            http_status: response.status,
          },
        );
      }
      return Object.freeze({ result: envelope.result, result_info: envelope.result_info });
    },
  });
}
