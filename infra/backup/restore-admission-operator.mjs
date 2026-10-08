#!/usr/bin/env node
// Trusted operator installer/revoker for one exact current restore authority.
// Source only: this entry point must never be invoked during ordinary restore work.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  LOGIN_INSTRUCTION, WRANGLER_OAUTH_MODE, injectOAuthBearer, loadWranglerOAuthCredential,
  resolveAuthMode, scrubTokenEnv, verifyWranglerOAuthAccount,
} from "../../scripts/lib/cloudflare-wrangler-oauth.mjs";
import { createCloudflareD1HttpDatabase } from "../../scripts/lib/cloudflare-d1-http.mjs";
import { isUsageAdmissionCapability, runUsagePreflight } from "../../scripts/lib/cloudflare-usage-admission.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const STATE_ROOT = resolve(ROOT, ".eliotr-state", "backup-restore-admission");
const PLAN_PROTOCOL = "eliotr.backup-restore-admission-install-plan.v1";
const REVOCATION_PLAN_PROTOCOL = "eliotr.backup-restore-admission-revocation-plan.v1";
const PROFILE_PROTOCOL = "eliotr.backup-restore-target-profile.v1";
const PERMISSION_PROTOCOL = "eliotr.backup-restore-permission.v1";
const OPERATOR_PROTOCOL = "eliotr.backup-restore-operator-issuer.v1";
const BINDING_PROTOCOL = "eliotr.backup-restore-admission-binding.v1";
const MIGRATION = "0115_backup_restore_current_admission.sql";
const AUTHORITY_TABLES = ["backup_restore_target_profile", "backup_restore_target_profile_revocation",
  "backup_restore_permission", "backup_restore_permission_revocation", "backup_restore_admission_binding"];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CF_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;

