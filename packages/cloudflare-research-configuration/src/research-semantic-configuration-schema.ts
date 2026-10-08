import { IdentifierSchema, VersionedRefSchema } from "@eliotr/contracts";
import type { TrustedModelPromptParameters } from "@eliotr/cloudflare-research";
import { fail } from "@eliotr/cloudflare-workflows";
import { z } from "zod";

const PromptSchema = z.object({
  prompt: z.string().min(1), max_tokens: z.number().int().positive().safe(),
  reasoning_effort: z.enum(["low", "medium", "high", "max"]).optional(),
  response_format: z.unknown().optional(), seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  temperature: z.number().finite().optional(), top_p: z.number().finite().optional(),
}).strict();
const PromptConfigSchema = z.object({
  trusted_parameters: PromptSchema,
  request_timeout_ms: z.number().int().min(1).max(300_000),
}).strict();
const NormalizationSchema = z.object({
  section_ref: VersionedRefSchema,
  required_precision: IdentifierSchema,
  required_source_class: IdentifierSchema,
}).strict();
const ConfigurationSchema = z.object({
  protocol: z.literal("eliotr.research-semantic-config.v1"),
  synthesis: PromptConfigSchema,
  audit: PromptConfigSchema.extend({
    verifier_ref: IdentifierSchema,
    verifier_schema_generation: IdentifierSchema,
    allowed_verifier_refs: z.array(IdentifierSchema).min(1).max(512),
    policy: z.unknown(),
  }).strict(),
  roles: PromptConfigSchema.optional(),
  normalization: NormalizationSchema,
}).strict();

export type ResearchSemanticConfiguration = z.infer<typeof ConfigurationSchema>;

function configurationMissing(): never {
  return fail("WORKFLOW_CONFIGURATION_MISSING");
}

function configurationInvalid(): never {
  return fail("WORKFLOW_CONFIGURATION_INVALID");
}

function promptParameters(value: z.infer<typeof PromptSchema>): TrustedModelPromptParameters {
  return { prompt: value.prompt, max_tokens: value.max_tokens,
    ...(value.reasoning_effort === undefined ? {} : { reasoning_effort: value.reasoning_effort }),
    ...(value.response_format === undefined ? {} : { response_format: value.response_format }),
    ...(value.seed === undefined ? {} : { seed: value.seed }),
    ...(value.stop === undefined ? {} : { stop: value.stop }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.top_p === undefined ? {} : { top_p: value.top_p }) };
}

/** Strict, bounded canonical parser shared by project configuration and Worker composition. */
export function parseResearchSemanticConfiguration(raw: string): ResearchSemanticConfiguration {
  if (typeof raw !== "string" || raw.trim() === "") configurationMissing();
  if (new TextEncoder().encode(raw).byteLength > 65_536) configurationInvalid();
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { configurationInvalid(); }
  const parsed = ConfigurationSchema.safeParse(decoded);
  if (!parsed.success) configurationInvalid();
  return parsed.data;
}

export function researchSemanticPromptParameters(
  value: ResearchSemanticConfiguration["synthesis"]["trusted_parameters"],
): TrustedModelPromptParameters {
  return promptParameters(value);
}
