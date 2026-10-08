#!/usr/bin/env node
// Native OAuth operator for one reviewed isolated primary-writer qualification.
// It reads the live Worker/R2/owner inventory first, then performs D1 CAS only.
// It never creates a bucket, deploys a Worker, or accepts caller-provided proof.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createCloudflaredOwnerFetch } from "../../scripts/lib/cloudflare-owner-http.mjs";
import { WRANGLER_OAUTH_MODE, injectOAuthBearer, loadWranglerOAuthCredential, resolveAuthMode, verifyWranglerOAuthAccount } from "../../scripts/lib/cloudflare-wrangler-oauth.mjs";
import { createCloudflareD1HttpDatabase } from "../../scripts/lib/cloudflare-d1-http.mjs";
import { loadCompiledWorkspaceModule } from "../../scripts/lib/compiled-workspace-module.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const API = "https://api.cloudflare.com/client/v4";
const STATE = resolve(ROOT, ".eliotr-state", "backup-primary-writer");
const PLAN_PROTOCOL = "eliotr.backup-primary-writer-qualification-plan.v1";
const DEPLOYMENT_PROOF_PROTOCOL = "eliotr.backup-primary-writer-deployment-proof.v1";
const READ_PROTOCOL = "eliotr.backup-primary-writer-read.v1";
const OPERATION_PROTOCOL = "eliotr.backup-primary-writer-operation.v1";
const ADMISSION_PROTOCOL = "eliotr.backup-primary-writer-admission.v1";
const ADMISSION_BODY_KEYS = ["protocol", "admission_ref", "purpose", "principal_ref", "client_class", "credential_generation", "issuer", "authentication_method", "access_expires_at", "deployment_generation", "version_id", "bucket_binding_ref"];
const OPERATION_KEYS = ["operation_ref", "qualification_ref", "qualification_revision", "intent", "intent_sha256", "attempt", "attempt_sha256", "receipt", "receipt_sha256", "readback_receipt_ref", "readback_sha256", "state", "created_at", "updated_at"];
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const EVIDENCE_DIRECTORY = /^\.eliotr-state\/deployment-build-evidence-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKER_DIRECTORY = /^\.eliotr-state\/deployment-worker-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const fail = (message, cause) => { throw new Error(message, cause === undefined ? undefined : { cause }); };
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) ?? "null" : Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const id = (value, label) => { if (typeof value !== "string" || !ID.test(value)) fail(`${label} is malformed`); return value; };
const digest = (value, label) => { if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} is not SHA-256`); return value; };
const object = (value, label) => { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not an object`); return value; };
const exactKeys = (value, keys, label) => { object(value, label); const actual = Object.keys(value).sort(); const wanted = [...keys].sort(); if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) fail(`${label} contains unknown or missing fields`); };

export function assertPrimaryBucketBinding(bindings, bucketName) {
  if (!Array.isArray(bindings)) fail("active Worker bindings are absent or malformed");
  const matches = bindings.filter((entry) => entry?.name === "BACKUP_PARTS_BUCKET");
  if (matches.length !== 1) fail("active Worker must expose exactly one BACKUP_PARTS_BUCKET binding");
  const binding = object(matches[0], "BACKUP_PARTS_BUCKET binding");
  if (binding.type !== "r2_bucket" || binding.bucket_name !== bucketName) fail("BACKUP_PARTS_BUCKET binding type or bucket name differs from the reviewed R2 target");
  return binding;
}

function primaryOperationRow(operation, operationJson = canonical({ protocol: OPERATION_PROTOCOL, operation })) {
  return {
    operation_ref: operation.operation_ref,
    qualification_ref: operation.qualification_ref,
    qualification_revision: operation.qualification_revision,
    intent_ref: operation.intent.intent_ref.id,
    intent_revision: operation.intent.intent_ref.revision,
    intent_json: canonical(operation.intent),
    intent_sha256: operation.intent_sha256,
    attempt_id: operation.attempt.attempt_id,
    attempt_number: operation.attempt.attempt_number,
    attempt_json: canonical(operation.attempt),
    attempt_sha256: operation.attempt_sha256,
    receipt_ref: operation.receipt.receipt_ref.id,
    operation_json: operationJson,
    receipt_json: canonical(operation.receipt),
    receipt_sha256: operation.receipt_sha256,
    readback_receipt_ref: operation.readback_receipt_ref,
    readback_sha256: operation.readback_sha256,
    state: operation.state,
    created_at: operation.created_at,
    updated_at: operation.updated_at,
  };
}

function args(argv) {
  const result = { plan: null, context: null, mode: "read", deploymentProof: null, operationRef: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--plan") result.plan = argv[++i] ?? null;
    else if (argv[i] === "--context") result.context = argv[++i] ?? null;
    else if (argv[i] === "--read") result.mode = "read";
    else if (argv[i] === "--discover") result.mode = "discover";
    else if (argv[i] === "--apply") result.mode = "apply";
    else if (argv[i] === "--reconcile") result.mode = "reconcile";
    else if (argv[i] === "--operation-ref") result.operationRef = argv[++i] ?? null;
    else if (argv[i] === "--deployment-proof") result.deploymentProof = argv[++i] ?? null;
    else if (argv[i] === "--confirm-live") result.confirm = true;
    else fail(`unknown argument ${argv[i]}`);
  }
  if (result.mode === "discover") {
    if (result.plan !== null) fail("--discover accepts --context, not --plan");
    if (result.context === null) fail("--discover requires --context");
    if (result.deploymentProof === null) fail("--discover requires --deployment-proof referencing the successful deployment receipt");
  } else if (result.plan === null) fail("--plan is required");
  if (result.mode === "apply" && result.confirm !== true) fail("--apply requires --confirm-live");
  if (result.mode === "apply" && result.deploymentProof === null) fail("--apply requires --deployment-proof referencing the successful deployment receipt");
  if (result.mode === "reconcile" && result.operationRef === null) fail("--reconcile requires --operation-ref");
  if (result.mode === "reconcile" && result.confirm === true) fail("--reconcile is read-only and does not accept --confirm-live");
  return result;
}