function fail(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "RestoreAdmissionInstallError";
  throw error;
}
function exactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} contains missing or unknown fields`);
}

function id(value, label, pattern = SAFE_ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is malformed`);
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail(`${label} must be a canonical UTC millisecond timestamp`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be lowercase SHA-256 hex`);
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is outside its integer bounds`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateResources(value, label) {
  exactKeys(value, ["core_database", "evidence_bucket", "work_bucket"], label);
  id(value.core_database, `${label}.core_database`, CF_ID);
  id(value.evidence_bucket, `${label}.evidence_bucket`);
  id(value.work_bucket, `${label}.work_bucket`);
}

function validateProfile(value) {
  exactKeys(value, ["protocol", "profile_ref", "revision", "account_id", "failure_domain", "environment_ref", "deployment_ref",
    "configuration_sha256", "resources", "created_at"], "target_profile");
  if (value.protocol !== PROFILE_PROTOCOL) fail("target_profile.protocol is unsupported");
  id(value.profile_ref, "target_profile.profile_ref");
  integer(value.revision, "target_profile.revision", 1);
  id(value.account_id, "target_profile.account_id", CF_ID);
  id(value.failure_domain, "target_profile.failure_domain");
  id(value.environment_ref, "target_profile.environment_ref");
  id(value.deployment_ref, "target_profile.deployment_ref");
  digest(value.configuration_sha256, "target_profile.configuration_sha256");
  validateResources(value.resources, "target_profile.resources");
  timestamp(value.created_at, "target_profile.created_at");
  if (Date.parse(value.created_at) > Date.now()) fail("target_profile.created_at cannot be in the future");
}

function validateIntent(value) {
  const allowed = ["intent_ref", "operation_kind", "principal_ref", "idempotency_key", "payload_ref", "policy_decision_ref",
    "budget_reservation_ref", "cancellation_ref", "created_at"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("permission.intent must be an object");
  const required = allowed.filter((key) => !["budget_reservation_ref", "cancellation_ref"].includes(key));
  const actual = Object.keys(value).sort();
  if (required.some((key) => !actual.includes(key)) || actual.some((key) => !allowed.includes(key))) fail("permission.intent contains missing or unknown fields");
  exactKeys(value.intent_ref, ["id", "revision"], "permission.intent.intent_ref");
  id(value.intent_ref.id, "permission.intent.intent_ref.id");
  integer(value.intent_ref.revision, "permission.intent.intent_ref.revision", 1);
  if (value.operation_kind !== "RESTORE_VERIFY") fail("permission.intent.operation_kind must be RESTORE_VERIFY");
  for (const key of ["principal_ref", "idempotency_key", "payload_ref", "policy_decision_ref"]) id(value[key], `permission.intent.${key}`);
  for (const key of ["budget_reservation_ref", "cancellation_ref"]) if (value[key] !== undefined) id(value[key], `permission.intent.${key}`);
  timestamp(value.created_at, "permission.intent.created_at");
}

function validateActor(value) {
  exactKeys(value, ["principal_ref", "credential_generation", "client_class", "authentication_method", "issuer", "verified_at", "expires_at"], "permission.actor");
  id(value.principal_ref, "permission.actor.principal_ref");
  id(value.credential_generation, "permission.actor.credential_generation");
  if (!["owner_pwa", "named_api_client", "trusted_agent", "federation_client"].includes(value.client_class)) fail("permission.actor.client_class is unsupported");
  if (!["cloudflare_access", "service_token"].includes(value.authentication_method)) fail("permission.actor.authentication_method is unsupported");
  id(value.issuer, "permission.actor.issuer");
  timestamp(value.verified_at, "permission.actor.verified_at");
  timestamp(value.expires_at, "permission.actor.expires_at");
}

function validatePlan(plan) {
  exactKeys(plan, ["protocol", "operation_ref", "account_id", "database_id", "target_profile", "permission"], "plan");
  if (plan.protocol !== PLAN_PROTOCOL) fail("plan protocol is unsupported");
  id(plan.operation_ref, "operation_ref");
  id(plan.account_id, "account_id", CF_ID);
  id(plan.database_id, "database_id", CF_ID);
  validateProfile(plan.target_profile);
  const permission = plan.permission;
  exactKeys(permission, ["permission_ref", "revision", "actor", "intent", "epoch_id", "offsite_copy_ref", "copy_authority_sha256",
    "primary", "migration_ledger_digest", "purge_ledger_revision", "purge_ledger_digest", "valid_from", "expires_at", "created_at"], "permission");
  id(permission.permission_ref, "permission.permission_ref");
  integer(permission.revision, "permission.revision", 1);
  validateActor(permission.actor);
  validateIntent(permission.intent);
  if (permission.intent.principal_ref !== permission.actor.principal_ref) fail("restore intent principal differs from the authenticated actor principal");
  id(permission.epoch_id, "permission.epoch_id");
  if (permission.intent.payload_ref !== permission.epoch_id) fail("restore intent payload_ref must equal the exact epoch id");
  id(permission.offsite_copy_ref, "permission.offsite_copy_ref");
  digest(permission.copy_authority_sha256, "permission.copy_authority_sha256");
  exactKeys(permission.primary, ["account_id", "failure_domain", "resources"], "permission.primary");
  id(permission.primary.account_id, "permission.primary.account_id", CF_ID);
  id(permission.primary.failure_domain, "permission.primary.failure_domain");
  validateResources(permission.primary.resources, "permission.primary.resources");
  if (permission.primary.account_id !== plan.account_id || permission.primary.resources.core_database !== plan.database_id) fail("installer account and database must pin the primary restore coordinator");
  if (permission.primary.failure_domain === plan.target_profile.failure_domain) fail("primary and reviewed target must use distinct failure domains");
  for (const name of ["core_database", "evidence_bucket", "work_bucket"]) {
    if (permission.primary.resources[name] === plan.target_profile.resources[name]) fail(`primary and target ${name} must be different resources`);
  }
  digest(permission.migration_ledger_digest, "permission.migration_ledger_digest");
  integer(permission.purge_ledger_revision, "permission.purge_ledger_revision");
  digest(permission.purge_ledger_digest, "permission.purge_ledger_digest");
  timestamp(permission.valid_from, "permission.valid_from");
  timestamp(permission.expires_at, "permission.expires_at");
  timestamp(permission.created_at, "permission.created_at");
  const now = Date.now();
  if (Date.parse(permission.valid_from) > now || Date.parse(permission.expires_at) <= now ||
      Date.parse(permission.created_at) > now || Date.parse(permission.valid_from) < Date.parse(permission.created_at) ||
      Date.parse(permission.expires_at) > Date.parse(permission.actor.expires_at) ||
      Date.parse(permission.actor.verified_at) > now || Date.parse(permission.actor.expires_at) <= now ||
      Date.parse(permission.expires_at) <= Date.parse(permission.valid_from)) {
    fail("permission or authenticated actor is not current for this live installation");
  }
  return plan;
}

function validateRevocationPlan(plan) {
  exactKeys(plan, ["protocol", "operation_ref", "account_id", "database_id", "authority_kind", "authority_ref",
    "authority_revision", "revocation_ref", "revoked_at", "reason_sha256"], "revocation_plan");
  if (plan.protocol !== REVOCATION_PLAN_PROTOCOL) fail("revocation plan protocol is unsupported");
  id(plan.operation_ref, "operation_ref");
  id(plan.account_id, "account_id", CF_ID);
  id(plan.database_id, "database_id", CF_ID);
  if (plan.authority_kind !== "permission" && plan.authority_kind !== "target_profile") fail("authority_kind must be permission or target_profile");
  id(plan.authority_ref, "authority_ref");
  integer(plan.authority_revision, "authority_revision", 1);
  id(plan.revocation_ref, "revocation_ref");
  timestamp(plan.revoked_at, "revoked_at");
  digest(plan.reason_sha256, "reason_sha256");
  if (Date.parse(plan.revoked_at) > Date.now()) fail("revocation timestamp cannot be in the future");
  return plan;
}

function buildRows(plan, planSha) {
  const { permission: source, target_profile: profile } = plan;
  const profileSha = sha256(canonicalJson(profile));
  const targetProfileRef = { profile_ref: profile.profile_ref, revision: profile.revision, profile_sha256: profileSha };
  const identityTarget = { account_id: profile.account_id, failure_domain: profile.failure_domain,
    environment_ref: profile.environment_ref, resources: profile.resources };
  const restoreIntentDigest = sha256(canonicalJson({ intent: source.intent, epoch_id: source.epoch_id,
    offsite_copy_ref: source.offsite_copy_ref, target: identityTarget }));
  const restoreKey = sha256(`${source.intent.principal_ref}\u0000${source.intent.idempotency_key}`);
  const restoreId = `restore-${restoreKey.slice(0, 48)}`;
  const actorSha = sha256(canonicalJson(source.actor));
  const intentSha = sha256(canonicalJson(source.intent));
  const primarySha = sha256(canonicalJson(source.primary));
  const request = {
    protocol: "eliotr.backup-restore-admission-request.v1", permission_ref: source.permission_ref,
    permission_revision: source.revision, actor: source.actor, intent: source.intent,
    restore_id: restoreId, restore_intent_digest: restoreIntentDigest, epoch_id: source.epoch_id,
    offsite_copy_ref: source.offsite_copy_ref, copy_authority_sha256: source.copy_authority_sha256,
    primary: source.primary,
    target: { account_id: profile.account_id, failure_domain: profile.failure_domain, environment_ref: profile.environment_ref,
      deployment_ref: profile.deployment_ref, configuration_sha256: profile.configuration_sha256, resources: profile.resources },
    target_profile: targetProfileRef, migration_ledger_digest: source.migration_ledger_digest,
    purge_ledger_revision: source.purge_ledger_revision, purge_ledger_digest: source.purge_ledger_digest,
  };
  const permission = {
    protocol: PERMISSION_PROTOCOL, permission_ref: source.permission_ref, revision: source.revision,
    operator_issuer: { protocol: OPERATOR_PROTOCOL, authentication_method: "wrangler-oauth", account_id: plan.account_id,
      confirmed_plan_sha256: planSha, issued_at: source.created_at },
    actor: source.actor, intent: source.intent, intent_sha256: intentSha, restore_id: restoreId,
    restore_intent_digest: restoreIntentDigest, epoch_id: source.epoch_id, offsite_copy_ref: source.offsite_copy_ref,
    copy_authority_sha256: source.copy_authority_sha256, primary: source.primary, primary_binding_sha256: primarySha,
    target_profile: targetProfileRef, request_sha256: sha256(canonicalJson(request)),
    migration_ledger_digest: source.migration_ledger_digest, purge_ledger_revision: source.purge_ledger_revision,
    purge_ledger_digest: source.purge_ledger_digest, valid_from: source.valid_from,
    expires_at: source.expires_at, created_at: source.created_at,
  };
  const permissionJson = canonicalJson(permission);
  const permissionSha = sha256(permissionJson);
  const bindingCore = {
    restore_id: restoreId, permission_ref: source.permission_ref, permission_revision: source.revision,
    permission_sha256: permissionSha, restore_intent_digest: restoreIntentDigest, intent_sha256: intentSha,
    actor_sha256: actorSha, actor_expires_at: source.actor.expires_at,
    copy_authority_sha256: source.copy_authority_sha256, primary_binding_sha256: primarySha,
    request_sha256: permission.request_sha256, profile_ref: profile.profile_ref, profile_revision: profile.revision,
    profile_sha256: profileSha, valid_from: source.valid_from, expires_at: source.expires_at,
  };
  const bindingJson = canonicalJson({ protocol: BINDING_PROTOCOL, ...bindingCore, created_at: source.created_at });
  const rows = {
    profile: { profile_ref: profile.profile_ref, revision: profile.revision, profile_json: canonicalJson(profile),
      profile_sha256: profileSha, account_id: profile.account_id, failure_domain: profile.failure_domain,
      environment_ref: profile.environment_ref, deployment_ref: profile.deployment_ref,
      configuration_sha256: profile.configuration_sha256, resources_json: canonicalJson(profile.resources), created_at: profile.created_at },
    permission: { permission_ref: source.permission_ref, revision: source.revision, permission_json: permissionJson,
      permission_sha256: permissionSha, restore_id: restoreId, restore_intent_digest: restoreIntentDigest,
      intent_sha256: intentSha, actor_sha256: actorSha, request_sha256: permission.request_sha256,
      actor_expires_at: source.actor.expires_at, epoch_id: source.epoch_id, offsite_copy_ref: source.offsite_copy_ref,
      copy_authority_sha256: source.copy_authority_sha256, primary_binding_sha256: primarySha,
      profile_ref: profile.profile_ref, profile_revision: profile.revision, profile_sha256: profileSha,
      migration_ledger_digest: source.migration_ledger_digest, purge_ledger_revision: source.purge_ledger_revision,
      purge_ledger_digest: source.purge_ledger_digest, valid_from: source.valid_from, expires_at: source.expires_at,
      created_at: source.created_at },
    binding: { ...bindingCore, binding_json: bindingJson, binding_sha256: sha256(bindingJson), created_at: source.created_at },
  };
  return { mode: "INSTALL", request, rows };
}
function buildRevocation(plan, planSha) {
  const row = {
    revocation_ref: plan.revocation_ref,
    ...(plan.authority_kind === "permission"
      ? { permission_ref: plan.authority_ref, permission_revision: plan.authority_revision }
      : { profile_ref: plan.authority_ref, profile_revision: plan.authority_revision }),
    revoked_at: plan.revoked_at, reason_sha256: plan.reason_sha256,
    revocation_json: canonicalJson({ protocol: "eliotr.backup-restore-authority-revocation.v1",
      authority_kind: plan.authority_kind, authority_ref: plan.authority_ref,
      authority_revision: plan.authority_revision, revocation_ref: plan.revocation_ref,
      reason_sha256: plan.reason_sha256, revoked_at: plan.revoked_at,
      operator_issuer: { protocol: OPERATOR_PROTOCOL, authentication_method: "wrangler-oauth",
        account_id: plan.account_id, confirmed_plan_sha256: planSha, issued_at: plan.revoked_at } }),
  };
  row.revocation_sha256 = sha256(row.revocation_json);
  return { mode: "REVOKE", row, plan };
}

function parseArgs(args) {
  let planPath = null;
  let confirmLive = false;
  let confirmPlan = null;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--plan" && args[index + 1] !== undefined) { planPath = args[++index]; continue; }
    if (value === "--confirm-live") { confirmLive = true; continue; }
    if (value === "--confirm-plan" && args[index + 1] !== undefined) { confirmPlan = args[++index]; continue; }
    fail("usage: node infra/backup/restore-admission-operator.mjs --plan <local-plan.json> [--confirm-live --confirm-plan <plan-sha256>]");
  }
  if (planPath === null) fail("--plan is required");
  if (confirmPlan !== null && !SHA256.test(confirmPlan)) fail("--confirm-plan must be lowercase SHA-256 hex");
  if (confirmLive && confirmPlan === null) fail("--confirm-live requires --confirm-plan with the reviewed plan SHA-256");
  if (!confirmLive && confirmPlan !== null) fail("--confirm-plan is valid only with --confirm-live");
  return { planPath, confirmLive, confirmPlan };
}

async function readLocalPlan(path) {
  const candidate = isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
  const expectedRoot = await realpath(STATE_ROOT).catch(() => null);
  if (expectedRoot === null) fail("local .eliotr-state/backup-restore-admission directory must exist before using a plan");
  const actual = await realpath(candidate);
  const rel = relative(expectedRoot, actual);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) fail("plan must be stored below .eliotr-state/backup-restore-admission");
  const file = await stat(actual);
  if (!file.isFile() || file.size > 256 * 1024) fail("restore install plan must be a regular file no larger than 256 KiB");
  let plan;
  try { plan = JSON.parse(await readFile(actual, "utf8")); }
  catch (cause) { fail("restore install plan is not valid JSON", cause); }
  if (plan?.protocol === PLAN_PROTOCOL) validatePlan(plan);
  else if (plan?.protocol === REVOCATION_PLAN_PROTOCOL) validateRevocationPlan(plan);
  else fail("operator plan protocol is unsupported");
  return { plan, planSha: sha256(canonicalJson(plan)), path: actual };
}

