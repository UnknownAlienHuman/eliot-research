import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { getAgentByName, routeAgentRequest } from "agents";
import { AuthError, assertOrigin, authenticate } from "./auth";
import type { Actor } from "./auth";
import type { ApiError, MeResponse } from "./shared/api";
import { addSource, attachSource, createProject, getProject, getSource, LibraryError, listProjects, listSources, MAX_SOURCE_BYTES, setProjectScope, updateProject } from "./library";
import { readOriginal, readOutline, readText } from "./read";
import { captureUrl, UrlGuardError } from "./url-guard";
import { monthlyUsage } from "./cost";
import { availableModels, getModelConnection, requireCatalogModel, validGatewayId } from "./models";
import { getPage, listPages, saveAnswer } from "./pages";
import { requestUnderstanding, scheduleDistillation } from "./workflows/distill";
import { getOverview, getUnderstanding } from "./understanding";
import { getProjectKnowledge } from "./knowledge";
import { recheckSavedWiki, requestProjectKnowledge } from "./workflows/knowledge";

export { IngestWorkflow } from "./workflows/ingest";
export { ChatAgent } from "./chat";
export { DistillWorkflow } from "./workflows/distill";
export { ProjectKnowledgeWorkflow } from "./workflows/knowledge";

const app = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

app.use("*", async (c, next) => {
  await next();
  // Preserve the platform's WebSocket upgrade response. It carries no cacheable document body.
  if (c.res.status === 101) return;
  c.header("Cache-Control", "private, no-store");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
});

app.use("*", async (c, next) => {
  c.set("actor", await authenticate(c.req.raw, c.env));
  assertOrigin(c.req.raw, c.env);
  await next();
});

