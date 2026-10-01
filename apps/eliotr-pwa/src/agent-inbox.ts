type JsonRecord = Record<string, unknown>;

interface AccessIdentityFields {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly grantId?: string;
}
interface AccessFields extends AccessIdentityFields {
  readonly grantId: string;
}

interface VersionedRef {
  readonly id: string;
  readonly revision: number;
}

interface EvidenceChoice {
  readonly ref: VersionedRef;
  readonly label: string;
  readonly byteLength: number | null;
}

interface CurrentTask {
  readonly raw: JsonRecord;
  readonly taskId: string;
  readonly leaseId: string;
  readonly operationId: string;
  readonly attemptRef: string;
  readonly requestSha256: string;
  readonly stageIndex: number;
  readonly stage: string;
  readonly taskKind: string;
  readonly evidence: readonly EvidenceChoice[];
  readonly requiredRoles: readonly string[];
}

const AGENT_INBOX_PROTOCOL = "eliotr.agent-inbox.v1";
const MAX_EVIDENCE_RANGE = 64 * 1024;
const requestButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("button[data-request]"),
);

function element<T extends HTMLElement>(
  id: string,
  constructor: { new(): T },
): T {
  const node = document.getElementById(id);
  if (!(node instanceof constructor)) {
    throw new Error(`Missing agent inbox element ${id}`);
  }
  return node;
}

const accessClientId = element("access-client-id", HTMLInputElement);
const accessClientSecret = element("access-client-secret", HTMLInputElement);
const clientGrantId = element("client-grant-id", HTMLInputElement);
const qualificationChallengeId = element("qualification-challenge-id", HTMLInputElement);
const qualificationChallengeToken = element("qualification-challenge-token", HTMLInputElement);
const workerSlot = element("worker-slot", HTMLInputElement);
const contour = element("agent-contour", HTMLSelectElement);
const computerScope = element("computer-scope", HTMLSelectElement);
const taskIdInput = element("task-id", HTMLInputElement);
const leaseIdInput = element("lease-id", HTMLInputElement);
const workflowIdInput = element("workflow-id", HTMLInputElement);
const progressCursor = element("progress-cursor", HTMLInputElement);
const progressJson = element("progress-json", HTMLTextAreaElement);
const resultKey = element("result-key", HTMLInputElement);
const resultJson = element("result-json", HTMLTextAreaElement);
const evidenceId = element("evidence-id", HTMLInputElement);
const evidenceRevision = element("evidence-revision", HTMLInputElement);
const evidenceStart = element("evidence-start", HTMLInputElement);
const evidenceEnd = element("evidence-end", HTMLInputElement);
const recoveryKey = element("recovery-key", HTMLInputElement);
const taskOutput = element("task-output", HTMLPreElement);
const evidenceOutput = element("evidence-output", HTMLPreElement);
const eventOutput = element("event-output", HTMLPreElement);
const evidenceChoices = element("evidence-choices", HTMLDivElement);
const statusLine = element("status-line", HTMLParagraphElement);

let currentTask: CurrentTask | null = null;