function receiptPath(operationRef) {
  return resolve(STATE_ROOT, `${sha256(operationRef)}.receipt.json`);
}

async function saveReceipt(path, receipt, { createOnly = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    if (createOnly) {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(bytes, { encoding: "utf8" }); await handle.sync(); }
      finally { await handle.close(); }
    } else {
      await writeFile(temp, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temp, path);
    }
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {});
    fail("local operator receipt could not be durably recorded", cause);
  }
}

async function readReceipt(path, operationRef, planSha) {
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size > 1024 * 1024) fail("saved restore admission operator receipt exceeds its bound");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    exactKeys(receipt, ["protocol", "operation_ref", "plan_sha256", "state", "attempt_number", "created_at", "updated_at", "target", "row_digests", "last_readback"], "saved receipt");
    if (receipt.protocol !== "eliotr.backup-restore-admission-install-receipt.v1" ||
        receipt.operation_ref !== operationRef || receipt.plan_sha256 !== planSha ||
        !["INTENT_RECORDED", "ATTEMPT_STARTED", "UNKNOWN", "PASS", "RECONCILED", "REVOKED", "EXPIRED", "CONFLICT"].includes(receipt.state) ||
        !Number.isSafeInteger(receipt.attempt_number) || receipt.attempt_number < 0) {
      fail("existing operator receipt is bound to a different or unsupported plan");
    }
    return receipt;
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function rows(database, sql, params = []) {
  const result = await database.prepare(sql).bind(...params).all();
  if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 2) fail("D1 current-authority readback is incomplete or ambiguous");
  return result.results;
}