app.get("/api/me", (c) => c.json({ actor: c.get("actor") } satisfies MeResponse));
app.get("/api/health", (c) => c.json({ service: "eliot-research", status: "ok", contour: "k3" }));
app.use("/api/*", bodyLimit({ maxSize: MAX_SOURCE_BYTES + 65_536,
  onError: (c) => c.json({ error: { code: "invalid", message: "Upload one file of at most 25 MiB per request." } } satisfies ApiError, 413),
}));
const uuid = z.uuid();
const title = z.string().trim().min(1).max(200);
const projectInput = z.object({ title, description: z.string().max(2000).optional() }).strict();
const projectPatch = z.object({ title: title.optional(), archived: z.boolean().optional() }).strict();
async function chatRecord(env: Env, projectId: string, chatId: string) {
  const chat = await env.DB.prepare("SELECT id,project_id AS projectId,title,updated_at AS updatedAt FROM chat WHERE id=? AND project_id=? AND archived_at IS NULL")
    .bind(chatId, projectId).first<{ id: string; projectId: string; title: string; updatedAt: number }>();
  if (!chat) throw new LibraryError("not_found", "Chat not found in this project.", 404);
  return chat;
}
app.get("/api/models", async (c) => {
  const warnings: string[] = [];
  const models = await availableModels(c.env, z.string().max(1100).optional().parse(c.req.query("selected")), (warning) => warnings.push(warning));
  return c.json({ models, warnings, defaultModel: (await c.env.DB.prepare("SELECT answer_model AS model FROM settings WHERE id=1").first<{ model: string }>())?.model });
});
app.get("/api/models/connection", async (c) => c.json({ connection: await getModelConnection(c.env) }));
app.put("/api/models/connection", async (c) => {
  if (c.get("actor").type !== "owner") throw new AuthError("invalid", "Only the owner may allow access to a Gateway credential.");
  const input = z.object({ gatewayId: z.string().refine(validGatewayId, "Use an existing named Gateway, not default.").nullable(), confirmCredentialAccess: z.boolean().optional() }).strict().parse(await c.req.json());
  if (input.gatewayId !== null && input.confirmCredentialAccess !== true)
    throw new LibraryError("invalid", "Allow access to the existing provider credentials before connecting.", 400);
  await c.env.DB.prepare("UPDATE settings SET model_gateway_id=?,updated_at=? WHERE id=1").bind(input.gatewayId, Date.now()).run();
  return c.json({ connection: await getModelConnection(c.env) });
});
app.get("/api/settings", async (c) => c.json({ settings: await c.env.DB.prepare("SELECT answer_model AS answerModel,distill_model AS distillModel,auto_distill AS autoDistill,monthly_model_budget_microusd AS monthlyModelBudgetMicrousd,updated_at AS updatedAt FROM settings WHERE id=1").first(), ...await monthlyUsage(c.env) }));
app.put("/api/settings", async (c) => {
  const input = z.object({ answerModel: z.string().min(1), monthlyModelBudgetMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), distillModel: z.string().min(1).optional(), autoDistill: z.boolean().optional() }).strict().parse(await c.req.json());
  await requireCatalogModel(c.env, input.answerModel);
  if (input.distillModel !== undefined) await requireCatalogModel(c.env, input.distillModel);
  await c.env.DB.prepare("UPDATE settings SET answer_model=?,monthly_model_budget_microusd=?,distill_model=COALESCE(?,distill_model),auto_distill=COALESCE(?,auto_distill),updated_at=? WHERE id=1")
    .bind(input.answerModel, input.monthlyModelBudgetMicrousd, input.distillModel ?? null, input.autoDistill === undefined ? null : input.autoDistill ? 1 : 0, Date.now()).run();
  return c.json({ settings: { ...input, updatedAt: Date.now() } });
});
app.patch("/api/projects/:id/settings", async (c) => {
  const projectId = uuid.parse(c.req.param("id")), project = await getProject(c.env, c.get("actor"), projectId);
  const input = z.object({ instructions: z.string().max(10000).optional(), answerModel: z.string().min(1).nullable().optional() }).strict().parse(await c.req.json());
  if (input.answerModel !== undefined && input.answerModel !== null) await requireCatalogModel(c.env, input.answerModel);
  await c.env.DB.prepare("UPDATE project SET instructions=?,answer_model=?,updated_at=? WHERE id=?")
    .bind(input.instructions ?? project.instructions ?? "", input.answerModel === undefined ? project.answerModel ?? null : input.answerModel, Date.now(), projectId).run();
  return c.json({ project: await getProject(c.env, c.get("actor"), projectId) });
});
app.put("/api/projects/:id/scope", async (c) => c.json(await setProjectScope(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")), sourceIds: z.object({ sourceIds: z.array(uuid) }).strict().parse(await c.req.json()).sourceIds })));
app.get("/api/projects/:id/chats", async (c) => {
  const projectId = uuid.parse(c.req.param("id")); await getProject(c.env, c.get("actor"), projectId);
  const cursor = uuid.optional().parse(c.req.query("cursor"));
  const chats = await c.env.DB.prepare(`SELECT id,title,updated_at AS updatedAt FROM chat WHERE project_id=? AND archived_at IS NULL
    AND (? IS NULL OR (created_at,id)<(SELECT created_at,id FROM chat WHERE id=? AND project_id=?))
    ORDER BY created_at DESC,id DESC LIMIT 51`).bind(projectId, cursor ?? null, cursor ?? null, projectId).all<{ id: string }>();
  return c.json({ chats: chats.results.slice(0, 50), nextCursor: chats.results.length > 50 ? chats.results[49]?.id ?? null : null });
});
app.post("/api/projects/:id/chats", async (c) => {
  const projectId = uuid.parse(c.req.param("id")); await getProject(c.env, c.get("actor"), projectId);
  const input = z.object({ title: title.optional() }).strict().parse(await c.req.json());
  const id = crypto.randomUUID(), now = Date.now();
  await c.env.DB.prepare("INSERT INTO chat(id,project_id,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(id, projectId, input.title ?? "New chat", c.get("actor").type, now, now).run();
  return c.json({ chat: { id, title: input.title ?? "New chat", updatedAt: now } }, 201);
});
app.get("/api/projects/:id/chats/:chatId", async (c) => {
  const projectId = uuid.parse(c.req.param("id")), chatId = uuid.parse(c.req.param("chatId"));
  const chat = await chatRecord(c.env, projectId, chatId), agent = await getAgentByName(c.env.CHAT, chatId);
  return c.json({ chat, ...await agent.getSnapshot(projectId), ...await monthlyUsage(c.env) });
});
app.post("/api/projects/:id/chats/:chatId/turns", async (c) => {
  const projectId = uuid.parse(c.req.param("id")), chatId = uuid.parse(c.req.param("chatId")); await chatRecord(c.env, projectId, chatId);
  const input = z.object({ turnId: uuid, question: z.string().trim().min(1).max(400000), scopeMode: z.enum(["project_default", "explicit", "empty"]), sourceIds: z.array(uuid).optional(), model: z.string().optional() }).strict().parse(await c.req.json());
  const agent = await getAgentByName(c.env.CHAT, chatId), wait = c.req.query("wait") === "1";
  const result = await agent.submitTurn({ projectId, chatId, turnId: input.turnId, question: input.question, scopeMode: input.scopeMode,
    ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }), ...(input.model === undefined ? {} : { model: input.model }) }, wait);
  if ("busy" in result) return c.json({ error: { code: "busy", message: result.message } } satisfies ApiError, 409);
  return wait ? c.json({ turn: result }) : c.json(result, 202);
});
app.post("/api/projects/:id/chats/:chatId/turns/:turnId/stop", async (c) => {
  const projectId = uuid.parse(c.req.param("id")), chatId = uuid.parse(c.req.param("chatId")); await chatRecord(c.env, projectId, chatId);
  return c.json(await (await getAgentByName(c.env.CHAT, chatId)).stopTurn(projectId, uuid.parse(c.req.param("turnId"))));
});
app.get("/agents/chat-agent/:chatId", async (c) => {
  const chatId = uuid.parse(c.req.param("chatId")), projectId = uuid.parse(c.req.query("projectId")); await chatRecord(c.env, projectId, chatId);
  return await routeAgentRequest(c.req.raw, { ChatAgent: c.env.CHAT }) ?? c.json({ error: { code: "not_found", message: "Chat connection not found." } } satisfies ApiError, 404);
});
app.post("/api/projects/:id/pages/from-turn", async (c) => {
  const input = z.object({ chatId: uuid, turnId: uuid, title, mutationId: uuid }).strict().parse(await c.req.json());
  return c.json({ page: await saveAnswer(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")), ...input }) }, 201);
});
app.get("/api/projects/:id/pages", async (c) => c.json(await listPages(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")), ...(c.req.query("cursor") ? { cursor: uuid.parse(c.req.query("cursor")) } : {}) })));
app.get("/api/projects/:id/pages/:pageId", async (c) => c.json({ page: await getPage(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")), pageId: uuid.parse(c.req.param("pageId")) }) }));
app.get("/api/projects", async (c) => c.json(await listProjects(c.env, c.get("actor"), uuid.optional().parse(c.req.query("cursor")))));
app.post("/api/projects", async (c) => {
  const input = projectInput.parse(await c.req.json());
  return c.json({ project: await createProject(c.env, c.get("actor"), { title: input.title, ...(input.description === undefined ? {} : { description: input.description }) }) }, 201);
});
app.get("/api/projects/:id", async (c) => c.json({ project: await getProject(c.env, c.get("actor"), uuid.parse(c.req.param("id"))) }));
app.patch("/api/projects/:id", async (c) => {
  const input = projectPatch.parse(await c.req.json());
  return c.json({ project: await updateProject(c.env, c.get("actor"), uuid.parse(c.req.param("id")), {
    ...(input.title === undefined ? {} : { title: input.title }), ...(input.archived === undefined ? {} : { archived: input.archived }),
  }) });
});
app.get("/api/projects/:id/sources", async (c) => c.json(await listSources(c.env, c.get("actor"), uuid.parse(c.req.param("id")), uuid.optional().parse(c.req.query("cursor")))));
app.post("/api/projects/:id/sources/attach", async (c) => {
  const input = z.object({ sourceId: uuid }).strict().parse(await c.req.json());
  return c.json(await attachSource(c.env, c.get("actor"), uuid.parse(c.req.param("id")), input.sourceId));
});
app.post("/api/projects/:id/sources/file", async (c) => {
  const form = await c.req.formData(), file = form.get("file");
  if (!(file instanceof File) || form.getAll("file").length !== 1
    || Array.from(form.values()).filter((value) => value instanceof File).length !== 1) {
    throw new LibraryError("invalid", "Upload exactly one file per request.", 400);
  }
  if (file.size > MAX_SOURCE_BYTES) throw new LibraryError("invalid", "The file exceeds 25 MiB.", 413);
  const sourceId = uuid.optional().parse(form.get("sourceId") ?? undefined);
  return c.json(await addSource(c.env, c.get("actor"), uuid.parse(c.req.param("id")), {
    title: title.parse((form.get("title") ?? file.name).toString().slice(0, 200)), kind: "file", bytes: await file.arrayBuffer(),
    filename: file.name.slice(0, 255), mimeType: file.type || "application/octet-stream", ...(sourceId ? { sourceId } : {}),
  }), 202);
});
app.post("/api/projects/:id/sources/text", async (c) => {
  const input = z.object({ title, text: z.string().min(1), sourceId: uuid.optional() }).strict().parse(await c.req.json());
  const bytes = new TextEncoder().encode(input.text);
  return c.json(await addSource(c.env, c.get("actor"), uuid.parse(c.req.param("id")), {
    title: input.title, kind: "text", bytes: bytes.buffer, filename: `${input.title}.md`, mimeType: "text/markdown", ...(input.sourceId ? { sourceId: input.sourceId } : {}),
  }), 202);
});
app.post("/api/projects/:id/sources/url", async (c) => {
  const input = z.object({ url: z.string().max(2048), title: title.optional(), sourceId: uuid.optional() }).strict().parse(await c.req.json());
  const projectId = uuid.parse(c.req.param("id"));
  await getProject(c.env, c.get("actor"), projectId);
  const captured = await captureUrl(input.url);
  return c.json(await addSource(c.env, c.get("actor"), projectId, {
    title: input.title ?? captured.filename.slice(0, 200), kind: "url", bytes: Uint8Array.from(captured.bytes).buffer,
    filename: captured.filename, mimeType: captured.mimeType, url: captured.url, ...(input.sourceId ? { sourceId: input.sourceId } : {}),
  }), 202);
});
app.get("/api/sources/:id", async (c) => c.json(await getSource(c.env, c.get("actor"), uuid.parse(c.req.param("id")), uuid.optional().parse(c.req.query("revisionId")))));
app.get("/api/sources/:id/understanding", async (c) => c.json(await getUnderstanding(c.env, c.get("actor"), { sourceId: uuid.parse(c.req.param("id")), revisionId: uuid.optional().parse(c.req.query("revisionId")) })));
app.post("/api/sources/:id/understanding", async (c) => {
  const input = z.object({ revisionId: uuid.optional(), saveAvailable: z.boolean().optional(), model: z.string().optional() }).strict().parse(await c.req.json());
  return c.json(await requestUnderstanding(c.env, c.get("actor"), { sourceId: uuid.parse(c.req.param("id")), ...input }), 202);
});
app.get("/api/projects/:id/overview", async (c) => c.json(await getOverview(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")) })));
app.get("/api/projects/:id/knowledge", async (c) => c.json(await getProjectKnowledge(c.env, c.get("actor"), {
  projectId: uuid.parse(c.req.param("id")), operationId: uuid.optional().parse(c.req.query("operationId")),
})));
app.post("/api/projects/:id/knowledge", async (c) => {
  const input = z.object({ mutationId: uuid, model: z.string().min(1).max(1100).optional() }).strict().parse(await c.req.json());
  return c.json(await requestProjectKnowledge(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")), ...input }), 202);
});
app.post("/api/projects/:id/knowledge/wiki", async (c) => {
  const input = z.object({ mutationId: uuid, topicId: z.string().min(1).max(80), model: z.string().min(1).max(1100).optional() }).strict().parse(await c.req.json());
  return c.json(await requestProjectKnowledge(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")), ...input }), 202);
});
app.post("/api/projects/:id/knowledge/wiki/recheck", async (c) => {
  const input = z.object({ mutationId: uuid, revisionId: uuid }).strict().parse(await c.req.json());
  return c.json(await recheckSavedWiki(c.env, c.get("actor"), { projectId: uuid.parse(c.req.param("id")), ...input }), 202);
});
app.get("/api/revisions/:id/text", async (c) => readText(c.env, c.get("actor"), uuid.parse(c.req.param("id"))));
app.get("/api/revisions/:id/range", async (c) => readText(c.env, c.get("actor"), uuid.parse(c.req.param("id")), {
  start: z.coerce.number().int().nonnegative().parse(c.req.query("start")), end: z.coerce.number().int().positive().parse(c.req.query("end")),
}));
app.get("/api/revisions/:id/outline", async (c) => c.json(await readOutline(c.env, c.get("actor"), uuid.parse(c.req.param("id")))));
app.get("/api/revisions/:id/original", async (c) => readOriginal(c.env, c.get("actor"), uuid.parse(c.req.param("id"))));
app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "This API route does not exist." } } satisfies ApiError, 404));
app.all("/mcp", (c) => c.json({ error: { code: "not_found", message: "This route does not exist." } } satisfies ApiError, 404));
app.all("*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: { code: "invalid", message: "This route only accepts reading." } } satisfies ApiError, 405);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof UrlGuardError) {
    return c.json({ error: { code: error.code, message: error.message } } satisfies ApiError, error.reason === "too_large" ? 413 : error.status);
  }
  if (error instanceof LibraryError) return c.json({ error: { code: error.code, message: error.message }, ...(error.duplicate ? { duplicate: error.duplicate } : {}) }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: { code: "invalid", message: "Check the request fields and try again." } } satisfies ApiError, 400);
  if (error instanceof AuthError) {
    return c.json({ error: { code: error.code, message: error.message } } satisfies ApiError, error.status);
  }
  console.error("Request failed", error);
  return c.json({ error: { code: "unavailable", message: "Eliot could not complete this request. Try again." } } satisfies ApiError, 503);
});

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(scheduleDistillation(env)); },
} satisfies ExportedHandler<Env>;
