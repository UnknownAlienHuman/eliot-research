import {
  createExternalModelSecretRestClient,
  decodeExternalModelSecret,
  decodeExternalModelSecretPagination,
  decodeExternalModelSecretStore,
  EXTERNAL_MODEL_SECRET_MAX_PAGES,
  EXTERNAL_MODEL_SECRET_PAGE_SIZE,
  EXTERNAL_MODEL_SECRET_SCOPE,
  EXTERNAL_MODEL_SECRET_STORE_NAME,
  ExternalModelSecretStoreError,
  externalModelSecretMetadataSha256,
  externalModelSecretStoreFail,
  parseExternalModelSecretInput,
  requireExternalModelSecretMetadata,
  validateExternalModelSecretAccount,
  validateExternalModelSecretBearer,
  validateExternalModelSecretValue,
} from "./external-model-secret-store-codec.mjs";

export { ExternalModelSecretStoreError } from "./external-model-secret-store-codec.mjs";

async function listStores(client, account, effect) {
  const stores = [];
  const seen = new Set();
  let expectedPages = 1;
  let expectedTotal;
  for (let page = 1; page <= expectedPages; page += 1) {
    if (page > EXTERNAL_MODEL_SECRET_MAX_PAGES) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Secrets Store pagination exceeds its bound",
        { effect },
      );
    }
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(EXTERNAL_MODEL_SECRET_PAGE_SIZE),
    });
    const envelope = await client.request(
      "GET",
      `${client.accountBase}/stores?${query.toString()}`,
      undefined,
      effect,
    );
    if (!Array.isArray(envelope.result)) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Secrets Store list result must be an array",
        { effect },
      );
    }
    const observed = envelope.result.map((entry) =>
      decodeExternalModelSecretStore(entry, account, effect),
    );
    const pagination = decodeExternalModelSecretPagination(
      envelope.result_info,
      page,
      observed.length,
      effect,
    );
    if (page === 1) {
      expectedPages = Math.max(1, pagination.total_pages);
      expectedTotal = pagination.total_count;
    } else if (pagination.total_pages !== expectedPages ||
               pagination.total_count !== expectedTotal) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Secrets Store pagination changed during traversal",
        { effect },
      );
    }
    for (const store of observed) {
      if (seen.has(store.id)) {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
          "Secrets Store list contains duplicate IDs",
          { effect },
        );
      }
      seen.add(store.id);
      stores.push(store);
    }
  }
  if (stores.length > 1) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      "Account exposes more than one Secrets Store",
      { effect },
    );
  }
  return Object.freeze(stores);
}

async function getStore(client, account, storeId, effect) {
  const envelope = await client.request(
    "GET",
    `${client.accountBase}/stores/${encodeURIComponent(storeId)}`,
    undefined,
    effect,
  );
  return decodeExternalModelSecretStore(envelope.result, account, effect);
}

function requireManagedStoreName(store, effect) {
  if (store.name !== EXTERNAL_MODEL_SECRET_STORE_NAME) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_READBACK_MISMATCH",
      "Created Secrets Store has an unexpected name",
      { effect },
    );
  }
}