async function run(database, sql, params) {
  const result = await database.prepare(sql).bind(...params).run();
  if (result?.success !== true || !Array.isArray(result.results) || !Number.isSafeInteger(result.meta?.changes) || result.meta.changes < 0 || result.meta.changes > 1) {
    fail("D1 immutable authority insert returned incomplete metadata");
  }
}

function exactRow(actual, expected) {
  return actual !== undefined && canonicalJson(actual) === canonicalJson(expected);
}

async function assertSchemaReady(database) {
  const migrationTable = await rows(database, "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations' LIMIT 2");
  if (migrationTable.length !== 1) fail("Core D1 migration ledger is unavailable");
  const migration = await rows(database, "SELECT name FROM d1_migrations WHERE name=?1 LIMIT 2", [MIGRATION]);
  if (migration.length !== 1 || migration[0]?.name !== MIGRATION) fail("0115 current restore admission migration is not installed on this coordinator");
  for (const table of AUTHORITY_TABLES) {
    const found = await rows(database, "SELECT name FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 2", [table]);
    if (found.length !== 1 || found[0]?.name !== table) fail(`current restore authority table ${table} is unavailable`);
  }
}

async function readAuthority(database, expected) {
  const profile = expected.profile;
  const permission = expected.permission;
  const binding = expected.binding;
  const profileRows = await rows(database, "SELECT profile_ref,revision,profile_json,profile_sha256,account_id,failure_domain,environment_ref,deployment_ref,configuration_sha256,resources_json,created_at FROM backup_restore_target_profile WHERE profile_ref=?1 AND revision=?2 LIMIT 2",
    [profile.profile_ref, profile.revision]);
  const permissionRows = await rows(database, "SELECT permission_ref,revision,permission_json,permission_sha256,restore_id,restore_intent_digest,intent_sha256,actor_sha256,request_sha256,actor_expires_at,epoch_id,offsite_copy_ref,copy_authority_sha256,primary_binding_sha256,profile_ref,profile_revision,profile_sha256,migration_ledger_digest,purge_ledger_revision,purge_ledger_digest,valid_from,expires_at,created_at FROM backup_restore_permission WHERE permission_ref=?1 AND revision=?2 LIMIT 2",
    [permission.permission_ref, permission.revision]);
  const bindingRows = await rows(database, "SELECT restore_id,permission_ref,permission_revision,permission_sha256,restore_intent_digest,intent_sha256,actor_sha256,actor_expires_at,copy_authority_sha256,primary_binding_sha256,request_sha256,profile_ref,profile_revision,profile_sha256,valid_from,expires_at,binding_json,binding_sha256,created_at FROM backup_restore_admission_binding WHERE restore_id=?1 AND permission_ref=?2 AND permission_revision=?3 LIMIT 2",
    [binding.restore_id, binding.permission_ref, binding.permission_revision]);
  const profileRevocations = await rows(database, "SELECT revocation_ref FROM backup_restore_target_profile_revocation WHERE profile_ref=?1 AND profile_revision=?2 LIMIT 2",
    [profile.profile_ref, profile.revision]);
  const permissionRevocations = await rows(database, "SELECT revocation_ref FROM backup_restore_permission_revocation WHERE permission_ref=?1 AND permission_revision=?2 LIMIT 2",
    [permission.permission_ref, permission.revision]);
  const exact = profileRows.length === 1 && permissionRows.length === 1 && bindingRows.length === 1 &&
    exactRow(profileRows[0], profile) && exactRow(permissionRows[0], permission) && exactRow(bindingRows[0], binding);
  const now = Date.now();
  const current = Date.parse(permission.valid_from) <= now && Date.parse(permission.expires_at) > now &&
    Date.parse(permission.actor_expires_at) > now;
  return { exact, profile_present: profileRows.length > 0, permission_present: permissionRows.length > 0,
    binding_present: bindingRows.length > 0, revoked: profileRevocations.length > 0 || permissionRevocations.length > 0, current,
    row_digests: { profile_sha256: profile.profile_sha256, permission_sha256: permission.permission_sha256, binding_sha256: binding.binding_sha256 } };
}

