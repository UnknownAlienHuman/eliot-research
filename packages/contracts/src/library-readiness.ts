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

const CurrentnessFreshnessSchema = SourceCurrentnessSchema.shape.observation_freshness;
const VerifiedCurrentnessObservationSchema = z.object({
  verification: z.literal("VERIFIED"),
  value: SourceCurrentnessSchema,
}).strict();
const UnverifiedCurrentnessObservationSchema = z.object({
  verification: z.literal("NOT_VERIFIED"),
  recorded_freshness: CurrentnessFreshnessSchema,
  reason_codes: z.array(IdentifierSchema).min(1).max(8),
}).strict();
export const LibraryCurrentnessObservationSchema = z.discriminatedUnion("verification", [
  VerifiedCurrentnessObservationSchema,
  UnverifiedCurrentnessObservationSchema,
]);
export type LibraryCurrentnessObservation = z.infer<typeof LibraryCurrentnessObservationSchema>;

/** Owner-only observation of independently verified active Library channels. */
export const LibraryReadinessSchema = z.object({
  protocol: z.literal(LIBRARY_READINESS_PROTOCOL),
  source_id: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  deployment_generation: IdentifierSchema,
  /** String form of the catalog authority epoch captured by beginCatalogRead. */
  catalog_generation: z.string().max(16).regex(/^[1-9][0-9]*$/u),
  observed_at: IsoDateTimeSchema,
  currentness: LibraryCurrentnessObservationSchema,
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
  if (value.currentness.verification === "VERIFIED" &&
      value.currentness.value.source_revision_ref !== value.source_revision_ref) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentness", "value", "source_revision_ref"], message: "currentness is not bound to the envelope head" });
  }
});
export type LibraryReadiness = z.infer<typeof LibraryReadinessSchema>;

/** Saved source-projection observations, never a current project-index probe. */
export const LibraryRowReadinessSchema = z.object({
  protocol: z.literal("eliotr.library-row-readiness.v1"),
  source_revision_ref: IdentifierSchema,
  basis: z.literal("RECORDED_ONLY"),
  scope: z.literal("SOURCE_PROJECTION"),
  observed_at: IsoDateTimeSchema,
  quality_state: SourceRevisionSchema.shape.quality_state,
  channels: z.array(ChannelReadinessSchema).max(3),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, channel] of value.channels.entries()) {
    if (!["exact_ready", "lexical_ready", "semantic_ready"].includes(channel.channel) || seen.has(channel.channel) ||
        channel.source_revision_ref !== value.source_revision_ref ||
        (channel.state === "ready" && (channel.generation === undefined || channel.receipt_ref === undefined))) {
      ctx.addIssue({ code: "custom", path: ["channels", index], message: "Recorded channel identity or ready receipt is invalid" });
    }
    seen.add(channel.channel);
  }
});
export type LibraryRowReadiness = z.infer<typeof LibraryRowReadinessSchema>;
