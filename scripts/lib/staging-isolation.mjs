import { createHash } from "node:crypto";

const KEYS = ["protocol", "isolation", "account_id", "protected_account_ids", "access_hostname"];
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/u;
const fail = () => { throw new Error("Staging target declaration is missing, invalid, or overlaps protected resources"); };

function hostname(value) {
  return typeof value === "string" && value.length <= 253 && value.includes(".") &&
    value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

/**
 * An explicit operator target declaration is a destination guard, not an
 * authorization receipt. The existing provisioners use fixed names: only a
 * dedicated account is currently supported. Same-account isolation needs a
 * separately implemented/reviewed complete resource profile.
 *
 * This function is local and pure. It never prints account/hostname values or
 * accepts an "approved" flag as permission for a deployment.
 */
export function validateStagingTarget(env) {
  if (env.ELIOTR_ENVIRONMENT !== "staging") return null;
  const raw = env.ELIOTR_STAGING_TARGET_JSON;
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 8192) fail();
  let target;
  try { target = JSON.parse(raw); } catch { fail(); }
  if (target === null || typeof target !== "object" || Array.isArray(target) ||
      Object.keys(target).length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(target, key)) ||
      target.protocol !== "eliotr.staging-target.v1" || target.isolation !== "dedicated-account" ||
      typeof target.account_id !== "string" || !ACCOUNT.test(target.account_id) ||
      target.account_id !== env.CLOUDFLARE_ACCOUNT_ID || !hostname(target.access_hostname) ||
      target.access_hostname !== env.ELIOTR_ACCESS_HOSTNAME ||
      !Array.isArray(target.protected_account_ids) || target.protected_account_ids.length < 1 ||
      target.protected_account_ids.length > 32 ||
      target.protected_account_ids.some((id) => typeof id !== "string" || !ACCOUNT.test(id)) ||
      new Set(target.protected_account_ids).size !== target.protected_account_ids.length ||
      target.protected_account_ids.includes(target.account_id)) fail();
  const canonical = JSON.stringify({
    protocol: target.protocol,
    isolation: target.isolation,
    account_id: target.account_id,
    protected_account_ids: [...target.protected_account_ids].sort(),
    access_hostname: target.access_hostname,
  });
  return Object.freeze({
    protocol: "eliotr.staging-target-binding.v1",
    isolation: "dedicated-account",
    target_declaration_sha256: createHash("sha256").update(canonical).digest("hex"),
    account_id_sha256: createHash("sha256").update(target.account_id).digest("hex"),
  });
}