async function readPlan(path) {
  const bytes = await readFile(resolve(path));
  const text = bytes.toString("utf8");
  let value;
  try { value = JSON.parse(text); } catch (cause) { fail("qualification plan is not JSON", cause); }
  const plan = object(value, "plan");
  exactKeys(plan, ["protocol", "operation_ref", "account_id", "database_id", "worker_name", "owner_origin", "bucket_binding_ref", "bucket_name", "qualification", "operation"], "plan");
  if (plan.protocol !== PLAN_PROTOCOL) fail("unsupported qualification plan protocol");
  id(plan.operation_ref, "operation_ref"); id(plan.account_id, "account_id"); id(plan.database_id, "database_id"); id(plan.worker_name, "worker_name");
  if (typeof plan.owner_origin !== "string" || !plan.owner_origin.startsWith("https://")) fail("owner_origin must be an HTTPS origin");
  id(plan.bucket_binding_ref, "bucket_binding_ref"); id(plan.bucket_name, "bucket_name");
  const qualification = object(plan.qualification, "qualification");
  const operation = object(plan.operation, "operation");
  exactKeys(operation, OPERATION_KEYS, "operation");
  const shared = await loadCompiledWorkspaceModule("packages/cloudflare-backup/dist/primary-writer-qualification.js");
  const parsedQualification = await shared.parsePrimaryWriterQualification({ ...qualification, authority_sha256: sha256(canonical(qualification)) });
  if (canonical(parsedQualification) !== canonical(qualification)) fail("qualification is not the canonical shared primary-writer authority");
  const parsedOperation = await shared.parsePrimaryWriterOperation(primaryOperationRow(operation));
  if (canonical(parsedOperation) !== canonical(operation)) fail("operation is not the canonical shared primary-writer envelope");
  if (qualification.protocol !== "eliotr.backup-primary-writer-qualification.v1" || qualification.mode !== "ISOLATED_NEW_BUCKET" || qualification.erasure_mode !== "NO_ACTIVE_ERASURE") fail("only an isolated NO_ACTIVE_ERASURE bootstrap can be installed");
  if (qualification.cloudflare?.account_id !== plan.account_id || qualification.cloudflare?.worker_name !== plan.worker_name || qualification.cloudflare?.bucket_binding_ref !== plan.bucket_binding_ref || qualification.cloudflare?.bucket_name !== plan.bucket_name) fail("qualification Cloudflare identity differs from plan");
  for (const [key, value] of Object.entries(qualification.cloudflare ?? {})) if (["source_sha256", "configuration_sha256", "compiled_artifact_sha256"].includes(key)) digest(value, `qualification.cloudflare.${key}`);
  digest(qualification.evidence_digest, "qualification.evidence_digest");
  if (operation.operation_ref !== plan.operation_ref || operation.intent?.operation_kind !== "BACKUP") fail("operation is not a BACKUP operation");
  return { plan, plan_sha256: sha256(canonical(plan)) };
}

async function readBootstrapAdmission(database, plan, proof) {
  const q = plan.qualification;
  const operation = plan.operation;
  const admissionRows = await database.prepare("SELECT admission_ref,protocol,purpose,admission_json,admission_sha256,principal_ref,client_class,credential_generation,issuer,authentication_method,access_expires_at,deployment_generation,version_id,bucket_binding_ref,created_at FROM backup_primary_writer_admission WHERE admission_ref=?1 AND admission_sha256=?2 LIMIT 2").bind(q.owner_admission_ref, q.owner_admission_sha256).all();
  if (!Array.isArray(admissionRows?.results) || admissionRows.results.length !== 1) fail("bootstrap admission must resolve to exactly one persisted grant");
  const row = admissionRows.results[0];
  if (row.protocol !== ADMISSION_PROTOCOL || typeof row.admission_json !== "string") fail("bootstrap admission row is malformed");
  digest(row.admission_sha256, "bootstrap admission admission_sha256");
  let raw;
  try { raw = object(JSON.parse(row.admission_json), "bootstrap admission body"); } catch (cause) { fail("bootstrap admission body is malformed JSON", cause); }
  exactKeys(raw, ADMISSION_BODY_KEYS, "bootstrap admission body");
  const shared = await loadCompiledWorkspaceModule("packages/cloudflare-backup/dist/primary-writer-admission.js");
  if (typeof shared.parsePrimaryWriterBootstrapAdmission !== "function") fail("compiled bootstrap admission parser is unavailable");
  const admission = await shared.parsePrimaryWriterBootstrapAdmission({ ...raw, admission_sha256: row.admission_sha256 });
  if (canonical(admission) !== row.admission_json || sha256(row.admission_json) !== row.admission_sha256) fail("bootstrap admission canonical bytes or digest diverge");
  if (row.admission_ref !== admission.admission_ref || row.protocol !== admission.protocol || row.purpose !== admission.purpose ||
      row.principal_ref !== admission.principal_ref || row.client_class !== admission.client_class || row.credential_generation !== admission.credential_generation ||
      row.issuer !== admission.issuer || row.authentication_method !== admission.authentication_method || row.access_expires_at !== admission.access_expires_at ||
      row.deployment_generation !== admission.deployment_generation || row.version_id !== admission.version_id || row.bucket_binding_ref !== admission.bucket_binding_ref) {
    fail("bootstrap admission flattened columns diverge from its canonical body");
  }
  if (admission.admission_ref !== q.owner_admission_ref || row.admission_sha256 !== q.owner_admission_sha256 || admission.purpose !== "BOOTSTRAP" ||
      admission.client_class !== "owner_pwa" || admission.authentication_method !== "cloudflare_access" || admission.principal_ref !== operation.intent.principal_ref) {
    fail("bootstrap admission purpose or owner identity does not match the reviewed operation");
  }
  const deploymentProof = object(proof.deployment_proof, "actual deployment proof");
  if (admission.deployment_generation !== deploymentProof.controller_generation || admission.deployment_generation !== q.cloudflare.controller_generation ||
      admission.version_id !== deploymentProof.version_id || admission.version_id !== q.cloudflare.version_id ||
      admission.bucket_binding_ref !== proof.bucket_binding_ref || admission.bucket_binding_ref !== q.cloudflare.bucket_binding_ref ||
      admission.bucket_binding_ref !== "BACKUP_PARTS_BUCKET") fail("bootstrap admission does not match the actual deployment and binding proof");
  const liveRows = await database.prepare("SELECT admission_ref FROM backup_primary_writer_admission WHERE admission_ref=?1 AND admission_sha256=?2 AND julianday(access_expires_at) > julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')) LIMIT 2").bind(q.owner_admission_ref, q.owner_admission_sha256).all();
  if (!Array.isArray(liveRows?.results) || liveRows.results.length !== 1) fail("bootstrap admission is expired by the D1 clock");
  const revocationRows = await database.prepare("SELECT admission_ref,admission_sha256 FROM backup_primary_writer_admission_revocation WHERE admission_ref=?1 AND admission_sha256=?2 LIMIT 2").bind(q.owner_admission_ref, q.owner_admission_sha256).all();
  if (!Array.isArray(revocationRows?.results) || revocationRows.results.length !== 0) fail("bootstrap admission is revoked");
  return admission;
}

