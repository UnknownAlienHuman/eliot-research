import { Agent } from "agents";
import type { Connection, ConnectionContext } from "agents";
import { Output, streamText } from "ai";
import { z } from "zod";
import type { LanguageModelUsage } from "ai";
import { buildContext } from "./context";
import { persistentResolvedAnswer, resolveCitations } from "./citations";
import type { LabelSource } from "./citations";
import { admitTurn, estimateCost } from "./cost";
import { DEFAULT_MODEL, modelOutputLimit, requireModel } from "./models";
import type { ModelSpec } from "./models";
import { modelFailure, reportedProviderUsage, resolveModelTransport } from "./model-transport";
import { LibraryError } from "./library";
import type { RunTurnInput, TurnView } from "./shared/api";

interface ChatState { active: string | null; queued: RunTurnInput | null; stopRequested: boolean }
export class ChatAgent extends Agent<Env, ChatState> {
  initialState: ChatState = { active: null, queued: null, stopRequested: false };
  private controller: AbortController | undefined;
  private current: Promise<TurnView> | undefined;
  async onStart() {
    void this.sql`CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL)`;
    if (this.state.active) {
      const turn = this.readTurn(this.state.active);
      if (turn?.state === "started") {
        turn.state = turn.answer ? "partial" : "failed";
        turn.error = "The stream was interrupted. Retry starts a new turn; it will not continue automatically.";
        this.writeTurn(turn);
        await this.env.DB.prepare("UPDATE chat_turn SET state=?,error=? WHERE chat_id=? AND turn_id=? AND state='started'")
          .bind(turn.state, turn.error, this.name, turn.turnId).run();
      }
      this.setState({ active: null, queued: null, stopRequested: false });
    }
  }
  shouldConnectionBeReadonly() { return true; }
  shouldSendProtocolMessages() { return false; }
  validateStateChange(_next: ChatState, source: Connection | "server") {
    if (source !== "server") throw new Error("Chat state is server-owned.");
  }
  async onConnect(connection: Connection, context: ConnectionContext) {
    const projectId = new URL(context.request.url).searchParams.get("projectId") ?? "";
    connection.send(JSON.stringify({ type: "snapshot", ...await this.getSnapshot(projectId) }));
  }
  private readTurn(id: string): TurnView | undefined {
    const row = this.sql<{ payload: string }>`SELECT payload FROM turns WHERE id=${id}`[0];
    return row ? JSON.parse(row.payload) as TurnView : undefined;
  }
  private writeTurn(turn: TurnView) {
    void this.sql`INSERT INTO turns(id,payload,created_at) VALUES(${turn.turnId},${JSON.stringify(turn)},${Date.now()})
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`;
    this.broadcast(JSON.stringify({ type: "turn", turn }));
  }
  private async ensureProject(projectId: string) {
    const row = await this.env.DB.prepare("SELECT project_id FROM chat WHERE id=?").bind(this.name).first<{ project_id: string }>();
    if (!row || row.project_id !== projectId) throw new LibraryError("not_found", "Chat not found in this project.", 404);
  }
  async getTurns(projectId: string): Promise<TurnView[]> {
    await this.ensureProject(projectId);
    return this.sql<{ payload: string }>`SELECT payload FROM turns ORDER BY created_at DESC LIMIT 50`
      .reverse().map((row) => JSON.parse(row.payload) as TurnView);
  }
  async getSnapshot(projectId: string) {
    return { turns: await this.getTurns(projectId), queued: this.state.queued ? { turnId: this.state.queued.turnId, question: this.state.queued.question } : null };
  }
  async getStoredTurn(projectId: string, turnId: string) {
    await this.ensureProject(projectId);
    const turn = this.readTurn(turnId);
    if (!turn || !["completed", "partial"].includes(turn.state) || !turn.answer.trim()) throw new LibraryError("conflict", "This answer is not ready to save.", 409);
    const saved = persistentResolvedAnswer(turn.answer, turn.citations);
    return { answer: (turn.state === "partial" ? "Partial answer — the turn ended before completion.\n\n" : "") + saved.text,
      citations: saved.citations, revisionIds: turn.revisionIds, state: turn.state };
  }
  async submitTurn(input: RunTurnInput, wait = false): Promise<TurnView | { turnId: string; queued?: boolean } | { busy: true; message: string }> {
    await this.ensureProject(input.projectId);
    if (input.chatId !== this.name) throw new LibraryError("invalid", "Chat identity mismatch.", 400);
    const prior = this.readTurn(input.turnId);
    if (prior) return wait && this.state.active === input.turnId && this.current ? this.current : prior;
    if (this.state.active === input.turnId) return wait && this.current ? this.current : { turnId: input.turnId };
    if (this.state.active) {
      if (wait) return { busy: true, message: "Another answer is running. Wait or stop it first." };
      if (this.state.queued && this.state.queued.turnId !== input.turnId) return { busy: true, message: "One question is already queued." };
      this.setState({ ...this.state, queued: input });
      this.broadcast(JSON.stringify({ type: "queued", queued: { turnId: input.turnId, question: input.question } }));
      return { turnId: input.turnId, queued: true };
    }
    this.setState({ active: input.turnId, queued: null, stopRequested: false });
    const task = this.runTurn(input);
    this.current = task;
    this.ctx.waitUntil(task.finally(() => {
      const queued = this.state.queued;
      this.current = undefined; this.controller = undefined;
      this.setState({ active: null, queued: null, stopRequested: false });
      this.broadcast(JSON.stringify({ type: "queued", queued: null }));
      if (queued) this.ctx.waitUntil(this.submitTurn(queued));
    }));
    return wait ? task : { turnId: input.turnId };
  }
  async stopTurn(projectId: string, turnId: string) {
    await this.ensureProject(projectId);
    if (this.state.queued?.turnId === turnId) { this.setState({ ...this.state, queued: null }); this.broadcast(JSON.stringify({ type: "queued", queued: null })); }
    if (this.state.active === turnId) { this.setState({ ...this.state, stopRequested: true }); this.controller?.abort(); }
    return { turnId };
  }
  async runTurn(input: RunTurnInput): Promise<TurnView> {
    await this.ensureProject(input.projectId);
    if (this.state.active !== input.turnId) throw new LibraryError("conflict", "Turn was not admitted by this chat.", 409);
    const started = Date.now();
    const turn: TurnView = { turnId: input.turnId, question: input.question, answer: "", state: "started", model: input.model ?? DEFAULT_MODEL,
      scopeMode: input.scopeMode, revisionIds: [], sourceIds: input.sourceIds ?? [], citations: [], invalidLabels: 0, inputTokens: null, cachedTokens: null, outputTokens: null,
      estimatedCostMicrousd: null, firstTokenMs: null, totalMs: null, error: null };
    this.writeTurn(turn);
    this.controller = new AbortController();
    if (this.state.stopRequested) this.controller.abort();
    const timer = setTimeout(() => this.controller?.abort(), 90_000);
    let dispatched = false, rowInserted = false, usage: LanguageModelUsage | undefined, selectedModel: ModelSpec | undefined;
    let labelSources: LabelSource[] = [], sourceMode = "none", streamError = "";
    try {
      const settings = await this.env.DB.prepare(`SELECT COALESCE(p.answer_model,s.answer_model) AS model,p.instructions
        FROM project p CROSS JOIN settings s WHERE p.id=? AND s.id=1`).bind(input.projectId).first<{ model: string; instructions: string }>();
      if (!settings) throw new LibraryError("not_found", "Project or model settings not found.", 404);
      turn.model = input.model ?? settings.model;
      const model = requireModel(turn.model);
      selectedModel = model;
      const transport = await resolveModelTransport(this.env, model, this.name);
      await this.env.DB.prepare(`INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,created_at)
        VALUES(?,?,?,?,?,'none','started',?)`).bind(this.name, turn.turnId, turn.model, turn.scopeMode, "[]", started).run();
      rowInserted = true;
      turn.estimatedCostMicrousd = await admitTurn(this.env, this.name, turn.turnId, model);
      this.writeTurn(turn);
      const history = (await this.getTurns(input.projectId)).filter((item) => item.turnId !== turn.turnId && (item.state === "completed" || (item.state === "partial" && item.citations.length > 0)))
        .flatMap((item) => [{ role: "user" as const, content: item.question, revisionIds: item.revisionIds },
          { role: "assistant" as const, content: item.answer, revisionIds: [...new Set(item.citations.map((citation) => citation.revisionId))] }]);
      const context = await buildContext(this.env, { type: "owner", id: "owner", authentication: "access" }, {
        projectId: input.projectId, scopeMode: input.scopeMode, model, history, question: input.question, instructions: settings.instructions,
        ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }),
      });
      turn.revisionIds = context.revisionIds;
      turn.contextMode = context.mode;
      turn.sourceIds = context.sources.map((source) => source.sourceId);
      labelSources = context.sources; sourceMode = context.mode;
      const labels = labelSources.flatMap((source) => source.blocks.map((block) => `[${source.alias}:${block.id}]`));
      const allowed = new Set(labels);
      const label = labels.length ? z.enum(labels as [string, ...string[]]) : z.string();
      const schema = z.object({ sentences: z.array(z.object({ labels: z.array(label).min(labels.length ? 1 : 0).max(labels.length ? 32 : 0), text: z.string().min(1) })).min(1).max(64) });
      const render = (sentences: ({ text?: string | undefined; labels?: (string | undefined)[] | undefined } | undefined)[] | undefined) =>
        (sentences ?? []).flatMap((sentence) => sentence?.text ? [sentence.text.trimEnd() + "\n" + (sentence.labels ?? []).filter((token) => token !== undefined && allowed.has(token) && !sentence.text?.includes(token)).join(" ")] : []).join("\n\n");
      const formatRules = "Return the requested structured answer. Choose the exact supporting block labels first, then write one statement entailed by those blocks in the question language. Preserve the source's technical terms, qualifiers and experiment conditions; do not turn an observed result into a new causal mechanism. Text may use Markdown but must not contain citation tokens. Mark inference explicitly. With no sources, labels must be empty. Do not invent sources or labels.";
      const instructions = [...context.messages.filter((message) => message.role === "system").map((message) => message.content), settings.instructions, formatRules,
        ...(model.responseFormat === false ? ["Return one JSON object conforming to this schema: " + JSON.stringify(z.toJSONSchema(schema))] : [])].filter(Boolean).join("\n\n");
      const messages = context.messages.filter((message) => message.role !== "system");
      messages.push({ role: "user", content: input.question });
      const inputTokens = Math.ceil(new TextEncoder().encode(JSON.stringify({ instructions, messages, labels })).byteLength / 3) + messages.length * 32 + 1024;
      if (inputTokens + modelOutputLimit(model) > Math.min(model.contextTokens * 0.6, 400000)) throw new LibraryError("invalid", "This question and source set exceed whole-reading context. Narrow the selection.", 400);
      await this.env.DB.prepare("UPDATE chat_turn SET scope_json=?,context_mode=? WHERE chat_id=? AND turn_id=? AND state='started'")
        .bind(JSON.stringify(turn.revisionIds), context.mode, this.name, turn.turnId).run();
      this.writeTurn(turn);
      if (this.controller.signal.aborted) throw new Error("Stopped before dispatch.");
      dispatched = true;
      const result = streamText({ model: transport, instructions, messages,
        output: Output.object({ schema, name: "cited_answer" }),
        maxOutputTokens: modelOutputLimit(model), maxRetries: 0, abortSignal: this.controller.signal,
        onError: ({ error }) => { if (error instanceof Error && ["AI_InvalidPromptError", "AI_InvalidArgumentError"].includes(error.name)) dispatched = false;
          streamError = modelFailure(error, model); console.error("Chat model stream failed", streamError); } });
      let lastWrite = 0;
      for await (const partial of result.partialOutputStream) {
        turn.answer = render(partial.sentences);
        const firstText = turn.firstTokenMs === null && turn.answer.length > 0;
        if (firstText) turn.firstTokenMs = Date.now() - started;
        if (firstText || Date.now() - lastWrite > 100) { this.writeTurn(turn); lastWrite = Date.now(); }
      }
      usage = await result.totalUsage;
      turn.answer = render((await result.output).sentences);
      const finish = await result.finishReason;
      turn.state = finish === "length" ? "partial" : "completed";
      if (!turn.answer.trim()) { turn.state = "failed"; turn.error = "The model returned no answer text."; }
    } catch (error) {
      const stopped = this.controller.signal.aborted;
      turn.state = turn.answer ? "partial" : stopped ? "cancelled" : "failed";
      turn.error = stopped ? "Stopped. A new Send starts a new turn." : streamError || (error instanceof LibraryError ? error.message : selectedModel ? modelFailure(error, selectedModel) : "The answer could not be completed.");
    } finally { clearTimeout(timer); }
    const resolved = resolveCitations(turn.answer, labelSources);
    turn.answer = resolved.text; turn.citations = resolved.citations; turn.invalidLabels = resolved.invalidLabels;
    if (turn.state === "completed" && ((sourceMode !== "none" && !turn.citations.length) || turn.invalidLabels)) {
      turn.state = "partial"; turn.error = "Some source references could not be verified. This answer is incomplete.";
    }
    if (usage) {
      turn.providerUsage = reportedProviderUsage(usage);
      turn.inputTokens = usage.inputTokens ?? null; turn.cachedTokens = usage.inputTokenDetails.cacheReadTokens ?? null; turn.outputTokens = usage.outputTokens ?? null;
      if (turn.inputTokens !== null && turn.outputTokens !== null) {
        turn.estimatedCostMicrousd = estimateCost(requireModel(turn.model), turn.inputTokens, turn.cachedTokens ?? 0, turn.outputTokens);
      }
    }
    if (!dispatched) { turn.estimatedCostMicrousd = 0; turn.inputTokens = 0; turn.cachedTokens = 0; turn.outputTokens = 0; }
    turn.totalMs = Date.now() - started;
    if (turn.totalMs > 90000 && turn.state === "completed") { turn.state = "partial"; turn.error = "The answer exceeded the time bound."; }
    this.writeTurn(turn);
    if (rowInserted) await this.env.DB.prepare(`UPDATE chat_turn SET state=?,input_tokens=?,cached_tokens=?,output_tokens=?,estimated_cost_microusd=?,
      citations=?,invalid_labels=?,first_token_ms=?,total_ms=?,error=? WHERE chat_id=? AND turn_id=?`)
      .bind(turn.state, turn.inputTokens, turn.cachedTokens, turn.outputTokens, turn.estimatedCostMicrousd, turn.citations.length, turn.invalidLabels,
        turn.firstTokenMs, turn.totalMs, turn.error, this.name, turn.turnId).run();
    await this.env.DB.prepare("UPDATE chat SET updated_at=? WHERE id=?").bind(Date.now(), this.name).run();
    return turn;
  }
}
