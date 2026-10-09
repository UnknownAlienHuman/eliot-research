import { fail, type WorkflowNativeStageHandler, type WorkflowStartedAttemptRecovery } from "@eliotr/cloudflare-workflows";
import type { ResearchModelGatewayRuntimeConfig, ResearchModelSpendPolicy } from "@eliotr/cloudflare-research";
import {
  bindResearchSelectedModelTransport,
  resolveResearchSelectedModelTransport,
  ResearchSelectedModelTransportError,
  type ResearchSelectedModelStage,
  type ResearchSelectedModelTransportResolution,
} from "./research-selected-model-transport.js";
import type { ResearchRunConfigurationModeWithLegacy } from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import type { ResearchStageHandlerFactory } from "./research-stage-handlers.js";

export interface ResearchSemanticRunActor {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal_ref: string;
  readonly deployment_generation: string;
}

export interface ResearchSemanticRunConfigurationIdentity {
  readonly mode: ResearchRunConfigurationModeWithLegacy;
  readonly configuration_ref: string | null;
  readonly configuration_sha256: string | null;
}

export type ResearchSemanticRunModelConfiguration = NonNullable<
  Parameters<typeof resolveResearchSelectedModelTransport>[0]["run_configuration"]
>;
export type ResearchSemanticBranchStage = Extract<ResearchSelectedModelStage, "ANALYZE_BRANCHES" | "COUNTER_SEARCH">;

export interface ResearchSemanticStageModelBindings {
  readonly synthesis_transport: ResearchSelectedModelTransportResolution | undefined;
  readonly audit_transport: ResearchSelectedModelTransportResolution | undefined;
  readonly synthesis_gateway: ResearchModelGatewayRuntimeConfig;
  readonly audit_gateway: ResearchModelGatewayRuntimeConfig;
  readonly branch_gateway_for_stage?: (stage: ResearchSemanticBranchStage) => ResearchModelGatewayRuntimeConfig;
  readonly branch_transport_for_stage?: (stage: ResearchSemanticBranchStage) => ResearchSelectedModelTransportResolution;
}

function configurationInvalid(): never {
  return fail("WORKFLOW_CONFIGURATION_INVALID");
}

function selectedModelTransport(input: {
  readonly run_configuration?: ResearchSemanticRunModelConfiguration;
  readonly stage: ResearchSelectedModelStage;
}): ResearchSelectedModelTransportResolution | undefined {
  try { return resolveResearchSelectedModelTransport(input); }
  catch (error) {
    if (error instanceof ResearchSelectedModelTransportError) configurationInvalid();
    throw error;
  }
}

function bindSelectedModelTransport(
  gateway: ResearchModelGatewayRuntimeConfig,
  selection: ResearchSelectedModelTransportResolution | undefined,
): ResearchModelGatewayRuntimeConfig {
  try { return bindResearchSelectedModelTransport(gateway, selection); }
  catch (error) {
    if (error instanceof ResearchSelectedModelTransportError) configurationInvalid();
    throw error;
  }
}

/** Bind separate synthesis/audit routes and stage-specific branch gateways to the immutable run snapshot. */
export function bindResearchSemanticStageModelTransports(input: {
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly policy_rules: ResearchModelSpendPolicy["rules"];
  readonly run_configuration?: ResearchSemanticRunModelConfiguration;
  readonly include_branch_stages: boolean;
}): ResearchSemanticStageModelBindings {
  const bindStage = (stage: ResearchSelectedModelStage, required: boolean) => {
    const rule = input.policy_rules.find((entry) => entry.stage === stage);
    if (rule === undefined) configurationInvalid();
    const transport = selectedModelTransport({
      ...(input.run_configuration === undefined ? {} : { run_configuration: input.run_configuration }),
      stage,
    });
    if ((required && transport === undefined) || (transport !== undefined &&
        (transport.selection.route_ref !== rule.deployment.route_ref ||
         transport.selection.route_version !== rule.deployment.route_version))) configurationInvalid();
    return { transport, gateway: bindSelectedModelTransport(input.gateway, transport) };
  };

  const synthesis = bindStage("SYNTHESIZE", false);
  const audit = bindStage("AUDIT_CLAIMS", false);
  const branchTransports = new Map<ResearchSemanticBranchStage, ResearchSelectedModelTransportResolution>();
  const branchGateways = new Map<ResearchSemanticBranchStage, ResearchModelGatewayRuntimeConfig>();
  if (input.include_branch_stages && input.run_configuration !== undefined &&
      input.run_configuration.mode !== "legacy-installed") {
    for (const stage of ["ANALYZE_BRANCHES", "COUNTER_SEARCH"] as const) {
      const selected = bindStage(stage, true);
      if (selected.transport === undefined) configurationInvalid();
      branchTransports.set(stage, selected.transport);
      branchGateways.set(stage, selected.gateway);
    }
  }
  const branchTransportForStage = branchTransports.size === 0 ? undefined : (stage: ResearchSemanticBranchStage) => {
    const selected = branchTransports.get(stage);
    if (selected === undefined) configurationInvalid();
    return selected;
  };
  const branchGatewayForStage = branchGateways.size === 0 ? undefined : (stage: ResearchSemanticBranchStage) => {
    const selected = branchGateways.get(stage);
    if (selected === undefined) configurationInvalid();
    return selected;
  };
  return Object.freeze({
    synthesis_transport: synthesis.transport,
    audit_transport: audit.transport,
    synthesis_gateway: synthesis.gateway,
    audit_gateway: audit.gateway,
    ...(branchGatewayForStage === undefined ? {} : { branch_gateway_for_stage: branchGatewayForStage }),
    ...(branchTransportForStage === undefined ? {} : { branch_transport_for_stage: branchTransportForStage }),
  });
}