async function readDiscoveryContext(path) {
  const value = object(JSON.parse((await readFile(resolve(path))).toString("utf8")), "discovery context");
  exactKeys(value, ["protocol", "account_id", "database_id", "worker_name", "owner_origin", "bucket_binding_ref", "bucket_name"], "discovery context");
  if (value.protocol !== "eliotr.backup-primary-writer-qualification-context.v1") fail("unsupported discovery context protocol");
  id(value.account_id, "context.account_id"); id(value.database_id, "context.database_id"); id(value.worker_name, "context.worker_name");
  if (typeof value.owner_origin !== "string" || !value.owner_origin.startsWith("https://")) fail("context.owner_origin must be an HTTPS origin");
  if (value.bucket_binding_ref !== "BACKUP_PARTS_BUCKET") fail("context.bucket_binding_ref must be BACKUP_PARTS_BUCKET");
  id(value.bucket_name, "context.bucket_name");
  return value;
}

async function readDeploymentProof(path, plan) {
  const proof = object(JSON.parse((await readFile(resolve(path))).toString("utf8")), "deployment proof");
  exactKeys(proof, ["protocol", "deployment_receipt_path"], "deployment proof");
  if (proof.protocol !== DEPLOYMENT_PROOF_PROTOCOL) fail("unsupported deployment proof protocol");
  const readJson = async (filePath, label, expectedFileSha256 = null) => {
    if (typeof filePath !== "string" || filePath.length === 0) fail(`${label} is malformed`);
    const absolute = resolve(ROOT, filePath);
    const relative = resolve(ROOT).toLowerCase();
    if (!absolute.toLowerCase().startsWith(`${relative}${process.platform === "win32" ? "\\" : "/"}`)) fail(`${label} escaped the repository`);
    try {
      const bytes = await readFile(absolute);
      if (expectedFileSha256 !== null && sha256(bytes) !== expectedFileSha256) fail(`${label} file digest does not match build evidence`);
      return object(JSON.parse(bytes.toString("utf8")), label);
    }
    catch (cause) { fail(`${label} is not readable JSON`, cause); }
  };
  const receipt = await readJson(proof.deployment_receipt_path, "deployment receipt");
  if (receipt.protocol !== "eliotr.cloudflare-deployment-receipt.v1") fail("deployment proof contains an unsupported deployment receipt protocol");
  const evidence = object(receipt.build_evidence, "deployment receipt build_evidence");
  exactKeys(evidence, ["protocol", "scope", "source_head", "persisted_directory", "input_manifest", "bundle_attestation", "entrypoint", "generated_config"], "deployment build evidence");
  if (evidence.protocol !== "eliotr.deployment-build-evidence.v1" || evidence.scope !== "BOUNDED_LOCAL_INTEGRITY" || !/^[0-9a-f]{40}$/u.test(evidence.source_head ?? "")) fail("deployment build evidence protocol or source head is invalid");
  const manifestEvidence = object(evidence.input_manifest, "deployment build evidence input_manifest");
  const bundleEvidence = object(evidence.bundle_attestation, "deployment build evidence bundle_attestation");
  const entrypointEvidence = object(evidence.entrypoint, "deployment build evidence entrypoint");
  const configEvidence = object(evidence.generated_config, "deployment build evidence generated_config");
  exactKeys(manifestEvidence, ["path", "file_sha256", "manifest_sha256"], "deployment build evidence input_manifest");
  exactKeys(bundleEvidence, ["path", "file_sha256", "attestation_sha256"], "deployment build evidence bundle_attestation");
  exactKeys(entrypointEvidence, ["path", "raw_sha256", "byte_length"], "deployment build evidence entrypoint");
  exactKeys(configEvidence, ["path", "sha256", "byte_length"], "deployment build evidence generated_config");
  digest(manifestEvidence.file_sha256, "deployment input manifest file_sha256");
  digest(manifestEvidence.manifest_sha256, "deployment input manifest manifest_sha256");
  digest(bundleEvidence.file_sha256, "deployment bundle attestation file_sha256");
  digest(bundleEvidence.attestation_sha256, "deployment bundle attestation attestation_sha256");
  digest(entrypointEvidence.raw_sha256, "deployment entrypoint raw_sha256");
  digest(configEvidence.sha256, "deployment generated config sha256");
  if (typeof evidence.persisted_directory !== "string" || !EVIDENCE_DIRECTORY.test(evidence.persisted_directory) ||
      manifestEvidence.path !== `${evidence.persisted_directory}/deployment-build-inputs.json` ||
      bundleEvidence.path !== `${evidence.persisted_directory}/deployment-worker-bundle.json`) fail("deployment build evidence references escaped its emitted evidence directory");
  const manifest = await readJson(manifestEvidence.path, "deployment build inputs", manifestEvidence.file_sha256);
  const bundle = await readJson(bundleEvidence.path, "deployment bundle attestation", bundleEvidence.file_sha256);
  if (manifest.protocol !== "eliotr.deployment-build-inputs.v1" || bundle.protocol !== "eliotr.deployment-worker-bundle.v1") fail("deployment proof contains an unsupported build evidence protocol");
  if (manifest.root !== ROOT || bundle.root !== ROOT) fail("deployment evidence belongs to another workspace root");
  for (const [label, value, expected] of [["deployment build inputs", manifest, manifestEvidence.manifest_sha256], ["deployment bundle attestation", bundle, bundleEvidence.attestation_sha256]]) if (typeof value.sha256 !== "string" || sha256(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sha256")))) !== value.sha256 || value.sha256 !== expected) fail(`${label} digest does not match its body`);
  if (evidence.source_head !== manifest.git_head || bundle.manifest_sha256 !== manifest.sha256) fail("deployment build evidence source or manifest binding diverges");
  const slash = (value) => value.split("\\").join("/");
  if (typeof bundle.outdir !== "string" || !WORKER_DIRECTORY.test(slash(bundle.outdir)) || typeof bundle.entrypoint !== "string" || !/\.js$/u.test(bundle.entrypoint)) fail("deployment bundle output directory or entrypoint is invalid");
  if (slash(relative(ROOT, resolve(ROOT, bundle.entrypoint))) !== slash(entrypointEvidence.path)) fail("deployment build evidence entrypoint reference does not match the bundle attestation");
  const worker = object(receipt.worker, "deployment receipt worker");
  if (worker.id !== plan.worker_name || receipt.environment !== "production" || receipt.generated_config_sha256 !== configEvidence.sha256 || bundle.generated_config?.sha256 !== configEvidence.sha256 || bundle.generated_config?.path !== configEvidence.path || bundle.entrypoint_sha256 !== entrypointEvidence.raw_sha256 || bundle.bundle_bytes !== entrypointEvidence.byte_length) fail("deployment evidence identities do not match");
  if (configEvidence.path !== "apps/eliotr-core/wrangler.deploy.jsonc" || !Number.isSafeInteger(configEvidence.byte_length) || configEvidence.byte_length < 0 || !Number.isSafeInteger(entrypointEvidence.byte_length) || entrypointEvidence.byte_length < 0) fail("deployment build evidence file pins are malformed");
  const configPath = resolve(ROOT, configEvidence.path);
  const entryPath = resolve(ROOT, entrypointEvidence.path);
  const rootPrefix = resolve(ROOT).toLowerCase();
  for (const [label, filePath] of [["generated configuration", configPath], ["compiled Worker entrypoint", entryPath]]) if (!filePath.toLowerCase().startsWith(`${rootPrefix}${process.platform === "win32" ? "\\" : "/"}`)) fail(`${label} escaped the repository`);
  const configBytes = await readFile(configPath);
  const entryBytes = await readFile(entryPath);
  if (configBytes.byteLength !== configEvidence.byte_length || entryBytes.byteLength !== entrypointEvidence.byte_length || sha256(configBytes) !== configEvidence.sha256 || sha256(entryBytes) !== entrypointEvidence.raw_sha256) fail("deployment evidence raw file readback diverges");
  return { deployment_id: worker.deployment_id, version_id: worker.version_id, version_etag: worker.version_etag, controller_generation: receipt.deployment_generation, source_head: evidence.source_head, source_sha256: manifest.sha256, configuration_sha256: configEvidence.sha256, compiled_artifact_sha256: entrypointEvidence.raw_sha256, input_manifest_file_sha256: manifestEvidence.file_sha256, bundle_attestation_file_sha256: bundleEvidence.file_sha256, bundle_attestation_sha256: bundleEvidence.attestation_sha256 };
}

async function officialFetch(token, path) {
  const response = await globalThis.fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) fail(`Cloudflare official read failed (${response.status})`);
  return payload.result;
}

async function openD1(plan) {
  if (resolveAuthMode(process.env) !== WRANGLER_OAUTH_MODE) fail("ELIOTR_CLOUDFLARE_AUTH_MODE must be wrangler-oauth");
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== plan.account_id) fail("CLOUDFLARE_ACCOUNT_ID differs from the plan");
  const whoami = await import("node:child_process").then(({ spawnSync }) => spawnSync("pnpm", ["exec", "wrangler", "whoami"], { cwd: ROOT, env: process.env, encoding: "utf8", shell: process.platform === "win32", windowsHide: true }));
  if (whoami.status !== 0) fail("Wrangler OAuth whoami failed");
  await verifyWranglerOAuthAccount({ expectedAccountId: plan.account_id, getWhoamiOutput: async () => whoami.stdout ?? "" });
  const credential = await loadWranglerOAuthCredential({ env: process.env, now: Date.now() });
  const token = injectOAuthBearer(process.env, credential.bearer).CLOUDFLARE_API_TOKEN;
  return { token, database: createCloudflareD1HttpDatabase({ account_id: plan.account_id, database_id: plan.database_id, api_token: token, api_base_url: API }) };
}