async function readRevocation(database, expected) {
  const { plan, row } = expected;
  const parentRows = plan.authority_kind === "permission"
    ? await rows(database, "SELECT permission_ref AS authority_ref,revision AS authority_revision FROM backup_restore_permission WHERE permission_ref=?1 AND revision=?2 LIMIT 2",
      [plan.authority_ref, plan.authority_revision])
    : await rows(database, "SELECT profile_ref AS authority_ref,revision AS authority_revision FROM backup_restore_target_profile WHERE profile_ref=?1 AND revision=?2 LIMIT 2",
      [plan.authority_ref, plan.authority_revision]);
  const parent = parentRows.length === 1 && parentRows[0].authority_ref === plan.authority_ref &&
    parentRows[0].authority_revision === plan.authority_revision;
  const table = plan.authority_kind === "permission"
    ? "backup_restore_permission_revocation"
    : "backup_restore_target_profile_revocation";
  const refColumn = plan.authority_kind === "permission" ? "permission_ref" : "profile_ref";
  const revisionColumn = plan.authority_kind === "permission" ? "permission_revision" : "profile_revision";
  const revocations = await rows(database, `SELECT revocation_ref,${refColumn},${revisionColumn},revoked_at,reason_sha256,revocation_json,revocation_sha256 FROM ${table} WHERE ${refColumn}=?1 AND ${revisionColumn}=?2 LIMIT 2`,
    [plan.authority_ref, plan.authority_revision]);
  const exact = parent && revocations.length === 1 && exactRow(revocations[0], row);
  return { authority_present: parent, exact, revoked: revocations.length > 0,
    conflict: revocations.length > 0 && !exact, row_digests: { revocation_sha256: row.revocation_sha256 } };
}

