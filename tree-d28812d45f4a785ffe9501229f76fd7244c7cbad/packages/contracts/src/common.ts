import { z } from "zod";

export const IdentifierSchema = z.string().min(1).max(256);
export const OpaqueTokenSchema = z.string().min(1).max(1024);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export const PositiveIntegerSchema = z.number().int().positive();
export const NonNegativeIntegerSchema = z.number().int().nonnegative();
export const ByteLengthSchema = z.number().int().nonnegative();
export const UrlSchema = z.string().url();

export type Identifier = z.infer<typeof IdentifierSchema>;
export type Sha256 = z.infer<typeof Sha256Schema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const VersionedRefSchema = z.object({
  id: IdentifierSchema,
  revision: PositiveIntegerSchema,
}).strict();
export type VersionedRef = z.infer<typeof VersionedRefSchema>;

export const DigestRefSchema = z.object({
  algorithm: z.literal("sha256"),
  digest: Sha256Schema,
}).strict();
export type DigestRef = z.infer<typeof DigestRefSchema>;

export const BoundedCursorSchema = z.object({
  cursor: OpaqueTokenSchema,
  expires_at: IsoDateTimeSchema.optional(),
}).strict();
export type BoundedCursor = z.infer<typeof BoundedCursorSchema>;