async function d1Count(database, table) {
  const row = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
  if (row === null || !Number.isSafeInteger(row.count) || row.count < 0) fail(`D1 ${table} count is malformed`);
  return row.count;
}

function withoutObservedAt(value) {
  const row = object(value, "observed readback");
  const stable = { ...row };
  delete stable.observed_at;
  return stable;
}

function assertFreshBootstrapBinding(plan, proof) {
  const q = plan.qualification;
  const actualZero = withoutObservedAt(proof.zero);
  const plannedZero = withoutObservedAt(q.bootstrap_zero_d1);
  if (canonical(actualZero) !== canonical(plannedZero)) fail("fresh D1 zero readback does not match the reviewed bootstrap baseline");
  const actualPrefix = withoutObservedAt({
    protocol: proof.owner_inventory.protocol === "eliotr.backup-primary-inventory.v1" ? "eliotr.backup-primary-prefix-readback.v1" : undefined,
    bucket_binding_ref: proof.owner_inventory.bucket_binding_ref,
    bucket_name: proof.bucket_name,
    prefix: proof.owner_inventory.prefix,
    object_count: proof.owner_inventory.object_count,
    inventory_digest: proof.owner_inventory.inventory_digest,
  });
  if (canonical(actualPrefix) !== canonical(withoutObservedAt(q.reserved_prefix_readback))) fail("fresh primary-prefix readback does not match the reviewed bootstrap baseline");
  if (q.reserved_prefix_readback_sha256 !== sha256(canonical(q.reserved_prefix_readback))) fail("qualification reserved-prefix digest is not the digest of its persisted readback");
  if (q.producer_claim_count !== proof.zero.producer_claim_count || q.export_cut_count !== proof.zero.export_cut_count || q.primary_prefix_count !== proof.owner_inventory.object_count ||
      q.producer_claim_digest !== proof.producer_claim_digest || q.export_cut_digest !== proof.export_cut_digest || q.primary_prefix_digest !== proof.owner_inventory.inventory_digest) fail("fresh load-bearing inventory does not match the reviewed qualification");
  if (q.cloudflare.deployment_id !== proof.deployment_id || q.cloudflare.version_id !== proof.version_id || q.cloudflare.version_etag !== proof.version_etag || (proof.deployment_proof !== undefined && q.cloudflare.controller_generation !== proof.deployment_proof.controller_generation)) fail("fresh Worker identity does not match the reviewed qualification");
  if (proof.deployment_proof !== undefined && (q.cloudflare.source_sha256 !== proof.deployment_proof.source_sha256 || q.cloudflare.configuration_sha256 !== proof.deployment_proof.configuration_sha256 || q.cloudflare.compiled_artifact_sha256 !== proof.deployment_proof.compiled_artifact_sha256)) fail("fresh deployment evidence does not match the reviewed qualification");
  if (plan.operation.readback_sha256 !== proof.worker_readback_sha256) fail("typed operation readback digest is not bound to the fresh Worker readback");
  if (proof.deployment_proof !== undefined) {
    const evidence = {
      protocol: "eliotr.backup-primary-writer-qualification-evidence.v1",
      qualification_ref: q.qualification_ref,
      qualification_revision: q.revision,
      owner_admission_ref: q.owner_admission_ref,
      owner_admission_sha256: q.owner_admission_sha256,
      account_id: q.cloudflare.account_id,
      worker_name: q.cloudflare.worker_name,
      deployment_id: proof.deployment_id,
      version_id: proof.version_id,
      version_etag: proof.version_etag,
      controller_generation: q.cloudflare.controller_generation,
      source_sha256: proof.deployment_proof.source_sha256,
      configuration_sha256: proof.deployment_proof.configuration_sha256,
      compiled_artifact_sha256: proof.deployment_proof.compiled_artifact_sha256,
      bucket_binding_ref: q.cloudflare.bucket_binding_ref,
      bucket_name: q.cloudflare.bucket_name,
      reserved_prefix: q.cloudflare.reserved_prefix,
      bootstrap_zero_d1: actualZero,
      reserved_prefix_readback: actualPrefix,
      producer_claim_count: proof.zero.producer_claim_count,
      producer_claim_digest: proof.producer_claim_digest,
      export_cut_count: proof.zero.export_cut_count,
      export_cut_digest: proof.export_cut_digest,
      primary_prefix_count: proof.owner_inventory.object_count,
      primary_prefix_digest: proof.owner_inventory.inventory_digest,
    };
    if (q.evidence_digest !== sha256(canonical(evidence))) fail("qualification evidence digest is not recomputable from the fresh deployment and inventory proof");
  }
}

