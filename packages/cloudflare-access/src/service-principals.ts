import { AccessVerificationError } from "./access.js";

export function parseServicePrincipals(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length > 64 || new Set(values).size !== values.length) {
    throw new AccessVerificationError("ACCESS_CONFIG_INVALID",
      "ACCESS_SERVICE_PRINCIPALS must contain at most 64 unique values", true);
  }
  return values;
}
