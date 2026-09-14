import { z } from "zod";
import { IdentifierSchema, VersionedRefSchema } from "@eliotr/contracts";
import type { OwnerNamespaceInitializeInput, OwnerNamespaceRenewalRequest } from "@eliotr/interfaces";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { HttpRequestError } from "./http-errors.js";

const inputSchema = z.object({
  profile_ref: VersionedRefSchema,
  title: z.string().min(1).max(120).refine((title) => title === title.trim() && !/[\u0000-\u001f\u007f]/u.test(title)),
  idempotency_key: IdentifierSchema,
}).strict();

const renewalInputSchema = z.object({
  expected_generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();

export async function readOwnerNamespaceInitialization(request: Request, maximumBytes: number): Promise<OwnerNamespaceInitializeInput> {
  const parsed = inputSchema.safeParse(await readJsonBodyWithinBytes(request, maximumBytes));
  if (!parsed.success) throw new HttpRequestError("NAMESPACE_INPUT_INVALID", 400, "Workspace creation request is invalid");
  return parsed.data;
}

export async function readOwnerNamespaceRenewal(request: Request, maximumBytes: number): Promise<OwnerNamespaceRenewalRequest> {
  const parsed = renewalInputSchema.safeParse(await readJsonBodyWithinBytes(request, maximumBytes));
  if (!parsed.success) throw new HttpRequestError("NAMESPACE_INPUT_INVALID", 400, "Workspace renewal request is invalid");
  return parsed.data;
}