async function ensureStore(client, account) {
  const existing = await listStores(client, account, "NONE");
  if (existing.length === 1) {
    return Object.freeze({ store: existing[0], disposition: "EXISTING_STORE" });
  }
  try {
    const envelope = await client.request(
      "POST",
      `${client.accountBase}/stores`,
      { name: EXTERNAL_MODEL_SECRET_STORE_NAME },
      "STORE_CREATE",
    );
    const acknowledged = decodeExternalModelSecretStore(
      envelope.result,
      account,
      "STORE_CREATE",
    );
    requireManagedStoreName(acknowledged, "STORE_CREATE");
    const readback = await getStore(client, account, acknowledged.id, "STORE_CREATE");
    requireManagedStoreName(readback, "STORE_CREATE");
    return Object.freeze({ store: readback, disposition: "STORE_CREATED" });
  } catch (error) {
    if (!(error instanceof ExternalModelSecretStoreError) || error.effect !== "STORE_CREATE") {
      throw error;
    }
    try {
      const reconciled = await listStores(client, account, "STORE_CREATE");
      if (reconciled.length === 1) {
        requireManagedStoreName(reconciled[0], "STORE_CREATE");
        return Object.freeze({
          store: reconciled[0],
          disposition: "STORE_CREATE_RECONCILED",
        });
      }
    } catch (reconciliationError) {
      if (reconciliationError instanceof ExternalModelSecretStoreError &&
          reconciliationError.code === "EXTERNAL_MODEL_SECRET_READBACK_MISMATCH") {
        throw reconciliationError;
      }
    }
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_STORE_CREATE_UNCERTAIN",
      "Secrets Store create outcome could not be reconciled",
      { effect: "STORE_CREATE", retryable: true, cause: error },
    );
  }
}

function secretsBase(client, storeId) {
  return `${client.accountBase}/stores/${encodeURIComponent(storeId)}/secrets`;
}

async function listSecretsByName(client, storeId, name, effect) {
  const observed = [];
  const seen = new Set();
  let expectedPages = 1;
  let expectedTotal;
  for (let page = 1; page <= expectedPages; page += 1) {
    if (page > EXTERNAL_MODEL_SECRET_MAX_PAGES) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Secret pagination exceeds its bound",
        { effect },
      );
    }
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(EXTERNAL_MODEL_SECRET_PAGE_SIZE),
      search: name,
    });
    const envelope = await client.request(
      "GET",
      `${secretsBase(client, storeId)}?${query.toString()}`,
      undefined,
      effect,
    );
    if (!Array.isArray(envelope.result)) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Secret list result must be an array",
        { effect },
      );
    }
    const pageSecrets = envelope.result.map((entry) =>
      decodeExternalModelSecret(entry, storeId, effect),
    );
    const pagination = decodeExternalModelSecretPagination(
      envelope.result_info,
      page,
      pageSecrets.length,
      effect,
    );
    if (page === 1) {
      expectedPages = Math.max(1, pagination.total_pages);
      expectedTotal = pagination.total_count;
    } else if (pagination.total_pages !== expectedPages ||
               pagination.total_count !== expectedTotal) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Secret pagination changed during traversal",
        { effect },
      );
    }
    for (const secret of pageSecrets) {
      if (seen.has(secret.id)) {
        externalModelSecretStoreFail(
          "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
          "Secret list contains duplicate IDs",
          { effect },
        );
      }
      seen.add(secret.id);
      observed.push(secret);
    }
  }
  const matches = observed.filter((secret) =>
    secret.name === name && secret.status !== "deleted",
  );
  if (matches.length > 1) {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
      "Secret list contains duplicate active names",
      { effect },
    );
  }
  return matches[0] ?? null;
}

async function getSecret(client, storeId, secretId, effect) {
  const envelope = await client.request(
    "GET",
    `${secretsBase(client, storeId)}/${encodeURIComponent(secretId)}`,
    undefined,
    effect,
  );
  return decodeExternalModelSecret(envelope.result, storeId, effect);
}

async function requireActiveSecret(client, storeId, secret, desired, effect, sleep) {
  let observed = secret;
  for (let attempt = 0; attempt < 4 && observed.status === "pending"; attempt += 1) {
    await sleep(100 * (2 ** attempt));
    observed = await getSecret(client, storeId, observed.id, effect);
    requireExternalModelSecretMetadata(observed, desired, effect);
  }
  if (observed.status !== "active") {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_ACTIVATION_PENDING",
      "Secret exists but is not active",
      { effect, retryable: true },
    );
  }
  return observed;
}