async function collectProof(plan, token, database, deploymentProof = null) {
  const buckets = await officialFetch(token, `/accounts/${encodeURIComponent(plan.account_id)}/r2/buckets`);
  if (!Array.isArray(buckets?.buckets) || buckets.buckets.filter((entry) => entry?.name === plan.bucket_name).length !== 1) fail("planned R2 bucket is absent or ambiguous; operator will not create it");
  const deployments = await officialFetch(token, `/accounts/${encodeURIComponent(plan.account_id)}/workers/scripts/${encodeURIComponent(plan.worker_name)}/deployments`);
  const active = deployments?.deployments?.[0];
  if (active?.strategy !== "percentage" || active?.versions?.length !== 1 || active.versions[0]?.percentage !== 100 || typeof active.versions[0]?.version_id !== "string") fail("active Worker is absent, split, or not 100% one version");
  const versionId = active.versions[0].version_id;
  const version = await officialFetch(token, `/accounts/${encodeURIComponent(plan.account_id)}/workers/scripts/${encodeURIComponent(plan.worker_name)}/versions/${encodeURIComponent(versionId)}`);
  const etag = version?.resources?.script?.etag;
  if (typeof etag !== "string" || etag.length === 0 || versionId !== plan.qualification.cloudflare.version_id || active.id !== plan.qualification.cloudflare.deployment_id || etag !== plan.qualification.cloudflare.version_etag) fail("active Worker version differs from the reviewed qualification pins");
  if (deploymentProof !== null && (deploymentProof.deployment_id !== active.id || deploymentProof.version_id !== versionId || deploymentProof.version_etag !== etag || deploymentProof.controller_generation !== plan.qualification.cloudflare.controller_generation || deploymentProof.source_sha256 !== plan.qualification.cloudflare.source_sha256 || deploymentProof.configuration_sha256 !== plan.qualification.cloudflare.configuration_sha256 || deploymentProof.compiled_artifact_sha256 !== plan.qualification.cloudflare.compiled_artifact_sha256)) fail("deployment proof does not match the reviewed qualification and active Worker");
  const bindings = version?.resources?.bindings;
  if (plan.bucket_binding_ref !== "BACKUP_PARTS_BUCKET") fail("unsupported primary bucket binding reference");
  assertPrimaryBucketBinding(bindings, plan.bucket_name);
  const ownerFetch = createCloudflaredOwnerFetch({ origin: plan.owner_origin, environment: process.env });
  const response = await ownerFetch(`${plan.owner_origin}/api/v1/system/backup-primary/inventory`, { headers: { Accept: "application/json" } });
  const inventory = await response.json().catch(() => null);
  if (response.status !== 200 || inventory?.protocol !== "eliotr.backup-primary-inventory.v1" || inventory.bucket_binding_ref !== plan.bucket_binding_ref || inventory.prefix !== "backup-parts/" || inventory.object_count !== 0 || inventory.version_metadata?.version_id !== versionId || inventory.version_metadata?.controller_generation !== plan.qualification.cloudflare.controller_generation || !SHA256.test(inventory.inventory_digest)) fail("owner runtime did not return an exact current empty primary-prefix proof");
  const counts = {};
  const rows = {};
  for (const table of ["backup_epoch", "backup_epoch_receipt", "backup_export_cut", "erasure_case", "erasure_execution", "backup_epoch_producer_claim"]) { counts[table] = await d1Count(database, table); rows[table] = (await database.prepare(`SELECT * FROM ${table} ORDER BY 1 LIMIT 100001`).all()).results; }
  if (Object.values(counts).some((count) => count !== 0)) fail("bootstrap D1 baseline is not zero");
  const zero = { protocol: "eliotr.backup-primary-zero-baseline.v1", epoch_count: counts.backup_epoch, receipt_count: counts.backup_epoch_receipt, export_cut_count: counts.backup_export_cut, erasure_case_count: counts.erasure_case, erasure_execution_count: counts.erasure_execution, producer_claim_count: counts.backup_epoch_producer_claim, primary_prefix_count: inventory.object_count, observed_at: new Date().toISOString() };
  const producerClaimDigest = sha256(canonical(rows.backup_epoch_producer_claim));
  const exportCutDigest = sha256(canonical(rows.backup_export_cut));
  if (producerClaimDigest !== plan.qualification.producer_claim_digest || exportCutDigest !== plan.qualification.export_cut_digest || inventory.inventory_digest !== plan.qualification.primary_prefix_digest) fail("live inventory digest differs from the reviewed qualification");
  const proof = { protocol: READ_PROTOCOL, account_id: plan.account_id, worker_name: plan.worker_name, deployment_id: active.id, version_id: versionId, version_etag: etag, bucket_name: plan.bucket_name, bucket_binding_ref: plan.bucket_binding_ref, owner_inventory: inventory, zero, producer_claim_digest: producerClaimDigest, export_cut_digest: exportCutDigest, worker_readback_sha256: sha256(canonical({ deployment_id: active.id, version_id: versionId, version_etag: etag })), ...(deploymentProof === null ? {} : { deployment_proof: deploymentProof }), observed_at: new Date().toISOString() };
  assertFreshBootstrapBinding(plan, proof);
  return proof;
}