function setStatus(message: string, kind: "ready" | "working" | "error" = "ready"): void {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

function render(target: HTMLElement, value: unknown): void {
  target.textContent = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is not an integer`);
  }
  return value;
}

function parseJsonObject(source: string, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return record(value, label);
}

function accessIdentity(): AccessIdentityFields {
  const clientId = accessClientId.value.trim();
  const clientSecret = accessClientSecret.value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u.test(clientId) ||
      clientSecret.length < 1 || clientSecret.length > 4096 || /\s/u.test(clientSecret)) {
    throw new Error("Enter a valid Access Client ID and Client Secret");
  }
  return { clientId, clientSecret };
}

function credentials(): AccessFields {
  const access = accessIdentity();
  const grantId = clientGrantId.value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(grantId)) {
    throw new Error("Enter a valid project grant locator");
  }
  return { ...access, grantId };
}

function requestHeaders(
  access: AccessIdentityFields,
  options: { readonly json?: boolean; readonly idempotencyKey?: string } = {},
): Headers {
  const headers = new Headers({
    "CF-Access-Client-Id": access.clientId,
    "CF-Access-Client-Secret": access.clientSecret,
    "X-Eliotr-Agent-Inbox": AGENT_INBOX_PROTOCOL,
  });
  if (access.grantId !== undefined) headers.set("X-Eliotr-Client-Grant", access.grantId);
  if (options.json === true) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  return headers;
}

function requireUncontrolledPage(): void {
  if ("serviceWorker" in navigator && navigator.serviceWorker.controller !== null) {
    throw new Error(
      "Agent inbox refuses to send credentials while a service worker controls this page. " +
      "Open it in the dedicated clean computer-agent profile and reload.",
    );
  }
}

async function sameOriginFetch(
  path: string,
  access: AccessIdentityFields,
  init: {
    readonly method: "GET" | "POST";
    readonly body?: string;
    readonly idempotencyKey?: string;
  },
): Promise<Response> {
  requireUncontrolledPage();
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("Agent inbox attempted a request outside the same-origin API");
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60_000);
  try {
    return await fetch(url, {
      method: init.method,
      headers: requestHeaders(access, {
        json: init.body !== undefined,
        ...(init.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: init.idempotencyKey }),
      }),
      ...(init.body === undefined ? {} : { body: init.body }),
      cache: "no-store",
      credentials: "omit",
      mode: "same-origin",
      redirect: "error",
      referrerPolicy: "same-origin",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function decodedResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  let decoded: unknown = null;
  if (body !== "") {
    try {
      decoded = JSON.parse(body) as unknown;
    } catch {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} returned a non-JSON error`);
      }
      return body;
    }
  }
  if (!response.ok) {
    const problem = decoded === null ? {} : record(decoded, "API problem");
    const code = typeof problem.code === "string" ? problem.code : "API_REQUEST_FAILED";
    const title = typeof problem.title === "string" ? problem.title : `HTTP ${response.status}`;
    throw new Error(`${code}: ${title}`);
  }
  return decoded;
}

async function postTask(
  operation: "pull" | "progress" | "result" | "status",
  body: JsonRecord,
): Promise<unknown> {
  const access = credentials();
  return decodedResponse(await sameOriginFetch(
    `/api/v1/research/agent-tasks/${operation}`,
    access,
    {
      method: "POST",
      body: JSON.stringify({ ...body, client_grant_id: access.grantId }),
    },
  ));
}

function apiData(value: unknown): unknown {
  return record(value, "API response").data;
}

function ref(value: unknown): VersionedRef {
  const parsed = record(value, "Evidence handle");
  const id = text(parsed.id, "Evidence handle id");
  const revision = integer(parsed.revision, "Evidence handle revision");
  if (revision < 1) throw new Error("Evidence handle revision is invalid");
  return { id, revision };
}

function parseEvidence(task: JsonRecord): readonly EvidenceChoice[] {
  const payload = record(task.payload, "Task payload");
  const body = record(payload.body, "Task payload body");
  if (!Array.isArray(body.evidence)) return Object.freeze([]);
  const result: EvidenceChoice[] = [];
  for (const entry of body.evidence) {
    const item = record(entry, "Task evidence");
    const handle = ref(item.handle_ref);
    const titleValue = typeof item.source_title === "string"
      ? item.source_title
      : typeof item.source_id === "string" ? item.source_id : handle.id;
    const byteLength = typeof item.excerpt_byte_length === "number" &&
      Number.isSafeInteger(item.excerpt_byte_length) &&
      item.excerpt_byte_length >= 0
      ? item.excerpt_byte_length
      : null;
    result.push({
      ref: handle,
      label: titleValue,
      byteLength,
    });
  }
  return Object.freeze(result);
}

function requiredRoles(task: JsonRecord): readonly string[] {
  const payload = record(task.payload, "Task payload");
  const body = record(payload.body, "Task payload body");
  if (!Array.isArray(body.required_roles)) return Object.freeze([]);
  const values = body.required_roles.map((value) => text(value, "Required role"));
  if (new Set(values).size !== values.length) {
    throw new Error("Task payload contains duplicate required roles");
  }
  return Object.freeze(values);
}

function parseCurrentTask(value: unknown): CurrentTask | null {
  const data = record(apiData(value), "Task pull data");
  if (data.task === null) return null;
  const task = record(data.task, "Task");
  const lease = record(task.lease, "Task lease");
  return {
    raw: task,
    taskId: text(task.task_id, "task_id"),
    leaseId: text(lease.lease_id, "lease_id"),
    operationId: text(task.operation_id, "operation_id"),
    attemptRef: text(task.attempt_ref, "attempt_ref"),
    requestSha256: text(task.request_sha256, "request_sha256"),
    stageIndex: integer(task.stage_index, "stage_index"),
    stage: text(task.stage, "stage"),
    taskKind: text(task.task_kind, "task_kind"),
    evidence: parseEvidence(task),
    requiredRoles: requiredRoles(task),
  };
}

