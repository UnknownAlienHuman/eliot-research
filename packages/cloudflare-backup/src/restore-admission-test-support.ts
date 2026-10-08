import type { DatabaseSync } from "node:sqlite";
import { backupSha256Hex, canonicalBackupJson } from "@eliotr/backup-o2";
import type { RestoreAdmissionBinding, RestoreAdmissionRequest } from "./restore-admission.js";

/** Creates an exact in-memory fixture grant; production never imports this module. */
export async function makeTestRestoreAdmissionBinding(database: DatabaseSync, request: RestoreAdmissionRequest,
  options: { readonly persist?: boolean; readonly created_at: string; readonly operatorIssuerAccountId?: string } ): Promise<RestoreAdmissionBinding> {
  const json = canonicalBackupJson;
  const intentSha = await backupSha256Hex(json(request.intent));
  const actorSha = await backupSha256Hex(json(request.actor));
  const primarySha = await backupSha256Hex(json(request.primary));
  const requestSha = await backupSha256Hex(json(request));
  const profile = { protocol: "eliotr.backup-restore-target-profile.v1", profile_ref: request.target_profile.profile_ref,
    revision: request.target_profile.revision, account_id: request.target.account_id,
    failure_domain: request.target.failure_domain, environment_ref: request.target.environment_ref,
    deployment_ref: request.target.deployment_ref, configuration_sha256: request.target.configuration_sha256,
    resources: request.target.resources, created_at: options.created_at };
  const profileSha = await backupSha256Hex(json(profile));
  if (profileSha !== request.target_profile.profile_sha256) throw new Error("fixture profile digest differs from its pinned request");
  const validFrom = options.created_at;
  const expiresAt = request.actor.expires_at;
  const permission = {
    protocol: "eliotr.backup-restore-permission.v1", permission_ref: request.permission_ref,
    revision: request.permission_revision,
    operator_issuer: { protocol: "eliotr.backup-restore-operator-issuer.v1", authentication_method: "wrangler-oauth",
      account_id: options.operatorIssuerAccountId ?? request.primary.account_id, confirmed_plan_sha256: requestSha, issued_at: options.created_at },
    actor: request.actor, intent: request.intent, intent_sha256: intentSha,
    restore_id: request.restore_id, restore_intent_digest: request.restore_intent_digest,
    epoch_id: request.epoch_id, offsite_copy_ref: request.offsite_copy_ref,
    copy_authority_sha256: request.copy_authority_sha256, primary: request.primary, primary_binding_sha256: primarySha,
    target_profile: request.target_profile, request_sha256: requestSha, migration_ledger_digest: request.migration_ledger_digest,
    purge_ledger_revision: request.purge_ledger_revision, purge_ledger_digest: request.purge_ledger_digest,
    valid_from: validFrom, expires_at: expiresAt, created_at: options.created_at,
  };
  const permissionSha = await backupSha256Hex(json(permission));
  const bindingCore = {
    restore_id: request.restore_id, permission_ref: request.permission_ref, permission_revision: request.permission_revision,
    permission_sha256: permissionSha, restore_intent_digest: request.restore_intent_digest, intent_sha256: intentSha,
    actor_sha256: actorSha, actor_expires_at: request.actor.expires_at, copy_authority_sha256: request.copy_authority_sha256,
    primary_binding_sha256: primarySha, request_sha256: requestSha, profile_ref: request.target_profile.profile_ref,
    profile_revision: request.target_profile.revision, profile_sha256: profileSha,
    valid_from: validFrom, expires_at: expiresAt,
  };
  const bindingJson = json({ protocol: "eliotr.backup-restore-admission-binding.v1", ...bindingCore, created_at: options.created_at });
  const bindingSha = await backupSha256Hex(bindingJson);
  if (options.persist === true) {
    database.prepare("INSERT OR IGNORE INTO backup_restore_target_profile(profile_ref,revision,profile_json,profile_sha256,account_id,failure_domain,environment_ref,deployment_ref,configuration_sha256,resources_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(profile.profile_ref, profile.revision, json(profile), profileSha, profile.account_id, profile.failure_domain,
        profile.environment_ref, profile.deployment_ref, profile.configuration_sha256, json(profile.resources), profile.created_at);
    database.prepare("INSERT OR IGNORE INTO backup_restore_permission(permission_ref,revision,permission_json,permission_sha256,restore_id,restore_intent_digest,intent_sha256,actor_sha256,request_sha256,actor_expires_at,epoch_id,offsite_copy_ref,copy_authority_sha256,primary_binding_sha256,profile_ref,profile_revision,profile_sha256,migration_ledger_digest,purge_ledger_revision,purge_ledger_digest,valid_from,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(permission.permission_ref, permission.revision, json(permission), permissionSha, permission.restore_id,
        permission.restore_intent_digest, intentSha, actorSha, requestSha, request.actor.expires_at, request.epoch_id,
        request.offsite_copy_ref, request.copy_authority_sha256, primarySha, request.target_profile.profile_ref,
        request.target_profile.revision, profileSha, request.migration_ledger_digest, request.purge_ledger_revision,
        request.purge_ledger_digest, validFrom, expiresAt, options.created_at);
    database.prepare("INSERT OR IGNORE INTO backup_restore_admission_binding(restore_id,permission_ref,permission_revision,permission_sha256,restore_intent_digest,intent_sha256,actor_sha256,actor_expires_at,copy_authority_sha256,primary_binding_sha256,request_sha256,profile_ref,profile_revision,profile_sha256,valid_from,expires_at,binding_json,binding_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(bindingCore.restore_id, bindingCore.permission_ref, bindingCore.permission_revision, permissionSha,
        bindingCore.restore_intent_digest, intentSha, actorSha, request.actor.expires_at, request.copy_authority_sha256,
        primarySha, requestSha, bindingCore.profile_ref, bindingCore.profile_revision, profileSha, validFrom,
        expiresAt, bindingJson, bindingSha, options.created_at);
  }
  return { ...bindingCore, binding_sha256: bindingSha };
}
