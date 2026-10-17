import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/env.js";

it("characterizes missing guide native lookup without creating a workflow", async () => {
  const workflow = (env as unknown as Pick<Env, "RESEARCH_WORKFLOW">).RESEARCH_WORKFLOW;
  const id = `run-${"0".repeat(48)}`;
  let phase: "get" | "status" = "get";
  let observed: unknown;
  try {
    const instance = await workflow.get(id);
    phase = "status";
    observed = await instance.status();
  } catch (error) {
    const raw = error !== null && typeof error === "object" ? error as { name?: unknown; message?: unknown; code?: unknown } : {};
    const proof = { event: "project_guide_native_missing_probe", phase, error_instance: error instanceof Error,
      error_class: typeof raw.name === "string" ? raw.name.slice(0, 64) : typeof error,
      error_code: typeof raw.code === "string" || typeof raw.code === "number" ? String(raw.code).slice(0, 64) : null,
      native_error_message: typeof raw.message === "string" ? raw.message.slice(0, 512) : null };
    console.warn(JSON.stringify(proof));
    expect(error instanceof Error && error.message === "instance.not_found").toBe(true);
    return;
  }
  throw new Error(`Missing guide native lookup returned status: ${JSON.stringify(observed)}`);
});