function resultTemplate(task: CurrentTask): JsonRecord {
  const roles = task.requiredRoles.map((role) => ({
    role,
    status: "BLOCKED",
    evidence_handle_refs: [],
  }));
  return {
    disposition: "PARTIAL",
    output: {
      protocol: "eliotr.external-branch-analysis.v1",
      task_kind: task.taskKind,
      task_id: task.taskId,
      operation_id: task.operationId,
      stage_index: task.stageIndex,
      stage: task.stage,
      attempt_ref: task.attemptRef,
      request_sha256: task.requestSha256,
      roles,
      candidate_findings: [],
      execution_observation: {
        contour: contour.value,
        computer_scope: computerScope.value,
        interfaces_used: ["agent-inbox"],
        observed_at: new Date().toISOString(),
      },
    },
    evidence_refs: [],
    diagnostics: [],
    usage: { accounting: "SUBSCRIPTION" },
  };
}

function resetResultTemplate(): void {
  if (currentTask === null) {
    resultJson.value = JSON.stringify({
      disposition: "FAILED",
      output: null,
      evidence_refs: [],
      diagnostics: ["No task is currently loaded."],
      usage: { accounting: "UNKNOWN" },
    }, null, 2);
    return;
  }
  resultJson.value = JSON.stringify(resultTemplate(currentTask), null, 2);
}

function renderEvidenceChoices(task: CurrentTask | null): void {
  evidenceChoices.replaceChildren();
  if (task === null || task.evidence.length === 0) {
    evidenceChoices.textContent = "No admitted evidence handles are listed in this task.";
    return;
  }
  for (const choice of task.evidence) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "evidence-choice";
    button.textContent = `${choice.label} · r${choice.ref.revision}`;
    button.addEventListener("click", () => {
      evidenceId.value = choice.ref.id;
      evidenceRevision.value = String(choice.ref.revision);
      evidenceStart.value = "0";
      evidenceEnd.value = String(Math.max(
        1,
        Math.min(MAX_EVIDENCE_RANGE, choice.byteLength ?? 4096),
      ));
      setStatus("Evidence handle selected.");
    });
    evidenceChoices.append(button);
  }
}

function setCurrentTask(task: CurrentTask | null): void {
  currentTask = task;
  if (task === null) {
    taskIdInput.value = "";
    leaseIdInput.value = "";
    workflowIdInput.value = "";
    renderEvidenceChoices(null);
    resetResultTemplate();
    return;
  }
  taskIdInput.value = task.taskId;
  leaseIdInput.value = task.leaseId;
  workflowIdInput.value = task.operationId;
  progressCursor.value = "1";
  progressJson.value = JSON.stringify({
    phase: "ANALYZE_BRANCHES",
    message: "Task opened in the computer-agent web inbox.",
    evidence_refs: [],
  }, null, 2);
  if (resultKey.value.trim() === "") {
    resultKey.value = `agent-result-${task.requestSha256.slice(0, 24)}`;
  }
  if (recoveryKey.value.trim() === "") {
    recoveryKey.value = `agent-recover-${task.requestSha256.slice(0, 24)}`;
  }
  resetResultTemplate();
  renderEvidenceChoices(task);
}

async function busy<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
  requestButtons.forEach((button) => { button.disabled = true; });
  setStatus(label, "working");
  try {
    const result = await action();
    setStatus("Request completed.", "ready");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown request failure";
    setStatus(message, "error");
    render(eventOutput, { error: message, observed_at: new Date().toISOString() });
    return undefined;
  } finally {
    requestButtons.forEach((button) => { button.disabled = false; });
  }
}

element("confirm-qualification", HTMLButtonElement).addEventListener("click", () => {
  void busy("Confirming web-inbox qualification…", async () => {
    const response = await sameOriginFetch(
      "/api/v1/computer-agents/qualifications/confirm",
      accessIdentity(),
      { method: "POST", body: JSON.stringify({
        challenge_id: qualificationChallengeId.value.trim(),
        challenge_token: qualificationChallengeToken.value,
      }) },
    );
    const result = await decodedResponse(response);
    qualificationChallengeToken.value = "";
    render(eventOutput, result);
  });
});

element("pull-task", HTMLButtonElement).addEventListener("click", () => {
  void busy("Pulling the next task…", async () => {
    const response = await postTask("pull", {
      worker_slot: workerSlot.value.trim() || "default",
    });
    const task = parseCurrentTask(response);
    setCurrentTask(task);
    render(taskOutput, response);
  });
});

