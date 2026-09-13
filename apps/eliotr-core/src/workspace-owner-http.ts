import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "@eliotr/contracts";
import type { WorkspaceCandidateAdmissionRequest } from "@eliotr/interfaces";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { HttpRequestError } from "./http-errors.js";

const requestSchema = z.object({
  observation: z.object({
    principal_ref: IdentifierSchema,
    deployment_generation: IdentifierSchema,
    auth_profile: z.enum(["service-token", "managed-oauth"]),
    google_transport: z.literal("gemini-mcp"),
    idempotency_key: IdentifierSchema,
    plan_id: IdentifierSchema,
    plan_sha256: Sha256Schema,
    observation_id: IdentifierSchema,
  }).strict(),
  capture_id: IdentifierSchema,
  conversion_operation_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
}).strict();

export async function readWorkspaceCandidateRequest(request: Request, maximumBytes: number): Promise<WorkspaceCandidateAdmissionRequest> {
  const parsed = requestSchema.safeParse(await readJsonBodyWithinBytes(request, maximumBytes));
  if (!parsed.success) throw new HttpRequestError("WORKSPACE_ADMISSION_INPUT_INVALID", 400, "Workspace import request is invalid");
  return parsed.data;
}

export function readWorkspaceAdmissionId(value: string | undefined): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) throw new HttpRequestError("WORKSPACE_ADMISSION_INPUT_INVALID", 400, "Workspace import reference is invalid");
  return parsed.data;
}