async function createSecret(client, storeId, desired, value, sleep) {
  const existing = await listSecretsByName(client, storeId, desired.secret_name, "NONE");
  if (existing !== null) {
    requireExternalModelSecretMetadata(existing, desired, "NONE");
    return Object.freeze({
      secret: await requireActiveSecret(client, storeId, existing, desired, "NONE", sleep),
      disposition: "EXISTING_MATCH",
    });
  }
  try {
    const envelope = await client.request(
      "POST",
      secretsBase(client, storeId),
      [{
        name: desired.secret_name,
        scopes: EXTERNAL_MODEL_SECRET_SCOPE,
        value,
        comment: desired.marker,
      }],
      "SECRET_CREATE",
    );
    if (!Array.isArray(envelope.result) || envelope.result.length !== 1) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_RESPONSE_INVALID",
        "Secret create acknowledgement must contain one result",
        { effect: "SECRET_CREATE" },
      );
    }
    const acknowledged = decodeExternalModelSecret(
      envelope.result[0],
      storeId,
      "SECRET_CREATE",
    );
    requireExternalModelSecretMetadata(acknowledged, desired, "SECRET_CREATE");
    const readback = await getSecret(client, storeId, acknowledged.id, "SECRET_CREATE");
    requireExternalModelSecretMetadata(readback, desired, "SECRET_CREATE");
    return Object.freeze({
      secret: await requireActiveSecret(
        client,
        storeId,
        readback,
        desired,
        "SECRET_CREATE",
        sleep,
      ),
      disposition: "CREATED",
    });
  } catch (error) {
    if (!(error instanceof ExternalModelSecretStoreError) || error.effect !== "SECRET_CREATE") {
      throw error;
    }
    try {
      const observed = await listSecretsByName(
        client,
        storeId,
        desired.secret_name,
        "SECRET_CREATE",
      );
      if (observed !== null) {
        requireExternalModelSecretMetadata(observed, desired, "SECRET_CREATE");
        return Object.freeze({
          secret: await requireActiveSecret(
            client,
            storeId,
            observed,
            desired,
            "SECRET_CREATE",
            sleep,
          ),
          disposition: "CREATE_RECONCILED",
        });
      }
    } catch (reconciliationError) {
      if (reconciliationError instanceof ExternalModelSecretStoreError &&
          reconciliationError.code === "EXTERNAL_MODEL_SECRET_EXISTING_CONFLICT") {
        throw reconciliationError;
      }
    }
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_CREATE_UNCERTAIN",
      "Secret create outcome could not be reconciled",
      { effect: "SECRET_CREATE", retryable: true, cause: error },
    );
  }
}