async function assertNoExistingRows(database, expected) {
  const observed = await readAuthority(database, expected);
  if (observed.profile_present || observed.permission_present || observed.binding_present) {
    fail("current restore authority already has rows for this exact profile or permission; reconcile the prior operation instead of installing again");
  }
}

async function verifyOperatorAccount(accountId) {
  const childEnv = scrubTokenEnv({ ...process.env });
  const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"], {
    cwd: ROOT, env: childEnv, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) fail(`Wrangler OAuth account verification failed. ${LOGIN_INSTRUCTION}`, result.error);
  await verifyWranglerOAuthAccount({ expectedAccountId: accountId, getWhoamiOutput: async () => result.stdout ?? "" });
}

async function openDatabase(plan, { requireUsage = true } = {}) {
  if (process.env.CLOUDFLARE_API_BASE_URL !== undefined && process.env.CLOUDFLARE_API_BASE_URL !== CLOUDFLARE_API_BASE_URL) fail("CLOUDFLARE_API_BASE_URL must be the canonical Cloudflare API endpoint");
  if (resolveAuthMode(process.env) !== WRANGLER_OAUTH_MODE) fail(`ELIOTR_CLOUDFLARE_AUTH_MODE must be ${WRANGLER_OAUTH_MODE}; static API-token mode cannot install restore authority`);
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== plan.account_id) fail("CLOUDFLARE_ACCOUNT_ID does not match the primary coordinator account");
  await verifyOperatorAccount(plan.account_id);
  if (requireUsage) {
    const usage = await runUsagePreflight({ env: process.env, nowMs: Date.now(), writeReceipt: true,
      receiptPath: resolve(STATE_ROOT, "cloudflare-usage-admission-receipt.json"), cwd: ROOT });
    if (usage.decision !== "ADMITTED" || !isUsageAdmissionCapability(usage.capability)) {
      fail(`Cloudflare live usage preflight ${usage.decision} denies current-authority installation before any D1 mutation`);
    }
  }
  const credential = await loadWranglerOAuthCredential({ env: process.env, now: Date.now() });
  const token = injectOAuthBearer(process.env, credential.bearer).CLOUDFLARE_API_TOKEN;
  return createCloudflareD1HttpDatabase({ account_id: plan.account_id, database_id: plan.database_id,
    api_token: token, api_base_url: CLOUDFLARE_API_BASE_URL });
}

async function reconcileOnly(path, receipt, expected, database) {
  await assertSchemaReady(database);
  const observed = expected.mode === "REVOKE"
    ? await readRevocation(database, expected)
    : await readAuthority(database, expected.rows);
  receipt.updated_at = new Date().toISOString();
  receipt.last_readback = observed;
  if (expected.mode === "REVOKE" && observed.exact) {
    receipt.state = receipt.state === "PASS" ? "PASS" : "RECONCILED";
    await saveReceipt(path, receipt);
    return receipt.state;
  }
  if (expected.mode === "INSTALL" && observed.exact && !observed.revoked && observed.current) {
    receipt.state = receipt.state === "PASS" ? "PASS" : "RECONCILED";
    await saveReceipt(path, receipt);
    return receipt.state;
  }
  receipt.state = observed.conflict ? "CONFLICT" : expected.mode === "INSTALL" && observed.revoked
    ? "REVOKED" : expected.mode === "INSTALL" && observed.exact && !observed.current ? "EXPIRED" : "UNKNOWN";
  await saveReceipt(path, receipt);
  if (["REVOKED", "EXPIRED", "CONFLICT"].includes(receipt.state)) return receipt.state;
  fail("prior restore admission attempt was not safely reconciled; no insert was retried");
}

