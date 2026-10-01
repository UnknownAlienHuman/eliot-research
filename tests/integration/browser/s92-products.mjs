// tests/integration/browser/s92-products.mjs
/* global URL: readonly, process: readonly, console: readonly */
//
// S92 92.3 — product scenarios: registered ASK / COMPARE / FACT_CHECK /
// DEEP_RESEARCH / REPORT through actual W1/W2/W3/storage and the controlled
// external model.
//
// What this file drives (all real code, no stubs of the system under test):
//   - scripts/lib/local-launch.mjs: localConfig() / localEnvironment()
//     (real local-harness entry points; the S92 local profile builder).
//   - packages/contracts/src/research.ts: the real InvestigationSchema
//     execution_product enum (product registration authority).
//   - packages/research/src: the real createInvestigationLedgerService +
//     createD1InvestigationLedgerStore over real node:sqlite storage with the
//     real infra/d1/core/migrations/*.sql applied (W1 investigation-ledger
//     admission and observation settlement; mirrors research-test-fixture.ts,
//     which cannot load under plain node because it uses import.meta.glob
//     and vitest — the service, SQL and storage here are real).
//   - packages/cloudflare-ai/src/model-gateway-http-request.ts: the real
//     reasoningEndpoint() / gatewayToken() validators (fail-closed proof for
//     the controlled external model).
//
// Model policy (owner decision D1): the local default is
// AI_GATEWAY_REASONING_URL=https://example.invalid/local-disabled and there
// is NO local fake model gateway. Live-model assertions are therefore
// PENDING_OWNER_D1B by construction; this file asserts readiness plumbing
// and fail-closed behavior, and never invents model output.
//
// State discipline (matches library.spec.ts harness style):
//   missing entry point / environment -> NOT_EXECUTED (honest skip)
//   unmet prerequisite                 -> BLOCKED
//   assertion failure                  -> FAIL with reason
//   live model dependent               -> PENDING_OWNER_D1B
//
// Plain-node runnable: `node tests/integration/browser/s92-products.mjs`
// runs every SCENARIOS entry and prints a summary. The parent integrates
// registration into tests/integration/browser/library.spec.ts.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The repo's TS sources import each other via ".js" specifiers (tsc-style).
// Plain node type-stripping does not rewrite those, so register a minimal
// resolver that maps "./x.js" -> "./x.ts" when the .ts sibling exists. This
// only affects module resolution; every exercised function is the real one.
register(
  "data:text/javascript," +
    encodeURIComponent(
      `import { existsSync } from "node:fs";
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (
      typeof specifier === "string" &&
      specifier.endsWith(".js") &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (url.protocol === "file:" && existsSync(url)) {
        return { url: url.href, shortCircuit: true };
      }
    }
    throw error;
  }
}`,
    ),
);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const LOCAL_DISABLED_MODEL_URL = "https://example.invalid/local-disabled";
// Passport names DEEP; the registered enum value is DEEP_RESEARCH.
const S92_PRODUCTS = ["ASK", "COMPARE", "FACT_CHECK", "DEEP_RESEARCH", "REPORT"];

let modules = null;
let moduleLoadError = null;

async function loadModules() {
  if (modules !== null || moduleLoadError !== null) return;
  try {
    const [launch, contracts, research, gateway] = await Promise.all([
      import("../../../scripts/lib/local-launch.mjs"),
      import("../../../packages/contracts/src/research.ts"),
      import("../../../packages/research/src/index.ts"),
      import("../../../packages/cloudflare-ai/src/model-gateway-http-request.ts"),
    ]);
    modules = { launch, contracts, research, gateway };
  } catch (error) {
    moduleLoadError = error;
  }
}