async function rotateSecret(client, storeId, desired, value, sleep) {
  const before = await getSecret(client, storeId, desired.secret_id, "NONE");
  if (before.name !== desired.secret_name || before.scopes.length !== 1 ||
      before.scopes[0] !== "ai_gateway" || before.status !== "active") {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_EXISTING_CONFLICT",
      "Secret selected for rotation does not match the provider identity",
    );
  }
  if (before.comment === desired.marker) {
    return Object.freeze({ secret: before, disposition: "EXISTING_MATCH" });
  }
  try {
    const envelope = await client.request(
      "PATCH",
      `${secretsBase(client, storeId)}/${encodeURIComponent(before.id)}`,
      { comment: desired.marker, scopes: EXTERNAL_MODEL_SECRET_SCOPE, value },
      "SECRET_ROTATE",
    );
    const acknowledged = decodeExternalModelSecret(
      envelope.result,
      storeId,
      "SECRET_ROTATE",
    );
    if (acknowledged.id !== before.id) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_READBACK_MISMATCH",
        "Secret rotation acknowledgement changed identity",
        { effect: "SECRET_ROTATE" },
      );
    }
    requireExternalModelSecretMetadata(acknowledged, desired, "SECRET_ROTATE");
    const readback = await getSecret(client, storeId, before.id, "SECRET_ROTATE");
    requireExternalModelSecretMetadata(readback, desired, "SECRET_ROTATE");
    if (Date.parse(readback.modified) < Date.parse(before.modified)) {
      externalModelSecretStoreFail(
        "EXTERNAL_MODEL_SECRET_READBACK_MISMATCH",
        "Secret rotation readback moved backwards",
        { effect: "SECRET_ROTATE" },
      );
    }
    return Object.freeze({
      secret: await requireActiveSecret(
        client,
        storeId,
        readback,
        desired,
        "SECRET_ROTATE",
        sleep,
      ),
      disposition: "ROTATED",
    });
  } catch (error) {
    if (!(error instanceof ExternalModelSecretStoreError) || error.effect !== "SECRET_ROTATE") {
      throw error;
    }
    try {
      const observed = await getSecret(client, storeId, before.id, "SECRET_ROTATE");
      if (observed.comment === desired.marker) {
        requireExternalModelSecretMetadata(observed, desired, "SECRET_ROTATE");
        return Object.freeze({
          secret: await requireActiveSecret(
            client,
            storeId,
            observed,
            desired,
            "SECRET_ROTATE",
            sleep,
          ),
          disposition: "ROTATE_RECONCILED",
        });
      }
    } catch (reconciliationError) {
      if (reconciliationError instanceof ExternalModelSecretStoreError &&
          reconciliationError.code === "EXTERNAL_MODEL_SECRET_EXISTING_CONFLICT") {
        throw reconciliationError;
      }
    }
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_ROTATE_UNCERTAIN",
      "Secret rotation outcome could not be reconciled",
      { effect: "SECRET_ROTATE", retryable: true, cause: error },
    );
  }
}

function createReceipt(account, desired, storeResult, secretResult) {
  const secret = secretResult.secret;
  const metadata = Object.freeze({
    protocol: "eliotr.external-model-secret-metadata.v1",
    account_id: account,
    store_id: storeResult.store.id,
    secret_id: secret.id,
    secret_name: secret.name,
    operation: desired.operation,
    operation_id: desired.operation_id,
    scope: "ai_gateway",
    status: secret.status,
    observed_created_at: secret.created,
    observed_modified_at: secret.modified,
  });
  return Object.freeze({
    protocol: "eliotr.external-model-secret-receipt.v1",
    operation: desired.operation,
    disposition: secretResult.disposition,
    store_disposition: storeResult.disposition,
    account_id: account,
    store_id: storeResult.store.id,
    store_name: storeResult.store.name,
    secret_reference: Object.freeze({
      secret_id: secret.id,
      secret_name: secret.name,
    }),
    operation_id: desired.operation_id,
    scope: "ai_gateway",
    status: secret.status,
    observed_created_at: secret.created,
    observed_modified_at: secret.modified,
    metadata_sha256: externalModelSecretMetadataSha256(metadata),
  });
}

export async function manageExternalModelSecret({
  input,
  secretValue: rawSecretValue,
  accountId: rawAccountId,
  bearer: rawBearer,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const desired = parseExternalModelSecretInput(input);
  const account = validateExternalModelSecretAccount(rawAccountId);
  const value = validateExternalModelSecretValue(rawSecretValue);
  const token = validateExternalModelSecretBearer(rawBearer);
  if (typeof fetchImpl !== "function" || typeof sleep !== "function") {
    externalModelSecretStoreFail(
      "EXTERNAL_MODEL_SECRET_TRANSPORT_UNAVAILABLE",
      "Secrets Store transport is unavailable",
    );
  }
  const client = createExternalModelSecretRestClient({ account, token, fetchImpl });
  const storeResult = await ensureStore(client, account);
  const secretResult = desired.operation === "CREATE"
    ? await createSecret(client, storeResult.store.id, desired, value, sleep)
    : await rotateSecret(client, storeResult.store.id, desired, value, sleep);
  return createReceipt(account, desired, storeResult, secretResult);
}
