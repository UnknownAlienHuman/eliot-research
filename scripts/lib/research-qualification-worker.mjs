import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const RESPONSE_REASON_PATTERN = "(?:FINGERPRINT_INVALID|LOG_ID_MISSING|LOG_ID_INVALID|CONTENT_TYPE_INVALID|BODY_TOO_LARGE|BODY_JSON_INVALID|BODY_SHAPE_INVALID|MODEL_ID_INVALID|CACHE_INVALID|UNCLASSIFIED)";
const SAFE_QUALIFICATION_FAILURE_TITLE = new RegExp(
  `^Document model qualification could not complete(?: \\((?:upstream HTTP [1-5][0-9]{2}(?:; provider codes [0-9]{1,16}(?:,[0-9]{1,16}){0,7})?(?:; response reason ${RESPONSE_REASON_PATTERN})?|response reason ${RESPONSE_REASON_PATTERN})\\))?$`,
  "u",
);

export function researchQualificationWorkerOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("qualification Worker URL must be an HTTPS origin");
  }
  return url.origin;
}

/** Existing Cloudflare Access login; the client never reads or exports its token. */
export function createResearchQualificationWorkerExecution({ workerUrl, prompt, stateDirectory }) {
  const origin = researchQualificationWorkerOrigin(workerUrl);
  const cloudflared = process.platform === "win32" && process.env["ProgramFiles(x86)"]
    ? join(process.env["ProgramFiles(x86)"], "cloudflared", "cloudflared.exe") : "cloudflared";
  return async ({ probe, probe_input_sha256, claim_ref }) => {
    await mkdir(stateDirectory, { recursive: true });
    const inputPath = resolve(stateDirectory, `.qualification-dispatch-${randomUUID()}.json`);
    const timeout = prompt.request_timeout_ms + 90_000;
    await writeFile(inputPath, JSON.stringify({
      protocol: "eliotr.research-model-qualification-dispatch.v1",
      probe, prompt, probe_input_sha256, claim_ref,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      // No automatic retry: the coordinator and Worker each retain the one-shot claim.
      const { stdout } = await executeFile(cloudflared, [
        "access", "curl", `${origin}/api/v1/system/research-model-qualification`,
        "--silent", "--show-error", "--request", "POST",
        "--max-time", String(Math.ceil(timeout / 1000)),
        "--header", "Content-Type: application/json", "--data-binary", `@${inputPath}`,
      ], { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 });
      let result;
      try { result = JSON.parse(stdout); } catch {
        throw Object.assign(new Error("Worker did not return a qualification receipt"), {
          code: "RESEARCH_QUALIFICATION_WORKER_RESPONSE_INVALID",
        });
      }
      if (!result || typeof result !== "object" || !result.data || typeof result.data !== "object") {
        const code = /^[A-Z][A-Z0-9_]{0,95}$/u.test(result?.code ?? "")
          ? result.code : "RESEARCH_QUALIFICATION_WORKER_FAILED";
        const title = typeof result?.title === "string" &&
          SAFE_QUALIFICATION_FAILURE_TITLE.test(result.title)
          ? result.title : "Worker qualification did not complete";
        await writeFile(resolve(stateDirectory, "qualification-worker-error.json"), JSON.stringify({
          code, title, status: Number.isInteger(result?.status) ? result.status : null,
        }) + "\n", { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
        throw Object.assign(new Error("Worker qualification did not complete"), { code });
      }
      return result.data;
    } finally {
      await unlink(inputPath);
    }
  };
}
