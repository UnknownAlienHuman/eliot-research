import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
} from "./common.js";
import {
  ChannelReadinessSchema,
} from "./library.js";
import { SourceCurrentnessSchema, SourceRevisionSchema } from "./source.js";

export const LIBRARY_READINESS_PROTOCOL = "eliotr.library-readiness.v1" as const;

/** Owner-only observation of independently verified active Library channels. */
export const LibraryReadinessSchema = z.object({
  protocol: z.literal(LIBRARY_READINESS_PROTOCOL),
  source_id: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  deployment_generation: IdentifierSchema,
  /** String form of the catalog authority epoch captured by beginCatalogRead. */
  catalog_generation: z.string().max(16).regex(/^[1-9][0-9]*$/u),
  observed_at: IsoDateTimeSchema,
  currentness: SourceCurrentnessSchema,
  quality_state: SourceRevisionSchema.shape.quality_state,
  readiness_basis: z.literal("ACTIVE_VERIFIED"),
  channels: z.array(ChannelReadinessSchema).length(3),
}).strict().superRefine((value, ctx) => {
  const expected = new Set<"exact_ready" | "lexical_ready" | "semantic_ready">(["exact_ready", "lexical_ready", "semantic_ready"]);
  const observed = new Set(value.channels.map((channel) => channel.channel));
  if (observed.size !== expected.size || [...expected].some((channel) => !observed.has(channel))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["channels"], message: "readiness must contain exactly one exact, lexical, and semantic channel" });
  }
  for (const [index, channel] of value.channels.entries()) {
    if (channel.source_revision_ref !== value.source_revision_ref) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["channels", index, "source_revision_ref"], message: "channel is not bound to the envelope head" });
    }
    if (channel.state === "ready" && (channel.generation === undefined || channel.receipt_ref === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["channels", index], message: "ready channel requires generation and receipt_ref" });
    }
  }
  if (value.currentness.source_revision_ref !== value.source_revision_ref) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentness", "source_revision_ref"], message: "currentness is not bound to the envelope head" });
  }
});
export type LibraryReadiness = z.infer<typeof LibraryReadinessSchema>;
