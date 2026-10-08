import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);
const operations = z.enum([
  "catalog", "query", "run", "status", "report", "evidence", "cancel", "recover",
  "ingest.bundle", "workspace.admit", "project.attach",
]);
const grantee = z.object({
  issuer: z.string().max(256).regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u),
  authentication_method: z.literal("service_token"),
  subject: z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u),
}).strict();
const rights = {
  grantee,
  allowed_operations: z.array(operations).min(1).max(11),
  ingest_namespace_ids: z.array(id).max(64),
  expires_at: IsoDateTimeSchema,
  spend_policy_ref: id.optional(),
};

/** A configured locator is not proof that a caller possesses an Access credential. */
export const ProjectClientGrantSchema = z.object({
  protocol: z.literal("eliotr.project-client-grant.v1"),
  grant_id: id,
  project_id: id,
  grantor_principal_ref: id,
  revision,
  state: z.enum(["ACTIVE", "REVOKED"]),
  ...rights,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict();
export type ProjectClientGrant = z.infer<typeof ProjectClientGrantSchema>;
export type ProjectClientOperation = ProjectClientGrant["allowed_operations"][number];
export type ProjectClientGrantee = ProjectClientGrant["grantee"];

export const ProjectClientGrantPutSchema = z.object({
  ...rights,
  ingest_namespace_ids: rights.ingest_namespace_ids.default([]),
  expected_revision: z.number().int().min(0).max(2_147_483_646),
}).strict();
export type ProjectClientGrantPut = z.infer<typeof ProjectClientGrantPutSchema>;

export const ProjectClientGrantRevokeSchema = z.object({
  expected_revision: revision.max(2_147_483_646),
}).strict();

export const ProjectClientGrantListSchema = z.object({
  protocol: z.literal("eliotr.project-client-grants.v1"),
  grants: z.array(ProjectClientGrantSchema).max(20),
  next_grant_id: id.optional(),
}).strict();
export type ProjectClientGrantList = z.infer<typeof ProjectClientGrantListSchema>;
