import { HttpRequestError } from "./http.js";

function singleQueryValue(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw new HttpRequestError("QUERY_PARAMETER_DUPLICATED", 400, `${key} may appear only once`);
  const value = values[0];
  if (value !== undefined && new TextEncoder().encode(value).byteLength > 2 * 1024) {
    throw new HttpRequestError("QUERY_PARAMETER_TOO_LARGE", 400, `${key} exceeds its byte limit`);
  }
  return value;
}

export function parseExhaustiveWorkflowJobsRequest(url: URL): { readonly cursor?: string; readonly limit: number } {
  for (const key of url.searchParams.keys()) {
    if (!(key === "cursor" || key === "limit")) {
      throw new HttpRequestError("UNKNOWN_QUERY_PARAMETER", 400, "workflow jobs query contains an unknown parameter");
    }
  }
  const cursor = singleQueryValue(url, "cursor");
  const rawLimit = singleQueryValue(url, "limit");
  if (rawLimit !== undefined && !/^(?:[1-9]|1[0-9]|20)$/u.test(rawLimit)) {
    throw new HttpRequestError("WORKFLOW_JOBS_LIMIT_INVALID", 400, "workflow jobs limit must be an integer in [1, 20]");
  }
  return { limit: rawLimit === undefined ? 20 : Number(rawLimit), ...(cursor === undefined ? {} : { cursor }) };
}