element("read-status", HTMLButtonElement).addEventListener("click", () => {
  void busy("Reading task status…", async () => {
    const response = await postTask("status", {
      task_id: taskIdInput.value.trim(),
    });
    render(taskOutput, response);
  });
});

element("submit-progress", HTMLButtonElement).addEventListener("click", () => {
  void busy("Recording progress…", async () => {
    const cursor = Number(progressCursor.value);
    if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor > 4096) {
      throw new Error("Progress cursor must be an integer from 1 to 4096");
    }
    const response = await postTask("progress", {
      task_id: taskIdInput.value.trim(),
      lease_id: leaseIdInput.value.trim(),
      cursor,
      progress: parseJsonObject(progressJson.value, "Progress JSON"),
    });
    progressCursor.value = String(cursor + 1);
    render(eventOutput, response);
  });
});

element("reset-result", HTMLButtonElement).addEventListener("click", () => {
  resetResultTemplate();
  setStatus("Result template regenerated from the current task.");
});

element("submit-result", HTMLButtonElement).addEventListener("click", () => {
  void busy("Recording task result…", async () => {
    const response = await postTask("result", {
      task_id: taskIdInput.value.trim(),
      lease_id: leaseIdInput.value.trim(),
      idempotency_key: resultKey.value.trim(),
      result: parseJsonObject(resultJson.value, "Result JSON"),
    });
    render(eventOutput, response);
  });
});

element("open-evidence", HTMLButtonElement).addEventListener("click", () => {
  void busy("Opening exact evidence…", async () => {
    const access = credentials();
    const revision = Number(evidenceRevision.value);
    const start = Number(evidenceStart.value);
    const end = Number(evidenceEnd.value);
    if (
      !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(start) || start < 0 ||
      !Number.isSafeInteger(end) || end <= start ||
      end - start > MAX_EVIDENCE_RANGE
    ) {
      throw new Error("Evidence revision/range is invalid or exceeds 64 KiB");
    }
    const encoded = encodeURIComponent(`${evidenceId.value.trim()}:${revision}`);
    const response = await sameOriginFetch(
      `/api/v1/research/open/${encoded}?start=${start}&end=${end}`,
      access,
      { method: "GET" },
    );
    const body = await response.text();
    if (!response.ok) {
      let problem: unknown = body;
      try { problem = JSON.parse(body) as unknown; } catch { /* keep bounded text */ }
      throw new Error(`Evidence open failed: ${JSON.stringify(problem)}`);
    }
    render(evidenceOutput, {
      handle: `${evidenceId.value.trim()}:${revision}`,
      range: { start, end },
      content_type: response.headers.get("content-type"),
      excerpt_sha256: response.headers.get("x-eliotr-excerpt-sha256"),
      verification_receipt: response.headers.get("x-eliotr-verification-receipt"),
      text: body,
    });
  });
});

element("recover-run", HTMLButtonElement).addEventListener("click", () => {
  void busy("Recovering the canonical workflow…", async () => {
    const workflowId = workflowIdInput.value.trim();
    const idempotencyKey = recoveryKey.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(workflowId)) {
      throw new Error("Workflow ID is invalid");
    }
    if (
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 256 ||
      /[\u0000-\u0020\u007f]/u.test(idempotencyKey)
    ) {
      throw new Error("Recovery idempotency key is invalid");
    }
    const response = await sameOriginFetch(
      `/api/v1/research/run/${encodeURIComponent(workflowId)}/recover`,
      credentials(),
      {
        method: "POST",
        body: "{}",
        idempotencyKey,
      },
    );
    render(eventOutput, await decodedResponse(response));
  });
});

element("clear-secrets", HTMLButtonElement).addEventListener("click", () => {
  accessClientId.value = "";
  accessClientSecret.value = "";
  clientGrantId.value = "";
  qualificationChallengeId.value = "";
  qualificationChallengeToken.value = "";
  clearDispatchFields();
  setStatus("Credential, qualification and dispatch fields cleared.");
});

window.addEventListener("pagehide", () => {
  accessClientId.value = "";
  accessClientSecret.value = "";
  clientGrantId.value = "";
  qualificationChallengeId.value = "";
  qualificationChallengeToken.value = "";
  clearDispatchFields();
  currentTask = null;
});

resetResultTemplate();
renderEvidenceChoices(null);
setStatus("Credentials are kept only in this page's memory.");
