import { z } from "zod";
import { ErasureRequestSchema, IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import type { OwnerErasurePreparationInput, OwnerErasureRequest } from "@eliotr/interfaces";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { HttpRequestError } from "./http-errors.js";

const requestSchema = z.object({
  protocol: z.literal("eliotr.owner-erasure.v1"),
  permission_ref: VersionedRefSchema,
  request: ErasureRequestSchema,
}).strict();

const preparationSchema = z.object({ source_id: IdentifierSchema, idempotency_key: IdentifierSchema }).strict();

export async function readOwnerErasurePreparation(request: Request, maximumBytes: number): Promise<OwnerErasurePreparationInput> {
  const parsed = preparationSchema.safeParse(await readJsonBodyWithinBytes(request, maximumBytes));
  if (!parsed.success) throw new HttpRequestError("ERASURE_INPUT_INVALID", 400, "Erasure preparation is invalid");
  return parsed.data;
}

export async function readOwnerErasureRequest(request: Request, maximumBytes: number): Promise<OwnerErasureRequest> {
  const parsed = requestSchema.safeParse(await readJsonBodyWithinBytes(request, maximumBytes));
  if (!parsed.success) throw new HttpRequestError("ERASURE_INPUT_INVALID", 400, "Erasure request is invalid");
  return parsed.data;
}

export function readOwnerErasureRef(params: Readonly<Record<string, string>>): VersionedRef {
  const revision = params.revision;
  if (revision === undefined || !/^[1-9][0-9]*$/u.test(revision)) {
    throw new HttpRequestError("ERASURE_INPUT_INVALID", 400, "Erasure revision is invalid");
  }
  const parsed = VersionedRefSchema.safeParse({ id: params.erasure_id, revision: Number(revision) });
  if (!parsed.success) throw new HttpRequestError("ERASURE_INPUT_INVALID", 400, "Erasure reference is invalid");
  return parsed.data;
}