export async function runRestoreAdmissionInstall(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  await mkdir(STATE_ROOT, { recursive: true });
  const { plan, planSha } = await readLocalPlan(parsed.planPath);
  const receiptFile = receiptPath(plan.operation_ref);
  const existing = await readReceipt(receiptFile, plan.operation_ref, planSha);
  const expected = plan.protocol === PLAN_PROTOCOL ? buildRows(plan, planSha) : buildRevocation(plan, planSha);
  if (!parsed.confirmLive) {
    process.stdout.write(`${JSON.stringify({ state: "PLAN_ONLY", operation_ref: plan.operation_ref, plan_sha256: planSha, coordinator_account_id: plan.account_id, coordinator_database_id: plan.database_id })}\n`);
    return { state: "PLAN_ONLY", plan_sha256: planSha };
  }
  if (parsed.confirmPlan !== planSha) fail("--confirm-plan does not match the exact canonical reviewed plan bytes");
  const reconcile = existing !== null && ["ATTEMPT_STARTED", "UNKNOWN", "PASS", "RECONCILED", "REVOKED", "EXPIRED", "CONFLICT"].includes(existing.state);
  const database = await openDatabase(plan, { requireUsage: !reconcile });
  await assertSchemaReady(database);
  if (existing !== null && ["ATTEMPT_STARTED", "UNKNOWN", "PASS", "RECONCILED", "REVOKED", "EXPIRED", "CONFLICT"].includes(existing.state)) {
    const state = await reconcileOnly(receiptFile, existing, expected, database);
    process.stdout.write(`${JSON.stringify({ state, operation_ref: plan.operation_ref, plan_sha256: planSha })}\n`);
    return { state, plan_sha256: planSha };
  }
  if (expected.mode === "INSTALL") await assertNoExistingRows(database, expected.rows);
  else {
    const prior = await readRevocation(database, expected);
    if (!prior.authority_present) fail("revocation authority parent is unavailable in the pinned coordinator database");
    if (prior.revoked) fail("authority is already revoked outside this exact local operator attempt; reconcile the matching operation");
  }
  if (expected.mode === "INSTALL") {
    const permission = expected.rows.permission;
    const now = Date.now();
    if (Date.parse(permission.valid_from) > now || Date.parse(permission.expires_at) <= now ||
        Date.parse(permission.actor_expires_at) <= now) {
      fail("reviewed restore permission expired or is not yet valid before the D1 write attempt");
    }
  }
  const createdAt = new Date().toISOString();
  const receipt = existing ?? {
    protocol: "eliotr.backup-restore-admission-install-receipt.v1", operation_ref: plan.operation_ref,
    plan_sha256: planSha, state: "INTENT_RECORDED", attempt_number: 0, created_at: createdAt,
    updated_at: createdAt,
    target: expected.mode === "INSTALL"
      ? { coordinator_account_id: plan.account_id, coordinator_database_id: plan.database_id,
        profile_ref: plan.target_profile.profile_ref, profile_revision: plan.target_profile.revision,
        permission_ref: plan.permission.permission_ref, permission_revision: plan.permission.revision,
        restore_id: expected.rows.binding.restore_id }
      : { coordinator_account_id: plan.account_id, coordinator_database_id: plan.database_id,
        authority_kind: plan.authority_kind, authority_ref: plan.authority_ref,
        authority_revision: plan.authority_revision, revocation_ref: plan.revocation_ref },
    row_digests: expected.mode === "INSTALL" ? {
      profile_sha256: expected.rows.profile.profile_sha256,
      permission_sha256: expected.rows.permission.permission_sha256,
      binding_sha256: expected.rows.binding.binding_sha256,
    } : { revocation_sha256: expected.row.revocation_sha256 },
    last_readback: null,
  };
  await saveReceipt(receiptFile, receipt, { createOnly: existing === null });
  receipt.state = "ATTEMPT_STARTED";
  receipt.attempt_number = 1;
  receipt.updated_at = new Date().toISOString();
  await saveReceipt(receiptFile, receipt);
  try {
    if (expected.mode === "REVOKE") {
      const { plan: revokePlan, row } = expected;
      const permission = revokePlan.authority_kind === "permission";
      const table = permission ? "backup_restore_permission_revocation" : "backup_restore_target_profile_revocation";
      const columns = permission
        ? "revocation_ref,permission_ref,permission_revision,revoked_at,reason_sha256,revocation_json,revocation_sha256"
        : "revocation_ref,profile_ref,profile_revision,revoked_at,reason_sha256,revocation_json,revocation_sha256";
      await run(database, `INSERT OR IGNORE INTO ${table}(${columns}) VALUES(?1,?2,?3,?4,?5,?6,?7)`,
        [row.revocation_ref, revokePlan.authority_ref, revokePlan.authority_revision, row.revoked_at,
          row.reason_sha256, row.revocation_json, row.revocation_sha256]);
      const readback = await readRevocation(database, expected);
      receipt.last_readback = readback;
      if (!readback.exact) fail("restore authority revocation insert failed exact readback");
      receipt.state = "PASS";
      receipt.updated_at = new Date().toISOString();
      await saveReceipt(receiptFile, receipt);
      process.stdout.write(`${JSON.stringify({ state: receipt.state, operation_ref: plan.operation_ref, plan_sha256: planSha })}\n`);
      return { state: receipt.state, plan_sha256: planSha };
    }
    const p = expected.rows.profile;
    await run(database, "INSERT OR IGNORE INTO backup_restore_target_profile(profile_ref,revision,profile_json,profile_sha256,account_id,failure_domain,environment_ref,deployment_ref,configuration_sha256,resources_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
      [p.profile_ref, p.revision, p.profile_json, p.profile_sha256, p.account_id, p.failure_domain, p.environment_ref,
        p.deployment_ref, p.configuration_sha256, p.resources_json, p.created_at]);
    if (!exactRow((await rows(database, "SELECT profile_ref,revision,profile_json,profile_sha256,account_id,failure_domain,environment_ref,deployment_ref,configuration_sha256,resources_json,created_at FROM backup_restore_target_profile WHERE profile_ref=?1 AND revision=?2 LIMIT 2", [p.profile_ref, p.revision]))[0], p)) fail("target profile insert failed exact readback");
    const g = expected.rows.permission;
    await run(database, "INSERT OR IGNORE INTO backup_restore_permission(permission_ref,revision,permission_json,permission_sha256,restore_id,restore_intent_digest,intent_sha256,actor_sha256,request_sha256,actor_expires_at,epoch_id,offsite_copy_ref,copy_authority_sha256,primary_binding_sha256,profile_ref,profile_revision,profile_sha256,migration_ledger_digest,purge_ledger_revision,purge_ledger_digest,valid_from,expires_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
      [g.permission_ref, g.revision, g.permission_json, g.permission_sha256, g.restore_id, g.restore_intent_digest,
        g.intent_sha256, g.actor_sha256, g.request_sha256, g.actor_expires_at, g.epoch_id, g.offsite_copy_ref,
        g.copy_authority_sha256, g.primary_binding_sha256, g.profile_ref, g.profile_revision, g.profile_sha256,
        g.migration_ledger_digest, g.purge_ledger_revision, g.purge_ledger_digest, g.valid_from, g.expires_at, g.created_at]);
    if (!exactRow((await rows(database, "SELECT permission_ref,revision,permission_json,permission_sha256,restore_id,restore_intent_digest,intent_sha256,actor_sha256,request_sha256,actor_expires_at,epoch_id,offsite_copy_ref,copy_authority_sha256,primary_binding_sha256,profile_ref,profile_revision,profile_sha256,migration_ledger_digest,purge_ledger_revision,purge_ledger_digest,valid_from,expires_at,created_at FROM backup_restore_permission WHERE permission_ref=?1 AND revision=?2 LIMIT 2", [g.permission_ref, g.revision]))[0], g)) fail("restore permission insert failed exact readback");
    const b = expected.rows.binding;
    await run(database, "INSERT OR IGNORE INTO backup_restore_admission_binding(restore_id,permission_ref,permission_revision,permission_sha256,restore_intent_digest,intent_sha256,actor_sha256,actor_expires_at,copy_authority_sha256,primary_binding_sha256,request_sha256,profile_ref,profile_revision,profile_sha256,valid_from,expires_at,binding_json,binding_sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
      [b.restore_id, b.permission_ref, b.permission_revision, b.permission_sha256, b.restore_intent_digest, b.intent_sha256,
        b.actor_sha256, b.actor_expires_at, b.copy_authority_sha256, b.primary_binding_sha256, b.request_sha256,
        b.profile_ref, b.profile_revision, b.profile_sha256, b.valid_from, b.expires_at, b.binding_json, b.binding_sha256, b.created_at]);
    const readback = await readAuthority(database, expected.rows);
    receipt.last_readback = readback;
    if (!readback.exact || readback.revoked || !readback.current) fail("restore admission insert sequence failed complete current immutable readback");
    receipt.state = "PASS";
    receipt.updated_at = new Date().toISOString();
    await saveReceipt(receiptFile, receipt);
  } catch (cause) {
    receipt.state = "UNKNOWN";
    receipt.updated_at = new Date().toISOString();
    await saveReceipt(receiptFile, receipt).catch(() => {});
    fail("restore admission install did not settle; receipt is UNKNOWN and this intent will only be reconciled", cause);
  }
  process.stdout.write(`${JSON.stringify({ state: receipt.state, operation_ref: plan.operation_ref, plan_sha256: planSha, restore_id: expected.rows.binding.restore_id })}\n`);
  return { state: receipt.state, plan_sha256: planSha };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRestoreAdmissionInstall().catch((error) => {
    process.stderr.write(`${error?.message ?? "restore admission install failed"}\n`);
    process.exitCode = 2;
  });
}
