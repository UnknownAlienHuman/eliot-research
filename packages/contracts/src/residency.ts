import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "./common.js";

export const ObjectResidencyKeySchema = z.object({
  scope_domain_id: IdentifierSchema,
  access_domain_id: IdentifierSchema,
  confidentiality_domain_id: IdentifierSchema,
  encryption_key_domain_id: IdentifierSchema,
  retention_domain_id: IdentifierSchema,
  erasure_domain_id: IdentifierSchema,
  content_digest: z.object({
    algorithm: z.literal("sha256"),
    digest: Sha256Schema,
  }).strict(),
}).strict();
export type ObjectResidencyKey = z.infer<typeof ObjectResidencyKeySchema>;

export const ResidencyTransitionReceiptSchema = z.object({
  transition_id: IdentifierSchema,
  from_key_digest: Sha256Schema,
  to_key_digest: Sha256Schema,
  operation: z.enum(["COPY", "REENCRYPT"]),
  old_copy_disposition: z.enum(["RETAINED", "PURGE_REQUESTED", "PURGED", "RETENTION_BLOCKED"]),
  authorization_ref: IdentifierSchema,
  integrity_receipt_ref: IdentifierSchema,
}).strict();
export type ResidencyTransitionReceipt = z.infer<typeof ResidencyTransitionReceiptSchema>;