async function collectDiscoveryProof(context, token, database, deploymentProof) {
  const buckets = await officialFetch(token, `/accounts/${encodeURIComponent(context.account_id)}/r2/buckets`);
  if (!Array.isArray(buckets?.buckets) || buckets.buckets.filter((entry) => entry?.name === context.bucket_name).length !== 1) fail("discovery R2 bucket is absent or ambiguous; operator will not create it");
  const deployments = await officialFetch(token, `/accounts/${encodeURIComponent(context.account_id)}/workers/scripts/${encodeURIComponent(context.worker_name)}/deployments`);
  const active = deployments?.deployments?.[0];
  if (active?.strategy !== "percentage" || active.versions?.length !== 1 || active.versions[0]?.percentage !== 100 || typeof active.versions[0]?.version_id !== "string") fail("discovery Worker is absent, split, or not 100% one version");
  const versionId = active.versions[0].version_id;
  const version = await officialFetch(token, `/accounts/${encodeURIComponent(context.account_id)}/workers/scripts/${encodeURIComponent(context.worker_name)}/versions/${encodeURIComponent(versionId)}`);
  const etag = version?.resources?.script?.etag;
  if (typeof etag !== "string" || etag.length === 0 || active.id !== deploymentProof.deployment_id || versionId !== deploymentProof.version_id || etag !== deploymentProof.version_etag) fail("discovery Worker identity differs from the successful deployment receipt");
  if (deploymentProof.controller_generation === undefined || typeof deploymentProof.controller_generation !== "string") fail("successful deployment receipt has no controller generation");
  assertPrimaryBucketBinding(version?.resources?.bindings, context.bucket_name);
  const ownerFetch = createCloudflaredOwnerFetch({ origin: context.owner_origin, environment: process.env });
  const response = await ownerFetch(`${context.owner_origin}/api/v1/system/backup-primary/inventory`, { headers: { Accept: "application/json" } });
  const inventory = await response.json().catch(() => null);
  if (response.status !== 200 || inventory?.protocol !== "eliotr.backup-primary-inventory.v1" || inventory.bucket_binding_ref !== context.bucket_binding_ref || inventory.prefix !== "backup-parts/" || inventory.version_metadata?.version_id !== versionId || inventory.version_metadata?.controller_generation !== deploymentProof.controller_generation || !SHA256.test(inventory.inventory_digest)) fail("owner runtime did not return an exact current primary-prefix proof");
  const counts = {};
  const rows = {};
  for (const table of ["backup_epoch", "backup_epoch_receipt", "backup_export_cut", "erasure_case", "erasure_execution", "backup_epoch_producer_claim"]) { counts[table] = await d1Count(database, table); rows[table] = (await database.prepare(`SELECT * FROM ${table} ORDER BY 1 LIMIT 100001`).all()).results; }
  const zero = { protocol: "eliotr.backup-primary-zero-baseline.v1", epoch_count: counts.backup_epoch, receipt_count: counts.backup_epoch_receipt, export_cut_count: counts.backup_export_cut, erasure_case_count: counts.erasure_case, erasure_execution_count: counts.erasure_execution, producer_claim_count: counts.backup_epoch_producer_claim, primary_prefix_count: inventory.object_count, observed_at: new Date().toISOString() };
  const producerClaimDigest = sha256(canonical(rows.backup_epoch_producer_claim));
  const exportCutDigest = sha256(canonical(rows.backup_export_cut));
  return {
    protocol: READ_PROTOCOL,
    mode: "DISCOVERY",
    account_id: context.account_id,
    database_id: context.database_id,
    worker_name: context.worker_name,
    bucket_name: context.bucket_name,
    bucket_binding_ref: context.bucket_binding_ref,
    deployment_id: active.id,
    version_id: versionId,
    version_etag: etag,
    controller_generation: deploymentProof.controller_generation,
    deployment_proof: deploymentProof,
    owner_inventory: inventory,
    d1: { counts, producer_claim_digest: producerClaimDigest, export_cut_digest: exportCutDigest },
    producer_claim_digest: producerClaimDigest,
    export_cut_digest: exportCutDigest,
    zero,
    worker_readback_sha256: sha256(canonical({ deployment_id: active.id, version_id: versionId, version_etag: etag })),
    observed_at: new Date().toISOString(),
  };
}

async function saveReceipt(operationRef, value) { await mkdir(STATE, { recursive: true }); const path = resolve(STATE, `${operationRef}.read.json`); await writeFile(path, `${canonical(value)}\n`, "utf8"); return path; }

