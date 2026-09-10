import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, PositiveIntegerSchema, Sha256Schema } from "./common.js";

export const SNAPSHOT_VIEW_PROTOCOL = "eliotr.snapshot-view.v1" as const;
export const SNAPSHOT_VIEW_REF_PREFIX = "snapshot-view:v1:" as const;
export const SnapshotViewObservationFreshnessSchema = z.enum(["observed_with_age", "unknown"]);
export type SnapshotViewObservationFreshness = z.infer<typeof SnapshotViewObservationFreshnessSchema>;

/** Immutable witness required by the reserved snapshot-view source_view_ref family. */
export const SnapshotViewWitnessSchema = z.object({
  protocol: z.literal(SNAPSHOT_VIEW_PROTOCOL),
  source_view_ref: IdentifierSchema,
  capture_id: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  source_logical_id: IdentifierSchema,
  verified_principal_ref: IdentifierSchema,
  owner_system_id: IdentifierSchema,
  source_namespace_id: IdentifierSchema,
  source_owner_generation: IdentifierSchema,
  original_sha256: Sha256Schema,
  original_size_bytes: PositiveIntegerSchema,
  residency_key_digest: Sha256Schema,
  policy_snapshot_sha256: Sha256Schema,
  policy_revision: PositiveIntegerSchema,
  observed_at: IsoDateTimeSchema,
  observation_freshness: SnapshotViewObservationFreshnessSchema,
}).strict();
export type SnapshotViewWitness = z.infer<typeof SnapshotViewWitnessSchema>;
