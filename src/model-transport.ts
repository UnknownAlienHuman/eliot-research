import { createAI } from "agents/models/ai-sdk";
import type { LanguageModel } from "ai";
import { LibraryError } from "./library";
import { getModelConnection, type ModelSpec } from "./models";

// Only fixed catalog route allowed here: no fallback legs, no dynamic routes,
// no BYOK alias selection, no credential IO. Anything else is rejected below.
const EXTERNAL_ROUTE = "gateway:google/gemini-2.5-flash";

const EXTERNAL_FAILURE =
  "External model request failed. Check the Gateway connection and provider status; no retry was started.";
const NATIVE_FAILURE = "Model stream failed.";

export async function resolveModelTransport(
  env: Pick<Env, "AI" | "DB">,
  model: ModelSpec,
  sessionAffinity: string,
): Promise<LanguageModel> {
  if (model.route === EXTERNAL_ROUTE) {
    const connection = await getModelConnection(env);
    if (!connection.gatewayId) {
      throw new LibraryError("unavailable",
        "External models are disconnected. Allow access to the existing Gateway credential in Settings first.", 503);
    }
    return createAI({ binding: env.AI }).languageModel(model.id, {
      sessionAffinity,
      headers: {
        "cf-aig-no-wholesale": "true",
        "cf-aig-max-attempts": "1",
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log": "false",
      },
      gateway: { id: connection.gatewayId, skipCache: true, collectLog: false, retries: { maxAttempts: 1 } },
    });
  }
  if (model.route.startsWith("workers-ai:")) {
    return createAI({ binding: env.AI }).languageModel(model.id, { reasoningEffort: "low", sessionAffinity });
  }
  throw new LibraryError("unavailable", "This model route is not supported.", 503);
}

export function modelFailure(error: unknown, model: ModelSpec): string {
  if (!model.route.startsWith("gateway:")) {
    return error instanceof Error ? (error.name + ": " + error.message).slice(0, 300) : NATIVE_FAILURE;
  }
  return EXTERNAL_FAILURE;
}