export async function apply(plan, planSha, proof, database) {
  const q = plan.qualification;
  const operation = plan.operation;
  const authorityJson = canonical(q);
  const authoritySha = sha256(authorityJson);
  const now = new Date().toISOString();
  try {
    const priorQualification = await database.prepare("SELECT qualification_ref,revision,authority_json,authority_sha256 FROM backup_primary_writer_qualification LIMIT 2").first();
    const priorCurrent = await database.prepare("SELECT slot,qualification_ref,qualification_revision,qualification_sha256,controller_generation,state FROM backup_primary_writer_current LIMIT 2").first();
    const priorOperation = await database.prepare("SELECT operation_ref,state FROM backup_primary_writer_operation LIMIT 2").first();
    if (priorQualification !== null || priorCurrent !== null || priorOperation !== null) fail("existing qualification, current pointer, or operation requires read-only --reconcile; apply will not replay a prior UNKNOWN attempt");
    await readBootstrapAdmission(database, plan, proof);
    await database.prepare("INSERT OR IGNORE INTO backup_primary_writer_qualification(qualification_ref,revision,protocol,mode,authority_json,authority_sha256,owner_admission_ref,owner_admission_sha256,erasure_mode,producer_claim_count,producer_claim_digest,export_cut_count,export_cut_digest,primary_prefix_count,primary_prefix_digest,account_id,worker_name,deployment_id,version_id,version_etag,controller_generation,source_sha256,configuration_sha256,compiled_artifact_sha256,bucket_binding_ref,bucket_name,reserved_prefix,bootstrap_zero_d1_ref,bootstrap_zero_d1_json,bootstrap_zero_d1_sha256,reserved_prefix_readback_ref,reserved_prefix_readback_sha256,evidence_digest,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34)").bind(q.qualification_ref,q.revision,q.protocol,q.mode,authorityJson,authoritySha,q.owner_admission_ref,q.owner_admission_sha256,q.erasure_mode,q.producer_claim_count,q.producer_claim_digest,q.export_cut_count,q.export_cut_digest,q.primary_prefix_count,q.primary_prefix_digest,q.cloudflare.account_id,q.cloudflare.worker_name,proof.deployment_id,proof.version_id,proof.version_etag,q.cloudflare.controller_generation,q.cloudflare.source_sha256,q.cloudflare.configuration_sha256,q.cloudflare.compiled_artifact_sha256,q.cloudflare.bucket_binding_ref,q.cloudflare.bucket_name,q.cloudflare.reserved_prefix,q.bootstrap_zero_d1_ref,canonical(q.bootstrap_zero_d1),sha256(canonical(q.bootstrap_zero_d1)),q.reserved_prefix_readback_ref,q.reserved_prefix_readback_sha256,q.evidence_digest,now).run();
    await database.prepare("INSERT OR IGNORE INTO backup_primary_writer_current(slot,qualification_ref,qualification_revision,qualification_sha256,controller_generation,state,updated_at) VALUES('primary',?1,?2,?3,?4,'ACTIVE',?5)").bind(q.qualification_ref,q.revision,authoritySha,q.cloudflare.controller_generation,now).run();
    const qualificationBeforeCommit = await database.prepare("SELECT qualification_ref,revision,authority_json,authority_sha256,account_id,worker_name,deployment_id,version_id,version_etag,controller_generation,source_sha256,configuration_sha256,compiled_artifact_sha256,bucket_binding_ref,bucket_name,reserved_prefix,evidence_digest FROM backup_primary_writer_qualification WHERE qualification_ref=?1 AND revision=?2 LIMIT 2").bind(q.qualification_ref, q.revision).first();
    const currentBeforeCommit = await database.prepare("SELECT slot,qualification_ref,qualification_revision,qualification_sha256,controller_generation,state FROM backup_primary_writer_current WHERE slot='primary' LIMIT 2").first();
    if (qualificationBeforeCommit === null || qualificationBeforeCommit.authority_json !== authorityJson || qualificationBeforeCommit.authority_sha256 !== authoritySha || currentBeforeCommit === null || currentBeforeCommit.slot !== "primary" || currentBeforeCommit.qualification_ref !== q.qualification_ref || currentBeforeCommit.qualification_revision !== q.revision || currentBeforeCommit.qualification_sha256 !== authoritySha || currentBeforeCommit.controller_generation !== q.cloudflare.controller_generation || currentBeforeCommit.state !== "ACTIVE") fail("qualification/current CAS gate failed before operation commit; reconcile read-only");
    const attemptWithoutError = { ...operation.attempt };
    delete attemptWithoutError.error_code;
    const committedAttempt = { ...attemptWithoutError, state: "SUCCEEDED", ended_at: now };
    const committedReceipt = { ...operation.receipt, outcome: "SUCCEEDED", output_refs: [...new Set([...operation.receipt.output_refs, q.qualification_ref])], readback_receipt_refs: [...new Set([...operation.receipt.readback_receipt_refs, operation.readback_receipt_ref])], reconciliation_required: false, reason_codes: [] };
    const committedOperation = { ...operation, attempt: committedAttempt, attempt_sha256: sha256(canonical(committedAttempt)), receipt: committedReceipt, receipt_sha256: sha256(canonical(committedReceipt)), state: "COMMITTED", created_at: now, updated_at: now };
    const committedOperationJson = canonical({ protocol: OPERATION_PROTOCOL, operation: committedOperation });
    const shared = await loadCompiledWorkspaceModule("packages/cloudflare-backup/dist/primary-writer-qualification.js");
    await shared.parsePrimaryWriterOperation(primaryOperationRow(committedOperation, committedOperationJson));
    const operationWrite = await database.prepare("INSERT OR IGNORE INTO backup_primary_writer_operation(operation_ref,qualification_ref,qualification_revision,intent_ref,intent_revision,intent_json,intent_sha256,attempt_id,attempt_number,attempt_json,attempt_sha256,receipt_ref,operation_json,receipt_json,receipt_sha256,readback_receipt_ref,readback_sha256,state,created_at,updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'COMMITTED',?18,?18 WHERE EXISTS (SELECT 1 FROM backup_primary_writer_qualification WHERE qualification_ref=?2 AND revision=?3 AND authority_json=?20 AND authority_sha256=?21) AND EXISTS (SELECT 1 FROM backup_primary_writer_current WHERE slot='primary' AND qualification_ref=?2 AND qualification_revision=?3 AND qualification_sha256=?21 AND controller_generation=?19 AND state='ACTIVE')").bind(committedOperation.operation_ref,q.qualification_ref,q.revision, committedOperation.intent.intent_ref.id, committedOperation.intent.intent_ref.revision, canonical(committedOperation.intent), sha256(canonical(committedOperation.intent)), committedOperation.attempt.attempt_id, committedOperation.attempt.attempt_number, canonical(committedOperation.attempt), committedOperation.attempt_sha256, committedOperation.receipt.receipt_ref.id, committedOperationJson, canonical(committedOperation.receipt), committedOperation.receipt_sha256, committedOperation.readback_receipt_ref, committedOperation.readback_sha256, now, q.cloudflare.controller_generation, authorityJson, authoritySha).run();
    if (operationWrite.meta?.changes !== 1) fail("qualification/current conditional operation commit did not insert; reconcile read-only");
    const qualification = await database.prepare("SELECT qualification_ref,revision,authority_json,authority_sha256,account_id,worker_name,deployment_id,version_id,version_etag,controller_generation,source_sha256,configuration_sha256,compiled_artifact_sha256,bucket_binding_ref,bucket_name,reserved_prefix,evidence_digest FROM backup_primary_writer_qualification WHERE qualification_ref=?1 AND revision=?2 LIMIT 2").bind(q.qualification_ref, q.revision).first();
    if (qualification === null || qualification.qualification_ref !== q.qualification_ref || qualification.revision !== q.revision || qualification.authority_json !== authorityJson || qualification.authority_sha256 !== authoritySha || qualification.account_id !== q.cloudflare.account_id || qualification.worker_name !== q.cloudflare.worker_name || qualification.deployment_id !== proof.deployment_id || qualification.version_id !== proof.version_id || qualification.version_etag !== proof.version_etag || qualification.controller_generation !== q.cloudflare.controller_generation || qualification.source_sha256 !== q.cloudflare.source_sha256 || qualification.configuration_sha256 !== q.cloudflare.configuration_sha256 || qualification.compiled_artifact_sha256 !== q.cloudflare.compiled_artifact_sha256 || qualification.bucket_binding_ref !== q.cloudflare.bucket_binding_ref || qualification.bucket_name !== q.cloudflare.bucket_name || qualification.reserved_prefix !== q.cloudflare.reserved_prefix || qualification.evidence_digest !== q.evidence_digest) fail("primary qualification readback did not match all persisted pins");
    const persistedOperation = await database.prepare("SELECT operation_ref,qualification_ref,qualification_revision,intent_ref,intent_revision,intent_json,intent_sha256,attempt_id,attempt_number,attempt_json,attempt_sha256,receipt_ref,operation_json,receipt_json,receipt_sha256,readback_receipt_ref,readback_sha256,state FROM backup_primary_writer_operation WHERE operation_ref=?1 LIMIT 2").bind(committedOperation.operation_ref).first();
    if (persistedOperation === null || persistedOperation.operation_ref !== committedOperation.operation_ref || persistedOperation.qualification_ref !== q.qualification_ref || persistedOperation.qualification_revision !== q.revision || persistedOperation.intent_ref !== committedOperation.intent.intent_ref.id || persistedOperation.intent_revision !== committedOperation.intent.intent_ref.revision || persistedOperation.intent_json !== canonical(committedOperation.intent) || persistedOperation.intent_sha256 !== sha256(canonical(committedOperation.intent)) || persistedOperation.attempt_id !== committedOperation.attempt.attempt_id || persistedOperation.attempt_number !== committedOperation.attempt.attempt_number || persistedOperation.attempt_json !== canonical(committedOperation.attempt) || persistedOperation.attempt_sha256 !== committedOperation.attempt_sha256 || persistedOperation.receipt_ref !== committedOperation.receipt.receipt_ref.id || persistedOperation.operation_json !== committedOperationJson || persistedOperation.receipt_json !== canonical(committedOperation.receipt) || persistedOperation.receipt_sha256 !== committedOperation.receipt_sha256 || persistedOperation.readback_receipt_ref !== committedOperation.readback_receipt_ref || persistedOperation.readback_sha256 !== committedOperation.readback_sha256 || persistedOperation.state !== "COMMITTED") fail("primary operation readback did not match all typed pins");
    const current = await database.prepare("SELECT slot,qualification_ref,qualification_revision,qualification_sha256,controller_generation,state FROM backup_primary_writer_current WHERE slot='primary' LIMIT 2").first();
    if (current === null || current.slot !== "primary" || current.qualification_ref !== q.qualification_ref || current.qualification_revision !== q.revision || current.qualification_sha256 !== authoritySha || current.controller_generation !== q.cloudflare.controller_generation || current.state !== "ACTIVE") fail("primary current-authority readback did not match all pins");
  } catch (cause) { throw new Error("primary qualification apply is UNKNOWN; reconcile by exact operation readback", { cause }); }
  return { state: "COMMITTED", plan_sha256: planSha, operation_ref: plan.operation_ref, authority_sha256: authoritySha };
}

