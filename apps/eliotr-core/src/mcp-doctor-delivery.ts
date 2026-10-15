import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentConnectionError,
  requireComputerAgentConnectionForTransport,
} from "@eliotr/cloudflare-computer-agent/computer-agent-connection-store";
import {
  ComputerAgentQualificationError,
  requireCurrentComputerAgentTransportQualification,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store";
import { GeminiMcpToolError, type McpResearchToolName } from "@eliotr/cloudflare-workspace-mcp";
import {
  DoctorDeliveryError,
  pullDoctorDelivery,
  recordDoctorDeliveryReceipt,
} from "./doctor-delivery.js";
import type { Env } from "./env.js";

export type DoctorDeliveryToolName = Extract<McpResearchToolName,
  "eliotr_doctor_delivery_pull" | "eliotr_doctor_delivery_receipt">;

export function isDoctorDeliveryToolName(name: string): name is DoctorDeliveryToolName {
  return name === "eliotr_doctor_delivery_pull" || name === "eliotr_doctor_delivery_receipt";
}

function translate(error: unknown): never {
  if (error instanceof ComputerAgentConnectionError) {
    throw new GeminiMcpToolError(error.code,
      "Doctor system task requires the current owner-enabled MCP_WRITE connection", error.retryable);
  }
  if (error instanceof ComputerAgentQualificationError) {
    throw new GeminiMcpToolError(error.code,
      "Doctor system task requires current MCP_WRITE qualification", error.retryable);
  }
  if (error instanceof DoctorDeliveryError) {
    throw new GeminiMcpToolError(error.code,
      "Doctor delivery could not be completed under its exact outbox lease", error.retryable);
  }
  throw error;
}

export async function callMcpDoctorDelivery(
  env: Env,
  context: AuthenticatedRequestContext,
  name: DoctorDeliveryToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    const targetId = env.ELIOTR_DOCTOR_AGENT_CONNECTION_ID;
    if (typeof targetId !== "string" || targetId.trim() !== targetId ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(targetId)) {
      throw new DoctorDeliveryError("DOCTOR_DELIVERY_TARGET_UNAVAILABLE", 503,
        "Doctor MCP connection target is not configured");
    }
    // The owner-selected ID authorizes this system task. Qualification only
    // confirms current MCP_WRITE transport for that exact connection revision.
    const connection = await requireComputerAgentConnectionForTransport(
      env.CORE_DB, context, "MCP_WRITE",
    );
    if (connection.connection_id !== targetId) {
      throw new GeminiMcpToolError("DOCTOR_DELIVERY_CONNECTION_MISMATCH",
        "This MCP connection is not the owner-selected doctor delivery target");
    }
    await requireCurrentComputerAgentTransportQualification({
      database: env.CORE_DB,
      context,
      connection,
      transport: "MCP_WRITE",
      deployment_generation: env.DEPLOYMENT_GENERATION,
    });
    if (name === "eliotr_doctor_delivery_pull") {
      return await pullDoctorDelivery({
        database: env.CORE_DB,
        connection,
        target_repository: env.ELIOTR_DOCTOR_GITHUB_REPOSITORY,
        worker_slot: args.worker_slot,
      });
    }
    return await recordDoctorDeliveryReceipt({
      database: env.CORE_DB,
      connection,
      target_repository: env.ELIOTR_DOCTOR_GITHUB_REPOSITORY,
      delivery_id: args.delivery_id,
      lease_generation: args.lease_generation,
      worker_slot: args.worker_slot,
      issue_number: args.issue_number,
      issue_url: args.issue_url,
    });
  } catch (error) {
    return translate(error);
  }
}
