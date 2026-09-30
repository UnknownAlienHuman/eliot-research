import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);
const actor = z.object({
  issuer: z.string().max(256).regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u),
  authentication_method: z.literal("service_token"),
  subject: z.string().max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u),
}).strict();

export const ComputerAgentContourSchema = z.enum([
  "GEMINI_SPARK", "META_MUSE", "OPENAI_DOT", "OTHER",
]);
export const ComputerAgentTransportCapabilitySchema = z.enum([
  "MCP_READ", "MCP_WRITE", "WEB_INBOX",
]);
export const ComputerAgentComputerCapabilitySchema = z.enum([
  "CLOUD_BROWSER", "CLOUD_DESKTOP", "CLOUD_NETWORK", "LOCAL_COMPUTER",
  "LOCAL_FILES", "LOCAL_SHELL", "PYTHON_VM", "CONNECTED_APPS",
  "SCHEDULED_WORK", "PROACTIVE_WORK", "MESSAGING", "SCREENSHOTS",
]);
export const ComputerAgentTaskKindSchema = z.enum(["RESEARCH_BRANCH_ANALYSIS"]);

const transports = z.array(ComputerAgentTransportCapabilitySchema).min(1).max(8)
  .refine((value) => new Set(value).size === value.length, "Transport capabilities must be unique");
const computers = z.array(ComputerAgentComputerCapabilitySchema).max(16)
  .refine((value) => new Set(value).size === value.length, "Computer capabilities must be unique");
const taskKinds = z.array(ComputerAgentTaskKindSchema).min(1).max(8)
  .refine((value) => new Set(value).size === value.length, "Task kinds must be unique");

const mutable = {
  display_name: z.string().min(1).max(128),
  contour: ComputerAgentContourSchema,
  actor,
  transport_capabilities: transports,
  computer_capabilities: computers,
  task_kinds: taskKinds,
};

export const ComputerAgentConnectionSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-connection.v1"),
  connection_id: id,
  revision,
  owner_principal_ref: id,
  state: z.enum(["ENABLED", "DISABLED"]),
  ...mutable,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict();
export type ComputerAgentConnection = z.infer<typeof ComputerAgentConnectionSchema>;
export type ComputerAgentTransportCapability = z.infer<typeof ComputerAgentTransportCapabilitySchema>;
export type ComputerAgentTaskKind = z.infer<typeof ComputerAgentTaskKindSchema>;

export const ComputerAgentConnectionPutSchema = z.object({
  ...mutable,
  expected_revision: z.number().int().min(0).max(2_147_483_646),
}).strict().refine(
  (value) => value.transport_capabilities.includes("MCP_WRITE") ||
    value.transport_capabilities.includes("WEB_INBOX"),
  { path: ["transport_capabilities"], message: "A task connection requires MCP_WRITE or WEB_INBOX" },
);
export type ComputerAgentConnectionPut = z.infer<typeof ComputerAgentConnectionPutSchema>;

export const ComputerAgentConnectionDisableSchema = z.object({
  expected_revision: revision.max(2_147_483_646),
}).strict();

export const ComputerAgentConnectionListSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-connections.v1"),
  connections: z.array(ComputerAgentConnectionSchema).max(20),
  next_connection_id: id.optional(),
}).strict();
export type ComputerAgentConnectionList = z.infer<typeof ComputerAgentConnectionListSchema>;