async function persistedOperation(row, shared) {
  const value = object(row, "persisted primary operation");
  const parsed = await shared.parsePrimaryWriterOperation(value);
  let outer;
  try { outer = object(JSON.parse(String(value.operation_json)), "persisted primary operation envelope"); } catch (cause) { fail("persisted primary operation envelope is malformed JSON", cause); }
  exactKeys(outer, ["protocol", "operation"], "persisted primary operation envelope");
  if (outer.protocol !== OPERATION_PROTOCOL || canonical(outer.operation) !== canonical(parsed)) fail("persisted primary operation envelope diverges from typed operation");
  return parsed;
}

export async function reconcile(plan, operationRef, database) {
  const shared = await loadCompiledWorkspaceModule("packages/cloudflare-backup/dist/primary-writer-qualification.js");
  const operationRow = await database.prepare("SELECT operation_ref,qualification_ref,qualification_revision,intent_ref,intent_revision,intent_json,intent_sha256,attempt_id,attempt_number,attempt_json,attempt_sha256,receipt_ref,operation_json,receipt_json,receipt_sha256,readback_receipt_ref,readback_sha256,state,created_at,updated_at FROM backup_primary_writer_operation WHERE operation_ref=?1 LIMIT 2").bind(operationRef).first();
  if (operationRow === null) return { state: "UNKNOWN_NO_OPERATION", operation_ref: operationRef, writes: 0, action: "do not retry apply; inspect the native D1 readback and operator logs" };
  let operation;
  try { operation = await persistedOperation(operationRow, shared); } catch (cause) { return { state: "UNKNOWN_MALFORMED_OPERATION", operation_ref: operationRef, writes: 0, error: cause instanceof Error ? cause.message : String(cause) }; }
  const qualificationRow = await database.prepare("SELECT qualification_ref,revision,authority_json,authority_sha256,account_id,worker_name,deployment_id,version_id,version_etag,controller_generation,source_sha256,configuration_sha256,compiled_artifact_sha256,bucket_binding_ref,bucket_name,reserved_prefix,evidence_digest FROM backup_primary_writer_qualification WHERE qualification_ref=?1 AND revision=?2 LIMIT 2").bind(operation.qualification_ref, operation.qualification_revision).first();
  const currentRow = await database.prepare("SELECT slot,qualification_ref,qualification_revision,qualification_sha256,controller_generation,state,updated_at FROM backup_primary_writer_current WHERE slot='primary' LIMIT 2").first();
  if (qualificationRow === null || currentRow === null) return { state: "UNKNOWN_INCOMPLETE_AUTHORITY", operation_ref: operationRef, writes: 0, action: "do not retry apply; qualification/current readback is incomplete" };
  let qualification;
  try {
    const rawQualification = JSON.parse(String(qualificationRow.authority_json));
    qualification = await shared.parsePrimaryWriterQualification({ ...rawQualification, authority_sha256: qualificationRow.authority_sha256 });
    if (canonical(qualification) !== canonical(rawQualification)) fail("persisted qualification is not canonical");
  } catch (cause) { return { state: "UNKNOWN_MALFORMED_QUALIFICATION", operation_ref: operationRef, writes: 0, error: cause instanceof Error ? cause.message : String(cause) }; }
  const exact = qualificationRow.qualification_ref === qualification.qualification_ref && qualificationRow.revision === qualification.revision && qualificationRow.authority_sha256 === sha256(canonical(qualification)) && currentRow.slot === "primary" && currentRow.qualification_ref === qualification.qualification_ref && currentRow.qualification_revision === qualification.revision && currentRow.qualification_sha256 === qualificationRow.authority_sha256 && currentRow.controller_generation === qualification.cloudflare.controller_generation && currentRow.state === "ACTIVE" && operation.state === "COMMITTED";
  return exact ? { state: "COMMITTED_VERIFIED", operation_ref: operationRef, qualification_ref: qualification.qualification_ref, qualification_revision: qualification.revision, controller_generation: qualification.cloudflare.controller_generation, writes: 0 } : { state: "UNKNOWN_CONFLICT", operation_ref: operationRef, qualification_ref: qualification.qualification_ref, qualification_revision: qualification.revision, current_state: currentRow.state, operation_state: operation.state, writes: 0, action: "do not retry apply; retain this readback for operator review" };
}

export async function runPrimaryWriterQualification(args = process.argv.slice(2)) {
  const parsed = argsParser(args);
  if (parsed.mode === "discover") {
    const context = await readDiscoveryContext(parsed.context);
    const deploymentProof = await readDeploymentProof(parsed.deploymentProof, { worker_name: context.worker_name });
    const { token, database } = await openD1(context);
    const proof = await collectDiscoveryProof(context, token, database, deploymentProof);
    const receiptPath = await saveReceipt(`discovery-${Date.now()}`, { protocol: READ_PROTOCOL, mode: "DISCOVERY", context, proof });
    const result = { state: "DISCOVERY_READ_ONLY_PASS", receipt_path: receiptPath, proof };
    process.stdout.write(`${canonical(result)}\n`);
    return result;
  }
  const { plan, plan_sha256: planSha } = await readPlan(parsed.plan); const { token, database } = await openD1(plan);
  if (parsed.mode === "reconcile") { const result = await reconcile(plan, parsed.operationRef, database); process.stdout.write(`${canonical(result)}\n`); return result; }
  const deploymentProof = parsed.deploymentProof === null ? null : await readDeploymentProof(parsed.deploymentProof, plan);
  const proof = await collectProof(plan, token, database, deploymentProof); const receiptPath = await saveReceipt(plan.operation_ref, { protocol: READ_PROTOCOL, plan_sha256: planSha, proof });
  if (parsed.mode === "read") { const result = { state: "READ_ONLY_PASS", plan_sha256: planSha, receipt_path: receiptPath, proof }; process.stdout.write(`${canonical(result)}\n`); return result; }
  const result = await apply(plan, planSha, proof, database); process.stdout.write(`${canonical({ ...result, receipt_path: receiptPath })}\n`); return result;
}

function argsParser(argv) { return args(argv); }

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runPrimaryWriterQualification().catch((error) => { process.stderr.write(`${error?.message ?? "primary writer qualification failed"}\n`); process.exitCode = 2; });