/** Revalidate the exact run snapshot and actor tuple before each handler and started-attempt recovery. */
export function bindHandlersToRunConfiguration(
  input: Readonly<{
    actor: ResearchSemanticRunActor;
    expected: ResearchSemanticRunConfigurationIdentity;
    handlers: ResearchStageHandlerFactory;
    read_current: () => Promise<ResearchSemanticRunConfigurationIdentity>;
  }>,
): ResearchStageHandlerFactory {
  const { actor, expected, handlers } = input;
  const revalidate = async () => {
    const current = await input.read_current();
    if (current.mode !== expected.mode || current.configuration_ref !== expected.configuration_ref ||
        current.configuration_sha256 !== expected.configuration_sha256) fail("WORKFLOW_AUTHORITY_STALE");
  };
  const wrapped = (stage: Parameters<ResearchStageHandlerFactory>[0]) => {
    const handler = handlers(stage);
    return async (call: Parameters<typeof handler>[0]) => {
      if (call.request.operation_id !== actor.operation_id ||
          call.request.investigation_ref.id !== actor.investigation_id ||
          call.principal.principal_ref !== actor.principal_ref ||
          call.principal.deployment_generation !== actor.deployment_generation) fail("WORKFLOW_AUTHORITY_STALE");
      await revalidate();
      return handler(call);
    };
  };
  const recoverStartedAttempt = handlers.recoverStartedAttempt;
  const native = (stage: Parameters<ResearchStageHandlerFactory["native"]>[0]) => {
    const handler: WorkflowNativeStageHandler | undefined = handlers.native(stage);
    if (handler === undefined) return undefined;
    return async (call: Parameters<typeof handler>[0]) => {
      if (call.request.operation_id !== actor.operation_id ||
          call.request.investigation_ref.id !== actor.investigation_id ||
          call.principal.principal_ref !== actor.principal_ref ||
          call.principal.deployment_generation !== actor.deployment_generation) fail("WORKFLOW_AUTHORITY_STALE");
      await revalidate();
      return handler(call);
    };
  };
  const external = handlers.external_task;
  const externalTask = external === undefined ? {} : { external_task: Object.freeze({
    async prepare_task(call: Parameters<typeof external.prepare_task>[0]) {
      if (call.request.operation_id !== actor.operation_id || call.request.investigation_ref.id !== actor.investigation_id ||
          call.principal.principal_ref !== actor.principal_ref ||
          call.principal.deployment_generation !== actor.deployment_generation) fail("WORKFLOW_AUTHORITY_STALE");
      await revalidate();
      return external.prepare_task(call);
    },
    async read_recorded_result(call: Parameters<typeof external.read_recorded_result>[0], expectedDigest?: string) {
      if (call.request.operation_id !== actor.operation_id || call.request.investigation_ref.id !== actor.investigation_id ||
          call.principal_ref !== actor.principal_ref ||
          call.deployment_generation !== actor.deployment_generation) fail("WORKFLOW_AUTHORITY_STALE");
      await revalidate();
      return external.read_recorded_result(call, expectedDigest);
    },
  }) };
  if (recoverStartedAttempt === undefined) return Object.assign(wrapped, { native, ...externalTask });
  const recovery: WorkflowStartedAttemptRecovery = async (call) => {
    if (call.request.operation_id !== actor.operation_id || call.principal_ref !== actor.principal_ref ||
        call.deployment_generation !== actor.deployment_generation) fail("WORKFLOW_AUTHORITY_STALE");
    await revalidate();
    return recoverStartedAttempt(call);
  };
  return Object.assign(wrapped, { native, ...externalTask, recoverStartedAttempt: recovery });
}
