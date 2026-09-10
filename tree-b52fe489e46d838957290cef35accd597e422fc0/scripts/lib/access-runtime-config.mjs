const AUD_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
const ACCESS_RECEIPT_PROTOCOL = "eliotr.cloudflare-access-receipt.v1";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeTeamOrigin(value, label = "ELIOTR_ACCESS_TEAM_DOMAIN") {
  const raw = required(value, label);
  let teamUrl;
  try {
    teamUrl = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    teamUrl.protocol !== "https:" ||
    teamUrl.username !== "" ||
    teamUrl.password !== "" ||
    teamUrl.port !== "" ||
    teamUrl.pathname !== "/" ||
    teamUrl.search !== "" ||
    teamUrl.hash !== "" ||
    !teamUrl.hostname.toLowerCase().endsWith(".cloudflareaccess.com")
  ) {
    throw new Error(`${label} must be one https://<team>.cloudflareaccess.com origin`);
  }
  return teamUrl.origin;
}

export function validateAudTag(value, label = "ELIOTR_ACCESS_AUDIENCE") {
  const raw = required(value, label);
  if (!AUD_TAG_PATTERN.test(raw)) {
    throw new Error(`${label} must be a bounded Cloudflare Access AUD tag`);
  }
  return raw;
}

function parseServicePrincipals(environment) {
  const rawPrincipals = environment.ELIOTR_ACCESS_SERVICE_PRINCIPALS ?? "";
  const servicePrincipals = rawPrincipals.trim() === ""
    ? []
    : rawPrincipals.split(",").map((value) => value.trim());
  if (
    servicePrincipals.length > 64 ||
    servicePrincipals.some((value) =>
      value.length === 0 ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f,]/.test(value)
    ) ||
    new Set(servicePrincipals).size !== servicePrincipals.length
  ) {
    throw new Error(
      "ELIOTR_ACCESS_SERVICE_PRINCIPALS must contain at most 64 unique bounded common_name values",
    );
  }
  return Object.freeze([...servicePrincipals]);
}

export function validateAccessRuntimeConfiguration(environment) {
  const teamDomain = normalizeTeamOrigin(
    environment.ELIOTR_ACCESS_TEAM_DOMAIN,
    "ELIOTR_ACCESS_TEAM_DOMAIN",
  );
  const audience = validateAudTag(
    environment.ELIOTR_ACCESS_AUDIENCE,
    "ELIOTR_ACCESS_AUDIENCE",
  );
  const servicePrincipals = parseServicePrincipals(environment);

  return Object.freeze({
    teamDomain,
    audience,
    servicePrincipals,
    servicePrincipalCount: servicePrincipals.length,
  });
}

/**
 * Resolve the verified Access authority for core config generation.
 *
 * Pure (no network, filesystem, or clock): the caller loads the ignored
 * non-secret Access receipt and passes it here. When a receipt is present its
 * Cloudflare-readback AUD and team origin win; non-empty environment values
 * must reconcile exactly instead of silently overriding the receipt. When no
 * receipt is present the caller falls back to environment validation (used by
 * check-only CREATE plans and historical mocks). Service principals always
 * come from the environment: receipts carry only digests, never principals.
 */
export function resolveAccessRuntimeConfiguration(environment, accessReceipt) {
  const servicePrincipals = parseServicePrincipals(environment);
  if (accessReceipt === null || accessReceipt === undefined) {
    const fromEnv = validateAccessRuntimeConfiguration({
      ...environment,
      ELIOTR_ACCESS_SERVICE_PRINCIPALS: environment.ELIOTR_ACCESS_SERVICE_PRINCIPALS ?? "",
    });
    return Object.freeze({ ...fromEnv, source: "ENVIRONMENT" });
  }
  if (typeof accessReceipt !== "object" || Array.isArray(accessReceipt)) {
    throw new Error("Access receipt must be an object for AUD propagation");
  }
  if (accessReceipt.protocol !== ACCESS_RECEIPT_PROTOCOL) {
    throw new Error(`Access receipt protocol must be ${ACCESS_RECEIPT_PROTOCOL}`);
  }
  if (typeof accessReceipt.aud !== "string" || !AUD_TAG_PATTERN.test(accessReceipt.aud)) {
    throw new Error("stale Access receipt lacks a bounded Cloudflare AUD binding; re-run the Access provisioner");
  }
  const receiptTeam = normalizeTeamOrigin(accessReceipt.team_domain, "Access receipt team_domain");
  if (typeof accessReceipt.account_id !== "string" || accessReceipt.account_id.trim() === "") {
    throw new Error("stale Access receipt lacks an account_id binding; re-run the Access provisioner");
  }
  if (typeof accessReceipt.hostname !== "string" || accessReceipt.hostname.trim() === "") {
    throw new Error("stale Access receipt lacks a hostname binding; re-run the Access provisioner");
  }
  const rawTeamEnv = typeof environment.ELIOTR_ACCESS_TEAM_DOMAIN === "string"
    ? environment.ELIOTR_ACCESS_TEAM_DOMAIN.trim()
    : "";
  if (rawTeamEnv !== "") {
    const envTeam = normalizeTeamOrigin(rawTeamEnv, "ELIOTR_ACCESS_TEAM_DOMAIN");
    if (envTeam !== receiptTeam) {
      throw new Error(`Access team-domain reconciliation mismatch: receipt ${receiptTeam} vs environment ${envTeam}`);
    }
  }
  const rawAudEnv = typeof environment.ELIOTR_ACCESS_AUDIENCE === "string"
    ? environment.ELIOTR_ACCESS_AUDIENCE.trim()
    : "";
  if (rawAudEnv !== "") {
    if (!AUD_TAG_PATTERN.test(rawAudEnv)) {
      throw new Error("ELIOTR_ACCESS_AUDIENCE must be a bounded Cloudflare Access AUD tag");
    }
    if (rawAudEnv !== accessReceipt.aud) {
      throw new Error("Access AUD propagation mismatch: environment AUD differs from the verified Access receipt AUD");
    }
  }
  return Object.freeze({
    teamDomain: receiptTeam,
    audience: accessReceipt.aud,
    servicePrincipals,
    servicePrincipalCount: servicePrincipals.length,
    source: "RECEIPT",
  });
}

export function applyAccessRuntimeVars(vars, accessRuntime) {
  return {
    ...vars,
    ACCESS_TEAM_DOMAIN: accessRuntime.teamDomain,
    ACCESS_AUDIENCE: accessRuntime.audience,
    ACCESS_SERVICE_PRINCIPALS: accessRuntime.servicePrincipals.join(","),
  };
}
