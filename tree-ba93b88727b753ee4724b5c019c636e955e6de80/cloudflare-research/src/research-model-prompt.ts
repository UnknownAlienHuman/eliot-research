import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  ModelGatewayExecutionError,
  validateModelGatewayRequestBody,
  type CompiledModelGatewayPrompt,
  type ModelCallInput,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type {
  BuildReferenceManifestInput,
  ResearchReferenceManifestService,
} from "./research-reference-manifest.js";

export interface TrustedModelPromptParameters {
  readonly prompt: string;
  readonly max_tokens: number;
  readonly response_format?: unknown;
  readonly seed?: number;
  readonly stop?: string | readonly string[];
  readonly temperature?: number;
  readonly top_p?: number;
}

export interface ResearchModelPromptCompilerDependencies {
  readonly manifest_service: ResearchReferenceManifestService;
  readonly build_manifest_input: (
    input: ModelCallInput,
    deployment: ModelRouteDeployment,
  ) => Promise<BuildReferenceManifestInput>;
  readonly resolve_trusted_parameters: (
    input: ModelCallInput,
    deployment: ModelRouteDeployment,
  ) => Promise<TrustedModelPromptParameters>;
  readonly request_timeout_ms: number;
}

const SHA256 = /^[a-f0-9]{64}$/u;

function fail(message: string): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_PROMPT_COMPILE_FAILED", message);
}

function refKey(ref: { readonly id: string; readonly revision: number }): string {
  return `${ref.id}:${ref.revision}`;
}

function sameRef(
  left: { readonly id: string; readonly revision: number },
  right: { readonly id: string; readonly revision: number },
): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function assertTrustedParameters(value: TrustedModelPromptParameters): void {
  if (typeof value.prompt !== "string" || value.prompt.length === 0) {
    fail("trusted model prompt is missing");
  }
  if (!Number.isSafeInteger(value.max_tokens) || value.max_tokens < 1) {
    fail("trusted model max_tokens is invalid");
  }
}

function assertInputBinding(
  input: ModelCallInput,
  deployment: ModelRouteDeployment,
  manifestInput: BuildReferenceManifestInput,
): void {
  if (input.route_ref !== deployment.route_ref || manifestInput.model_route_ref !== deployment.route_ref) {
    fail("model route is not bound to the trusted reference manifest");
  }
  if (input.prompt_generation !== deployment.prompt_generation || input.schema_generation !== deployment.schema_generation) {
    fail("model prompt generations do not match the deployment");
  }
  if (!sameRef(manifestInput.evidence_pack.pack_ref, input.evidence_pack.pack_ref) ||
      !sameRef(manifestInput.evidence_pack.scope_snapshot_ref, input.evidence_pack.scope_snapshot_ref) ||
      !sameRef(manifestInput.evidence_pack.trace_ref, input.evidence_pack.trace_ref)) {
    fail("reference manifest input is bound to another evidence pack");
  }
  if (!Number.isSafeInteger(manifestInput.max_context_bytes) ||
      manifestInput.max_context_bytes < 1 || manifestInput.max_context_bytes > input.max_input_bytes) {
    fail("reference manifest context bound is outside the reserved input budget");
  }
}

function userPayload(
  input: ModelCallInput,
  deployment: ModelRouteDeployment,
  compiled: Awaited<ReturnType<ResearchReferenceManifestService["buildAndPersist"]>>["compiled"],
  prompt: TrustedModelPromptParameters,
): string {
  return canonicalModelGatewayJson({
    prompt: prompt.prompt,
    route_ref: deployment.route_ref,
    route_version: deployment.route_version,
    prompt_generation: deployment.prompt_generation,
    schema_generation: deployment.schema_generation,
    evidence_pack_ref: refKey(input.evidence_pack.pack_ref),
    manifest_ref: refKey(compiled.manifest_ref),
    selection_receipt: compiled.selection_receipt,
    evidence: compiled.blocks,
  });
}

export function createResearchModelPromptCompiler(
  dependencies: ResearchModelPromptCompilerDependencies,
): ModelGatewayPromptCompilerPort {
  if (!Number.isSafeInteger(dependencies.request_timeout_ms) ||
      dependencies.request_timeout_ms < 1 || dependencies.request_timeout_ms > 300_000) {
    fail("trusted model request timeout is invalid");
  }

  return {
    async compile(input, deployment): Promise<CompiledModelGatewayPrompt> {
      if (input.route_ref !== deployment.route_ref ||
          input.prompt_generation !== deployment.prompt_generation ||
          input.schema_generation !== deployment.schema_generation) {
        fail("model call is not bound to the deployed prompt generations");
      }
      const manifestInput = await dependencies.build_manifest_input(input, deployment);
      assertInputBinding(input, deployment, manifestInput);
      const built = await dependencies.manifest_service.buildAndPersist(manifestInput);
      if (!sameRef(built.manifest.manifest_ref, built.compiled.manifest_ref) ||
          !sameRef(built.manifest_ref, built.manifest.manifest_ref) ||
          built.compiled.source_text_in_system_fields !== false) {
        fail("compiled evidence context is not bound to the persisted manifest");
      }
      const prompt = await dependencies.resolve_trusted_parameters(input, deployment);
      assertTrustedParameters(prompt);
      const body = {
        model: deployment.route_ref,
        messages: [
          { role: "system", content: built.compiled.system_instructions.join("\n") },
          { role: "user", content: userPayload(input, deployment, built.compiled, prompt) },
        ],
        max_tokens: prompt.max_tokens,
        stream: false,
        response_format: prompt.response_format,
        seed: prompt.seed,
        stop: prompt.stop,
        temperature: prompt.temperature,
        top_p: prompt.top_p,
      };
      const validated = await validateModelGatewayRequestBody(
        body,
        deployment,
        input.max_input_bytes,
        input.max_output_bytes,
      );
      const requestBodySha256 = await modelGatewaySha256(validated.body);
      if (!SHA256.test(requestBodySha256)) fail("compiled model request digest is invalid");
      return Object.freeze({
        request_body: JSON.parse(validated.body) as unknown,
        request_body_sha256: requestBodySha256,
        request_timeout_ms: dependencies.request_timeout_ms,
      });
    },
  };
}