function requireModules() {
  if (moduleLoadError !== null) {
    return {
      state: "NOT_EXECUTED",
      detail: `real entry point unavailable: ${moduleLoadError.message}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ledger setup: mirrors packages/research/src/research-test-fixture.ts
// (setup/baseInput/seedHandles). The fixture itself cannot load under plain
// node (import.meta.glob + vitest import); the service, migrations, SQL and
// storage below are the real ones.
// ---------------------------------------------------------------------------

function makeD1(raw) {
  const toChanges = (value) =>
    typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
  const prepare = (sql) => ({
    bind(...params) {
      return {
        sql,
        params,
        async first() {
          const statement = raw.prepare(sql);
          const row = params.length === 0 ? statement.get() : statement.get(...params);
          return row ?? null;
        },
        async all() {
          const statement = raw.prepare(sql);
          const rows = params.length === 0 ? statement.all() : statement.all(...params);
          return { results: rows };
        },
        async run() {
          const statement = raw.prepare(sql);
          const info = params.length === 0 ? statement.run() : statement.run(...params);
          return { meta: { changes: toChanges(info.changes) } };
        },
      };
    },
  });
  return {
    raw,
    prepare,
    async batch(statements) {
      raw.exec("BEGIN");
      const out = [];
      try {
        for (const item of statements) {
          const statement = raw.prepare(item.sql);
          const info =
            item.params.length === 0 ? statement.run() : statement.run(...item.params);
          out.push({ meta: { changes: toChanges(info.changes) } });
        }
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw error;
      }
    },
  };
}

function setupProductLedger() {
  const { createD1InvestigationLedgerStore, createInvestigationLedgerService } = modules.research;
  const raw = new DatabaseSync(":memory:");
  const migrationDir = new URL("../../../infra/d1/core/migrations/", import.meta.url);
  for (const file of readdirSync(migrationDir).sort()) {
    if (!file.endsWith(".sql")) continue;
    raw.exec(readFileSync(new URL(file, migrationDir), "utf8"));
  }
  raw.exec(
    "INSERT OR IGNORE INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES ('policy-gen-1','policy-auth-1','ACTIVE','2026-09-05T00:00:00.000Z');" +
      " INSERT OR IGNORE INTO investigation_current_deployment (deployment_generation, state, created_at) VALUES ('deploy-gen-1','ACTIVE','2026-09-05T00:00:00.000Z');",
  );
  raw.exec(
    `INSERT OR IGNORE INTO scope_snapshot (snapshot_id, revision, resolved_scope_expression_json, participant_generations_json, member_source_revision_refs_json, source_owner_generations_json, policy_authority_ref, disclosure_closure_digest, purge_ledger_revision, snapshot_digest, created_at, expires_at, invalidated_at) VALUES ('scope-1',1,'{}','{}','[]','{}','policy-auth-1','${"c".repeat(64)}',0,'${"d".repeat(64)}','2026-09-05T00:00:00.000Z','2030-01-01T00:00:00.000Z',NULL);` +
      ` INSERT OR IGNORE INTO scope_access_grant (snapshot_id, snapshot_revision, principal_ref, client_class, credential_generation, policy_authority_ref, allowed_use_json, disclosure_ceiling, authorization_receipt_ref, state, expires_at, created_at) VALUES ('scope-1',1,'principal-1','owner_pwa','cred-1','policy-auth-1','[]','exact','authz-scope-1-principal-1','ACTIVE','2030-01-01T00:00:00.000Z','2026-09-05T00:00:00.000Z');`,
  );
  const d1 = makeD1(raw);
  const digests = new Map();
  const handles = {
    has: async (ref) => digests.has(ref),
    digestFor: async (ref) => digests.get(ref) ?? null,
  };
  const fence = {
    principal_ref: "principal-1",
    scope_snapshot_id: "scope-1",
    scope_snapshot_revision: 1,
    policy_generation: "policy-gen-1",
    policy_authority_ref: "policy-auth-1",
    deployment_generation: "deploy-gen-1",
    purge_revision: 0,
    scope_purge_revision: 0,
  };
  const store = createD1InvestigationLedgerStore(d1);
  const service = createInvestigationLedgerService(
    store,
    { current: async () => ({ ...fence }) },
    handles,
    () => new Date().toISOString(),
  );
  return { raw, d1, digests, service };
}

function productInput(product, tag) {
  const id = `${product.toLowerCase().replace(/_/g, "-")}-${tag}`;
  return {
    investigation_id: `inv-${id}`,
    goal: `s92 92.3 ${product} admission probe`,
    scope_snapshot_id: "scope-1",
    scope_snapshot_revision: 1,
    evidence_grade: "E2",
    lane: "confirmatory",
    lane_registrations: ["lane-conf-1"],
    obligations: [
      {
        obligation_id: "obl-1",
        verifier_ref: "verifier-a",
        lane: "confirmatory",
        metric_ref: "metric-1",
        status: "REGISTERED",
        exposed: true,
      },
    ],
    hypotheses: ["h-1"],
    portfolio_ref: "portfolio-1",
    debt_refs: ["debt-1"],
    principal_ref: "principal-1",
    input_digest: "a".repeat(64),
    policy_generation: "policy-gen-1",
    policy_authority_ref: "policy-auth-1",
    deployment_generation: "deploy-gen-1",
    idempotency_key: `idem-${id}`,
    model_profile_ref: "model-1",
    event_id: `evt-${id}`,
    payload_handle_ref: `payload-${id}`,
    payload_digest: "b".repeat(64),
    created_at: new Date().toISOString(),
  };
}

function seedProductHandles(ctx, input) {
  ctx.digests.set(input.payload_handle_ref, input.payload_digest);
  ctx.digests.set(input.portfolio_ref, input.input_digest);
}

function throwsCode(fn, code, label) {
  let actual = null;
  try {
    fn();
  } catch (error) {
    actual = error?.code ?? null;
  }
  assert.equal(actual, code, label);
}

function rowCount(ctx, table, id) {
  const row = ctx.raw
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE investigation_id=?`)
    .get(id);
  return row.n;
}

// ---------------------------------------------------------------------------
// verify* scenario functions (harness style: { state, detail? })
// ---------------------------------------------------------------------------

export function verifyS92ProductsRegistered() {
  const skip = requireModules();
  if (skip) return skip;
  const ProductSchema = modules.contracts.InvestigationSchema.shape.execution_product;
  assert.ok(ProductSchema, "contracts must expose execution_product on InvestigationSchema");
  for (const product of S92_PRODUCTS) {
    assert.equal(
      ProductSchema.parse(product),
      product,
      `product ${product} must be registered`,
    );
  }
  assert.throws(() => ProductSchema.parse("SELFIE"), "unknown product must be rejected");
  assert.throws(() => ProductSchema.parse(""), "empty product must be rejected");
  assert.throws(() => ProductSchema.parse(42), "non-string product must be rejected");
  return {
    state: "PASS",
    detail: `registered: ${S92_PRODUCTS.join(",")}; unknown/empty/non-string rejected`,
  };
}

export function verifyS92LocalModelDisabled() {
  const skip = requireModules();
  if (skip) return skip;
  const { localConfig } = modules.launch;
  let canonical;
  try {
    canonical = JSON.parse(
      readFileSync(resolve(repoRoot, "apps/eliotr-core/wrangler.jsonc"), "utf8"),
    );
  } catch (error) {
    return { state: "NOT_EXECUTED", detail: `canonical config unreadable: ${error.message}` };
  }
  const config = localConfig(canonical);
  const injected = localConfig({ ...canonical, vars: { API_TOKEN: "s92-probe-secret" } });
  assert.equal(
    config.vars.AI_GATEWAY_REASONING_URL,
    LOCAL_DISABLED_MODEL_URL,
    "reasoning gateway must be local-disabled",
  );
  assert.equal(
    config.vars.AI_GATEWAY_RETRIEVAL_URL,
    LOCAL_DISABLED_MODEL_URL,
    "retrieval gateway must be local-disabled",
  );
  assert.equal(config.d1_databases.length, 2, "exactly two local D1 databases");
  assert.equal(config.r2_buckets.length, 2, "exactly two local R2 buckets");
  for (const db of config.d1_databases) {
    assert.ok(
      db.database_name.endsWith("-local"),
      `D1 ${db.binding} must use an isolated -local database`,
    );
  }
  for (const bucket of config.r2_buckets) {
    assert.ok(
      bucket.bucket_name.endsWith("-local"),
      `R2 ${bucket.binding} must use an isolated -local bucket`,
    );
  }
  const serialized = JSON.stringify(injected.vars);
  assert.ok(
    !serialized.includes("s92-probe-secret"),
    "injected canonical secrets must not propagate to local vars",
  );
  return {
    state: "PASS",
    detail: `model endpoints local-disabled; D1/R2 isolated (-local); injected secrets stripped`,
  };
}

export function verifyS92LocalEnvIsolation() {
  const skip = requireModules();
  if (skip) return skip;
  const { localEnvironment } = modules.launch;
  const env = localEnvironment({
    PATH: "/usr/bin",
    HOME: "/root",
    CLOUDFLARE_API_TOKEN: "cf-secret",
    CF_API_KEY: "cf-secret",
    WRANGLER_X: "x",
    ELIOTR_MODEL_GATEWAY_TOKEN: "gw-secret",
    ACCESS_SERVICE_TOKEN: "access-secret",
    AI_GATEWAY_TOKEN: "ai-secret",
    MCP_HOST: "mcp",
    GOOGLE_API_KEY: "google-secret",
  });
  for (const key of [
    "CLOUDFLARE_API_TOKEN",
    "CF_API_KEY",
    "WRANGLER_X",
    "ELIOTR_MODEL_GATEWAY_TOKEN",
    "ACCESS_SERVICE_TOKEN",
    "AI_GATEWAY_TOKEN",
    "MCP_HOST",
    "GOOGLE_API_KEY",
  ]) {
    assert.equal(env[key], undefined, `${key} must not reach the local Worker`);
  }
  assert.equal(env.PATH, "/usr/bin", "PATH must be preserved");
  assert.equal(env.HOME, "/root", "HOME must be preserved");
  assert.equal(env.CI, "true", "CI must be forced");
  assert.ok(!JSON.stringify(env).includes("secret"), "no secret value may leak into env");
  return { state: "PASS", detail: "provider/secret keys stripped; PATH/HOME/CI preserved" };
}

export function verifyS92ModelGatewayFailClosed() {
  const skip = requireModules();
  if (skip) return skip;
  const { reasoningEndpoint, gatewayToken } = modules.gateway;
  // The controlled external model is local-disabled: building a request
  // against it must fail closed, never produce a request.
  throwsCode(
    () => reasoningEndpoint(LOCAL_DISABLED_MODEL_URL),
    "MODEL_GATEWAY_REQUEST_INVALID",
    "local-disabled reasoning URL must be rejected",
  );
  throwsCode(
    () => reasoningEndpoint("http://gateway.ai.cloudflare.com/v1/x/eliotr-reasoning"),
    "MODEL_GATEWAY_REQUEST_INVALID",
    "non-https gateway URL must be rejected",
  );
  throwsCode(
    () => gatewayToken(""),
    "MODEL_GATEWAY_CREDENTIAL_INVALID",
    "empty gateway token must be rejected",
  );
  throwsCode(
    () => gatewayToken("Bearer abc"),
    "MODEL_GATEWAY_CREDENTIAL_INVALID",
    "bearer-prefixed token must be rejected",
  );
  // Positive control: a well-formed gateway URL resolves to the compat endpoint.
  const accountId = "a".repeat(32);
  assert.equal(
    reasoningEndpoint(`https://gateway.ai.cloudflare.com/v1/${accountId}/eliotr-reasoning`),
    `https://gateway.ai.cloudflare.com/v1/${accountId}/eliotr-reasoning/compat/chat/completions`,
  );
  assert.equal(gatewayToken("raw-token-value"), "raw-token-value");
  return {
    state: "PASS",
    detail: "local-disabled/non-https/empty-token rejected fail-closed; well-formed endpoint resolves",
  };
}

export async function verifyS92ProductAdmission(product) {
  const skip = requireModules();
  if (skip) return skip;
  if (!S92_PRODUCTS.includes(product)) {
    return { state: "BLOCKED", detail: `product ${product} is not registered` };
  }
  const ctx = setupProductLedger();
  const input = productInput(product, "s92");
  seedProductHandles(ctx, input);

  // Admission: create the investigation for this product (W1 ledger head).
  const head = await ctx.service.create(input);
  assert.equal(head.revision, 1, "admission must create revision 1");
  assert.equal(rowCount(ctx, "investigation_ledger_head", head.investigation_id), 1);

  // Idempotent replay: same identity returns the same head, no second effect.
  const replay = await ctx.service.create(input);
  assert.deepEqual(replay, head, "replay must return the identical head");
  assert.equal(rowCount(ctx, "investigation_ledger_head", head.investigation_id), 1);
  assert.equal(rowCount(ctx, "investigation_ledger_event", head.investigation_id), 1);

  // W1 observation settlement onto the ledger head (mirrors
  // research-w1-observations.ts: one OBSERVED event bound to the head).
  const obsRef = `obs-${product.toLowerCase()}-s92`;
  const obsDigest = "e".repeat(64);
  ctx.digests.set(obsRef, obsDigest);
  const observed = await ctx.service.recordObserved(
    head.investigation_id,
    1,
    `w1-${product}-execution`,
    "exact",
    "high",
    "principal-1",
    `evt-${product.toLowerCase()}-s92-obs`,
    obsRef,
    obsDigest,
  );
  assert.equal(observed.revision, 2, "observation settlement must advance to revision 2");

  // Result readback: the head and its events read back from real storage.
  const readback = await ctx.service.read(head.investigation_id);
  assert.equal(readback.revision, 2, "readback must see revision 2");
  assert.equal(readback.investigation_id, head.investigation_id);
  assert.equal(rowCount(ctx, "investigation_ledger_event", head.investigation_id), 2);

  // Negative: same idempotency key with a different goal conflicts, no effect.
  const conflict = { ...input, goal: "a different goal", event_id: `evt-${product.toLowerCase()}-s92-x` };
  ctx.digests.set(conflict.payload_handle_ref, conflict.payload_digest);
  let code = null;
  try {
    await ctx.service.create(conflict);
  } catch (error) {
    code = error?.code ?? null;
  }
  assert.equal(code, "LEDGER_CONFLICT", "conflicting replay must fail LEDGER_CONFLICT");
  assert.equal(rowCount(ctx, "investigation_ledger_head", head.investigation_id), 1);
  assert.equal(rowCount(ctx, "investigation_ledger_event", head.investigation_id), 2);

  return {
    state: "PASS",
    detail:
      `${product}: admitted rev 1, idempotent replay, W1 observation settled rev 2, ` +
      `readback ok, conflict rejected; storage rows head=1 event=2`,
  };
}

export function verifyS92LiveModelAssertions() {
  // Owner decision D1(b) — a real gateway — is required before any of these
  // can execute. They are registered so the runner reaches them, and they
  // stay PENDING_OWNER_D1B instead of faking PASS.
  return {
    state: "PENDING_OWNER_D1B",
    detail:
      "pending owner D1(b): live model response per product (ASK/COMPARE/FACT_CHECK/DEEP_RESEARCH/REPORT); " +
      "W3 attempt/reservation/fingerprint/pricing/output settlement against the controlled gateway; " +
      "T4/T5 live-gate trials; S93 adjudicated quality on measured outputs",
  };
}

// ---------------------------------------------------------------------------
// SCENARIOS registry
// ---------------------------------------------------------------------------

export const SCENARIOS = [
  { name: "s92-products-registered", run: () => verifyS92ProductsRegistered() },
  { name: "s92-local-model-disabled", run: () => verifyS92LocalModelDisabled() },
  { name: "s92-local-env-isolation", run: () => verifyS92LocalEnvIsolation() },
  { name: "s92-model-gateway-fail-closed", run: () => verifyS92ModelGatewayFailClosed() },
  ...S92_PRODUCTS.map((product) => ({
    name: `s92-product-${product.toLowerCase().replace(/_/g, "-")}-admission`,
    run: () => verifyS92ProductAdmission(product),
  })),
  { name: "s92-live-model-assertions", run: () => verifyS92LiveModelAssertions() },
];

// Direct execution: run every scenario and print a summary.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await loadModules();
  let failed = 0;
  for (const scenario of SCENARIOS) {
    let result;
    try {
      result = await scenario.run();
    } catch (error) {
      result = { state: "FAIL", detail: `unexpected throw: ${error?.message ?? error}` };
    }
    if (result.state === "FAIL") failed += 1;
    console.log(`${result.state.padEnd(16)} ${scenario.name}${result.detail ? ` — ${result.detail}` : ""}`);
  }
  console.log(`\n${SCENARIOS.length - failed}/${SCENARIOS.length} non-failing`);
  process.exit(failed === 0 ? 0 : 1);
} else {
  await loadModules();
}
