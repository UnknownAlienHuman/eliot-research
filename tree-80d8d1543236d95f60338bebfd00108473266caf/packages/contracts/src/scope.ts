import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, NonNegativeIntegerSchema, PositiveIntegerSchema, Sha256Schema } from "./common.js";

export type ScopeExpression =
  | { kind: "GLOBAL_LIBRARY" }
  | { kind: "PROJECT"; project_id: string }
  | { kind: "SELECTED_SOURCES"; source_ids: string[] }
  | { kind: "SOURCE_CLASS"; source_class: string }
  | { kind: "TAG"; tag: string }
  | { kind: "UNION" | "INTERSECT" | "EXCEPT"; left: ScopeExpression; right: ScopeExpression };

export const ScopeExpressionSchema: z.ZodType<ScopeExpression> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("GLOBAL_LIBRARY") }).strict(),
  z.object({ kind: z.literal("PROJECT"), project_id: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("SELECTED_SOURCES"), source_ids: z.array(IdentifierSchema).min(1) }).strict(),
  z.object({ kind: z.literal("SOURCE_CLASS"), source_class: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("TAG"), tag: IdentifierSchema }).strict(),
  z.object({ kind: z.enum(["UNION", "INTERSECT", "EXCEPT"]), left: ScopeExpressionSchema, right: ScopeExpressionSchema }).strict(),
]));

export const ScopeSnapshotSchema = z.object({
  snapshot_id: IdentifierSchema,
  revision: PositiveIntegerSchema,
  resolved_scope_expression: ScopeExpressionSchema,
  participant_generations: z.record(IdentifierSchema, IdentifierSchema),
  member_source_revision_refs: z.array(IdentifierSchema),
  source_owner_generations: z.record(IdentifierSchema, IdentifierSchema),
  policy_authority_ref: IdentifierSchema,
  disclosure_closure_digest: Sha256Schema,
  purge_ledger_revision: NonNegativeIntegerSchema,
  client_fence_ref: IdentifierSchema.optional(),
  digest: Sha256Schema,
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
}).strict();
export type ScopeSnapshot = z.infer<typeof ScopeSnapshotSchema>;
