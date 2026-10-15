export interface DoctorGitHubConfig {
  readonly owner: string;
  readonly repository: string;
  readonly token: string;
}

export type DoctorIssueReadback =
  | { readonly kind: "FOUND"; readonly issue_number: number }
  | { readonly kind: "ABSENT" }
  | { readonly kind: "UNKNOWN" };

export type DoctorIssueCreate =
  | { readonly kind: "CREATED"; readonly issue_number: number }
  | { readonly kind: "REJECTED" }
  | { readonly kind: "UNKNOWN" };

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_TIMEOUT_MS = 4_000;
const GITHUB_ISSUES_PAGE_SIZE = 100;
const GITHUB_ISSUES_MAX_PAGES = 8;

const REPOSITORY_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseDoctorGitHubConfig(
  repositoryValue: string | undefined,
  tokenValue: string | undefined,
): DoctorGitHubConfig | null {
  const repository = repositoryValue?.trim();
  const token = tokenValue?.trim();
  if (repository === undefined || token === undefined || token.length === 0) return null;
  const parts = repository.split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined || !REPOSITORY_OWNER.test(owner) ||
      !REPOSITORY_NAME.test(name) || name === "." || name === "..") return null;
  return { owner, repository: name, token };
}

function repositoryUrl(config: DoctorGitHubConfig): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;
}

function requestHeaders(config: DoctorGitHubConfig): Headers {
  return new Headers({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${config.token}`,
    "user-agent": "eliotr-scheduled-doctor",
    "x-github-api-version": GITHUB_API_VERSION,
  });
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

/** Read-only repository check. It never probes another configured or caller-selected host. */
export async function verifyDoctorGitHubRepository(
  config: DoctorGitHubConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchImpl(repositoryUrl(config), {
      method: "GET",
      headers: requestHeaders(config),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const value = await safeJson(response);
  if (!isRecord(value) || typeof value.full_name !== "string") return false;
  return value.full_name.toLocaleLowerCase("en-US") ===
    `${config.owner}/${config.repository}`.toLocaleLowerCase("en-US");
}

/**
 * Bounded marker readback across the configured repository's issue list. Reaching the page
 * ceiling without proving absence returns UNKNOWN, which forbids a create in this attempt.
 */
export async function readDoctorIssueByMarker(
  config: DoctorGitHubConfig,
  marker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DoctorIssueReadback> {
  for (let page = 1; page <= GITHUB_ISSUES_MAX_PAGES; page += 1) {
    const url = new URL(`${repositoryUrl(config)}/issues`);
    url.searchParams.set("state", "all");
    url.searchParams.set("filter", "all");
    url.searchParams.set("per_page", String(GITHUB_ISSUES_PAGE_SIZE));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "desc");

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: requestHeaders(config),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch {
      return { kind: "UNKNOWN" };
    }
    if (!response.ok) return { kind: "UNKNOWN" };
    const value = await safeJson(response);
    if (!Array.isArray(value)) return { kind: "UNKNOWN" };

    for (const item of value) {
      if (!isRecord(item) || item.pull_request !== undefined) continue;
      const body = typeof item.body === "string" ? item.body : "";
      const title = typeof item.title === "string" ? item.title : "";
      if (!body.includes(marker) && !title.includes(marker)) continue;
      return validIssueNumber(item.number)
        ? { kind: "FOUND", issue_number: item.number }
        : { kind: "UNKNOWN" };
    }
    if (value.length < GITHUB_ISSUES_PAGE_SIZE) return { kind: "ABSENT" };
  }
  return { kind: "UNKNOWN" };
}

export async function createDoctorGitHubIssue(
  config: DoctorGitHubConfig,
  input: {
    readonly marker: string;
    readonly health_code: string;
    readonly severity: "INFO" | "WARNING" | "CRITICAL";
    readonly diagnosis?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<DoctorIssueCreate> {
  const diagnosis = input.diagnosis?.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const body = [
    "Automated ELIOT health notification.",
    "",
    `Marker: ${input.marker}`,
    `Health code: ${input.health_code}`,
    `Severity: ${input.severity}`,
    ...(diagnosis === undefined || diagnosis.length === 0 ? [] : [`Diagnosis: ${diagnosis.slice(0, 320)}`]),
  ].join("\n");
  const headers = requestHeaders(config);
  headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetchImpl(`${repositoryUrl(config)}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `ELIOT health alert: ${input.health_code}`,
        body,
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch {
    return { kind: "UNKNOWN" };
  }

  if (response.status === 201) {
    const value = await safeJson(response);
    return isRecord(value) && validIssueNumber(value.number)
      ? { kind: "CREATED", issue_number: value.number }
      : { kind: "UNKNOWN" };
  }
  if (response.status >= 400 && response.status < 500) return { kind: "REJECTED" };
  return { kind: "UNKNOWN" };
}

export function doctorGitHubIssueUrl(
  config: DoctorGitHubConfig,
  issueNumber: number,
): string {
  return `https://github.com/${config.owner}/${config.repository}/issues/${issueNumber}`;
}
