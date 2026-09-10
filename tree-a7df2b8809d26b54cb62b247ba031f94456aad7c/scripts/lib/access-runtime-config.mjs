function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function validateAccessRuntimeConfiguration(environment) {
  const rawTeamDomain = required(environment.ELIOTR_ACCESS_TEAM_DOMAIN, "ELIOTR_ACCESS_TEAM_DOMAIN");
  let teamUrl;
  try {
    teamUrl = new URL(rawTeamDomain);
  } catch {
    throw new Error("ELIOTR_ACCESS_TEAM_DOMAIN must be an absolute HTTPS URL");
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
    throw new Error("ELIOTR_ACCESS_TEAM_DOMAIN must be one https://<team>.cloudflareaccess.com origin");
  }

  const audience = required(environment.ELIOTR_ACCESS_AUDIENCE, "ELIOTR_ACCESS_AUDIENCE");
  if (audience.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(audience)) {
    throw new Error("ELIOTR_ACCESS_AUDIENCE must be a bounded Cloudflare Access AUD tag");
  }

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

  return Object.freeze({
    teamDomain: teamUrl.origin,
    audience,
    servicePrincipals: Object.freeze([...servicePrincipals]),
    servicePrincipalCount: servicePrincipals.length,
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
