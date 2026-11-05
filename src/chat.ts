import { Agent, getAgentByName } from "agents";
import type { Connection, ConnectionContext } from "agents";
import { streamText } from "ai";
import type { LanguageModelUsage } from "ai";
import { buildContext } from "./context";
import { answerWarnings, numericCitationLabels, persistentResolvedAnswer, resolveCitations } from "./citations";
import type { LabelSource } from "./citations";
import { admitTurn } from "./cost";
import { modelInputLimit, modelOutputLimit, requireAvailableModel } from "./models";
import { estimateModelInput } from "./model-input";
import type { ModelSpec } from "./models";
import { modelFailure, resolveModelTransport } from "./model-transport";
import { turnUsageProjection } from "./chat-usage";
import { LibraryError } from "./library";
import { readText } from "./read";
import type { ChatSnapshotState, RunTurnInput, TurnPage, TurnView } from "./shared/api";

interface ChatState { active: string | null; queued: RunTurnInput | null; stopRequested: boolean }
interface StoredInput { projectId: string; chatId: string; hasModel: boolean; hasSourceIds: boolean }
interface D1TurnProjection {
  model: string; scopeMode: TurnView["scopeMode"]; scopeJson: string; contextMode: string; state: TurnView["state"];
  inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; tokenLimit: number | null;
  tokenLimitKind: NonNullable<TurnView["tokenLimitKind"]> | null;
  citations: number; invalidLabels: number; firstTokenMs: number | null; totalMs: number | null; error: string | null;
}
function turnProjection(turn: TurnView): D1TurnProjection {
  return { model: turn.model, scopeMode: turn.scopeMode, scopeJson: JSON.stringify(turn.revisionIds), contextMode: turn.contextMode ?? "none",
    state: turn.state, inputTokens: turn.inputTokens, cachedTokens: turn.cachedTokens, outputTokens: turn.outputTokens,
    tokenLimit: turn.tokenLimit, tokenLimitKind: turn.tokenLimitKind ?? null, citations: turn.citations.length, invalidLabels: turn.invalidLabels,
    firstTokenMs: turn.firstTokenMs, totalMs: turn.totalMs, error: turn.error };
}
const SETTLEMENT_PENDING = "This answer is saved, but its usage could not be confirmed. Reopen this conversation to try saving usage again; the answer will not be sent again.";
const SETTLEMENT_MISMATCH = "This answer's stored usage does not match its recorded result. Both records were preserved; no answer was sent again. The records need review.";
function parseStoredTurn(payload: string): TurnView {
  const { input, ...turn } = JSON.parse(payload) as Omit<TurnView, "input"> & { input?: StoredInput };
  return { ...turn, tokenLimit: turn.tokenLimit ?? null, ...(input ? { input:
    { projectId: input.projectId, chatId: input.chatId, turnId: turn.turnId, question: turn.question, scopeMode: turn.scopeMode,
      ...(input.hasModel ? { model: turn.model } : {}), ...(input.hasSourceIds ? { sourceIds: turn.sourceIds } : {}) }
    } : {}) };
}
function publicTurn(turn: TurnView): TurnView {
  return turn.tokenLimitKind === undefined && turn.tokenLimit !== null ? { ...turn, tokenLimitKind: "legacy" } : turn;
}
const PARTIAL_HISTORY_NOTICE = "An earlier assistant answer was partial. Its unfinished text and omissions are not conclusions; ground this answer in the current frozen evidence.";
function sameTurnRequest(a: RunTurnInput, b: RunTurnInput): boolean {
  return a.projectId === b.projectId && a.chatId === b.chatId && a.turnId === b.turnId
    && a.question === b.question && a.scopeMode === b.scopeMode && (a.model ?? null) === (b.model ?? null)
    && JSON.stringify(a.sourceIds ?? []) === JSON.stringify(b.sourceIds ?? []);
}
export function parseTurnCursor(cursor: unknown, chatId: string): { at: number; id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== "string" || cursor.length > 512) throw new Error("cursor");
    const value: unknown = JSON.parse(cursor);
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== chatId || !Number.isSafeInteger(value[1]) || value[1] < 0
      || typeof value[2] !== "string" || !value[2] || value[2].length > 128) throw new Error("cursor");
    return { at: value[1] as number, id: value[2] };
  } catch { throw new LibraryError("invalid", "This conversation cursor is invalid. Reopen the conversation.", 400); }
}
export class ChatAgent extends Agent<Env, ChatState> {
  initialState: ChatState = { active: null, queued: null, stopRequested: false };
  private controller: AbortController | undefined;
  private current: Promise<TurnView> | undefined;
  async onStart() {
    void this.sql`CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL)`;
    void this.sql`CREATE TABLE IF NOT EXISTS chat_history_clock(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL)`;
    void this.sql`INSERT OR IGNORE INTO chat_history_clock(id,version) VALUES(1,0)`;
    if (!this.sql<{ name: string }>`PRAGMA table_info(turns)`.some((column) => column.name === "history_version"))
      void this.sql`ALTER TABLE turns ADD COLUMN history_version INTEGER NOT NULL DEFAULT 0`;
    void this.sql`CREATE INDEX IF NOT EXISTS turns_by_created ON turns(created_at,id)`;
    void this.sql`CREATE INDEX IF NOT EXISTS turns_pending_settlement ON turns(created_at,id) WHERE json_extract(payload,'$.settlementPending')=1`;
    const queued = this.state.queued;
    if (queued) {
      // A retained question has never entered model admission. Preserve its accepted
      // input before any await or state clear, including a promotion interrupted
      // while runTurn was still validating the project.
      this.preserveUndispatched(queued, "This accepted question was not sent to the model because the conversation restarted. Send it again as a new question to retry.");
    }
    if (this.state.active) {
      const turn = this.readTurn(this.state.active);
      if (turn?.state === "started") {
        turn.state = turn.answer ? "partial" : "failed";
        turn.error = "The stream was interrupted. Retry starts a new turn; it will not continue automatically.";
        turn.settlementPending = true;
        this.writeTurn(turn);
      } else if (turn && !turn.input) {
        // Covers a terminal payload written by an older worker before D1 confirmed it.
        turn.settlementPending = true;
        this.writeTurn(turn);
      }
    }
    const active = this.state.active ? this.readTurn(this.state.active) : undefined;
    if (this.state.active || queued) this.changeState({ active: active?.settlementPending ? active.turnId : null, queued: null, stopRequested: false });
    await this.recoverFinishedTurn();
  }
  shouldConnectionBeReadonly() { return true; }
  shouldSendProtocolMessages() { return false; }
  validateStateChange(_next: ChatState, source: Connection | "server") {
    if (source !== "server") throw new Error("Chat state is server-owned.");
  }
  async onConnect(connection: Connection, context: ConnectionContext) {
    const projectId = new URL(context.request.url).searchParams.get("projectId") ?? "";
    // Storage-only recovery runs through server RPC: the SDK forbids setState in a readonly connection context.
    const snapshot = await (await getAgentByName(this.env.CHAT, this.name)).getSnapshot(projectId);
    connection.send(JSON.stringify({ type: "snapshot", ...snapshot }));
  }
  private readTurn(id: string): TurnView | undefined {
    const row = this.sql<{ payload: string; created_at: number; history_version: number }>`SELECT payload,created_at,history_version FROM turns WHERE id=${id}`[0];
    if (!row) return undefined;
    return { ...parseStoredTurn(row.payload), createdAt: row.created_at, historyVersion: row.history_version };
  }
  private writeTurn(turn: TurnView, notify = true) {
    // Shared request fields already live on the turn. Do not duplicate a large
    // accepted question/source selection inside the same 2 MB SQLite row.
    const input: StoredInput | undefined = turn.input ? { projectId: turn.input.projectId, chatId: turn.input.chatId,
      hasModel: turn.input.model !== undefined, hasSourceIds: turn.input.sourceIds !== undefined } : undefined;
    const payload = JSON.stringify({ ...turn, createdAt: undefined, historyVersion: undefined, ...(turn.input ? { input } : {}) });
    this.bumpHistoryClock();
    const [row] = this.sql<{ created_at: number; history_version: number }>`INSERT INTO turns(id,payload,created_at,history_version) VALUES(${turn.turnId},${payload},${Date.now()},1)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,history_version=turns.history_version+1 RETURNING created_at,history_version`;
    if (!row) throw new Error("Stored turn ordering is unavailable.");
    turn.createdAt = row.created_at; turn.historyVersion = row.history_version;
    if (notify) this.notify(JSON.stringify({ type: "turn", turn: publicTurn(turn) }));
  }
  private bumpHistoryClock() { void this.sql`UPDATE chat_history_clock SET version=version+1 WHERE id=1`; }
  private historyClock() { return this.sql<{ version: number }>`SELECT version FROM chat_history_clock WHERE id=1`[0]?.version ?? 0; }
  private changeState(state: ChatState) {
    // Allocate before the write: a failed write may leave a harmless gap, never
    // a changed queue/notice with an older cross-channel projection version.
    this.bumpHistoryClock(); this.setState(state);
  }
  private notifyQueued(queued: Pick<RunTurnInput, "turnId" | "question"> | null) {
    try { this.notify(JSON.stringify({ type: "queued", ...this.snapshotState(), queued })); }
    catch { /* Projection reads, like delivery, cannot interrupt the durable queue transition. */ }
  }
  private snapshotState(): ChatSnapshotState {
    const { queued, active } = this.state;
    const pending = this.sql<{ id: string; error: string | null }>`SELECT id,json_extract(payload,'$.settlementError') AS error FROM turns
      WHERE json_extract(payload,'$.settlementPending')=1 ORDER BY created_at,id LIMIT 1`[0];
    const visible = pending && this.sql<{ id: string }>`SELECT id FROM turns ORDER BY created_at DESC,id DESC LIMIT 50`.some((turn) => turn.id === pending.id);
    return { stateVersion: this.historyClock(), queued: queued && queued.turnId !== active ? { turnId: queued.turnId, question: queued.question } : null,
      settlementError: pending && !visible ? pending.error : null };
  }
  private notify(payload: string) {
    try { this.broadcast(payload); }
    catch { /* A disconnected reader must not interrupt persistence or queue handoff; reconnect reads the stored snapshot. */ }
  }
  private preserveUndispatched(input: RunTurnInput, error: string): TurnView {
    const prior = this.readTurn(input.turnId);
    // This retained self-handoff is cleared before admission. A first started
    // payload may have committed just before that clear failed; it is still
    // known undispatched. Never rewrite a terminal or already-admitted result.
    const handoff = this.state.active === input.turnId && this.state.queued?.turnId === input.turnId
      && prior?.state === "started" && prior.answer === "" && prior.tokenLimit == null && prior.revisionIds.length === 0;
    if (prior && !handoff) return prior;
    const turn: TurnView = { turnId: input.turnId, question: input.question, input,
      answer: "", state: "failed", model: input.model ?? "", scopeMode: input.scopeMode,
      sourceIds: input.sourceIds ?? [], revisionIds: [], contextMode: "none", citations: [], invalidLabels: 0,
      inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0, firstTokenMs: null, totalMs: null, error };
    this.writeTurn(turn);
    return turn;
  }
  private recoverStoppedHandoff(): boolean {
    const queued = this.state.queued;
    if (this.current || !queued || this.state.active !== queued.turnId) return true;
    try {
      const turn = this.preserveUndispatched(queued, "This accepted question was not sent to the model because it could not be saved before starting. Send it again as a new question to retry.");
      if (turn.state === "started") return false; // Never regrade already-admitted work.
      this.changeState({ active: null, queued: null, stopRequested: false });
      this.notifyQueued(null);
      return true;
    } catch { return false; } // Retain input for one storage-only attempt on the next authorised read/submit.
  }
  private requireRecoveredHandoff() {
    if (!this.recoverStoppedHandoff()) throw new LibraryError("unavailable", "The accepted question could not be saved yet. Reopen this conversation to try the storage operation again.", 503);
  }
  private settlementRow(turnId: string) {
    return this.env.DB.prepare(`SELECT model,scope_mode AS scopeMode,scope_json AS scopeJson,context_mode AS contextMode,state,
      input_tokens AS inputTokens,cached_tokens AS cachedTokens,output_tokens AS outputTokens,token_limit AS tokenLimit,token_limit_kind AS tokenLimitKind,
      citations,invalid_labels AS invalidLabels,first_token_ms AS firstTokenMs,total_ms AS totalMs,error
      FROM chat_turn WHERE chat_id=? AND turn_id=?`).bind(this.name, turnId).first<D1TurnProjection>();
  }
  private async settleTurn(turn: TurnView): Promise<TurnView> {
    if (!turn.settlementPending || turn.state === "started") return turn;
    let failure = SETTLEMENT_PENDING;
    try {
      let row = await this.settlementRow(turn.turnId);
      if (row?.state === "started") {
        // A D1 admission/scope write may have committed before the DO checkpoint.
        // Recover known values from that uncompleted row; never replace known usage with null.
        turn.model ||= row.model;
        turn.tokenLimit ??= row.tokenLimit;
        if (row.tokenLimitKind !== null) turn.tokenLimitKind ??= row.tokenLimitKind;
        turn.inputTokens ??= row.inputTokens; turn.cachedTokens ??= row.cachedTokens; turn.outputTokens ??= row.outputTokens;
        if (turn.revisionIds.length === 0 && row.scopeJson !== "[]") {
          const revisions: unknown = JSON.parse(row.scopeJson);
          if (!Array.isArray(revisions) || !revisions.every((id) => typeof id === "string")) throw new Error("Invalid frozen scope");
          turn.revisionIds = revisions;
          if (!["none", "whole", "claims"].includes(row.contextMode)) throw new Error("Invalid frozen context mode");
          turn.contextMode = row.contextMode as NonNullable<TurnView["contextMode"]>;
        }
        if (row.model !== turn.model || row.scopeMode !== turn.scopeMode || row.tokenLimitKind !== (turn.tokenLimitKind ?? null)) failure = SETTLEMENT_MISMATCH;
        else {
          this.writeTurn(turn, false); // Keep recovered known values durable before terminalising D1.
          const p = turnProjection(turn);
          try {
            await this.env.DB.prepare(`UPDATE chat_turn SET state=?,scope_json=?,context_mode=?,input_tokens=?,cached_tokens=?,output_tokens=?,token_limit=?,
              citations=?,invalid_labels=?,first_token_ms=?,total_ms=?,error=? WHERE chat_id=? AND turn_id=? AND state='started' AND model=? AND scope_mode=?`)
              .bind(p.state, p.scopeJson, p.contextMode, p.inputTokens, p.cachedTokens, p.outputTokens, p.tokenLimit, p.citations,
                p.invalidLabels, p.firstTokenMs, p.totalMs, p.error, this.name, turn.turnId, p.model, p.scopeMode).run();
          } catch { /* The update may have committed. One read-back below decides; never repeat it here. */ }
          row = await this.settlementRow(turn.turnId);
        }
      }
      if (!row && turn.tokenLimitKind === undefined && turn.tokenLimit === null && turn.inputTokens === null && turn.cachedTokens === null && turn.outputTokens === null
        && turn.answer === "" && turn.firstTokenMs === null && turn.revisionIds.length === 0) {
        // The pre-INSERT checkpoint cannot have dispatched. A successful primary read
        // confirms that no admission row exists; do not invent one just to settle it.
        turn.tokenLimit = 0; turn.inputTokens = 0; turn.cachedTokens = 0; turn.outputTokens = 0;
      }
      const expected = turnProjection(turn);
      const matches = row && Object.entries(expected).every(([key, value]) => row[key as keyof D1TurnProjection] === value);
      const noAdmission = !row && turn.tokenLimitKind === undefined && turn.tokenLimit === 0 && turn.inputTokens === 0 && turn.cachedTokens === 0 && turn.outputTokens === 0;
      if (matches || noAdmission) {
        delete turn.settlementPending; delete turn.settlementError;
        this.writeTurn(turn);
        return turn;
      }
      if (row && row.state !== "started") failure = SETTLEMENT_MISMATCH;
    } catch { /* Keep the owning result and active pointer discoverable for the next storage-only action. */ }
    const latest = this.readTurn(turn.turnId);
    if (!latest?.settlementPending) return latest ?? turn;
    latest.settlementError = failure;
    this.writeTurn(latest);
    return latest;
  }
  private preserveWaitingQuestion() {
    const queued = this.state.queued;
    if (queued && queued.turnId !== this.state.active) {
      this.preserveUndispatched(queued, "This queued question was not sent to the model because the previous answer could not finish saving. Send it again as a new question to retry.");
      this.changeState({ ...this.state, queued: null });
      this.notifyQueued(null);
    }
  }
  private async recoverFinishedTurn() {
    const active = this.state.active;
    if (!this.current && active && this.state.queued?.turnId !== active) {
      const turn = this.readTurn(active);
      if (turn && (turn.state !== "started" || turn.settlementPending)) this.preserveWaitingQuestion();
    }
    // The partial index finds older pending results even after active was cleared.
    // One action handles at most eight turns, with one conditional update/read-back each.
    const rows = this.sql<{ id: string }>`SELECT id FROM turns WHERE json_extract(payload,'$.settlementPending')=1 ORDER BY created_at,id LIMIT 8`;
    const ids = [...new Set([...(active && this.readTurn(active)?.settlementPending ? [active] : []), ...rows.map((row) => row.id)])].slice(0, 8);
    for (const id of ids) {
      if (this.current && this.state.active === id) continue;
      const turn = this.readTurn(id);
      if (!turn?.settlementPending) continue;
      if (turn.state === "started") {
        turn.state = turn.answer ? "partial" : "failed";
        turn.error = "The stream was interrupted. Retry starts a new turn; it will not continue automatically.";
        this.writeTurn(turn);
      }
      await this.settleTurn(turn);
    }
    if (active && this.state.active === active && !this.current && this.state.queued?.turnId !== active) {
      const turn = this.readTurn(active);
      if (turn && turn.state !== "started" && !turn.settlementPending) this.changeState({ active: null, queued: null, stopRequested: false });
    }
    if (!this.current && !this.state.active) {
      const pending = this.sql<{ id: string }>`SELECT id FROM turns WHERE json_extract(payload,'$.settlementPending')=1 ORDER BY created_at,id LIMIT 1`[0];
      if (pending) { this.preserveWaitingQuestion(); this.changeState({ active: pending.id, queued: null, stopRequested: false }); }
    }
  }
  private async ensureProject(projectId: string) {
    const row = await this.env.DB.prepare("SELECT project_id FROM chat WHERE id=?").bind(this.name).first<{ project_id: string }>();
    if (!row || row.project_id !== projectId) throw new LibraryError("not_found", "Chat not found in this project.", 404);
  }
  async getTurns(projectId: string): Promise<TurnView[]> {
    return (await this.getTurnPage(projectId)).turns;
  }
  async getTurnPage(projectId: string, cursor?: string): Promise<TurnPage> {
    await this.ensureProject(projectId);
    const before = parseTurnCursor(cursor, this.name);
    this.requireRecoveredHandoff();
    await this.recoverFinishedTurn();
    // Fully materialize synchronously. The extra existence query reads only an ID,
    // not a 51st potentially large answer. Updates never move the ordering key.
    type Row = { id: string; payload: string; created_at: number; history_version: number };
    const rows = before
      ? this.sql<Row>`SELECT id,payload,created_at,history_version FROM turns WHERE (created_at,id)<(${before.at},${before.id}) ORDER BY created_at DESC,id DESC LIMIT 50`
      : this.sql<Row>`SELECT id,payload,created_at,history_version FROM turns ORDER BY created_at DESC,id DESC LIMIT 50`;
    const oldest = rows[rows.length - 1];
    const more = rows.length === 50 && oldest && this.sql<{ id: string }>`SELECT id FROM turns WHERE (created_at,id)<(${oldest.created_at},${oldest.id}) LIMIT 1`.length > 0;
    return { turns: rows.reverse().map((row) => publicTurn({ ...parseStoredTurn(row.payload), createdAt: row.created_at, historyVersion: row.history_version })),
      nextCursor: more ? JSON.stringify([this.name, oldest.created_at, oldest.id]) : null };
  }
  async getSnapshot(projectId: string) {
    const { turns, nextCursor } = await this.getTurnPage(projectId);
    return { turns, nextCursor, ...this.snapshotState() };
  }
  async getStoredTurn(projectId: string, turnId: string) {
    await this.ensureProject(projectId);
    await this.recoverFinishedTurn();
    const turn = this.readTurn(turnId);
    if (!turn || !["completed", "partial"].includes(turn.state) || !turn.answer.trim()) throw new LibraryError("conflict", "This answer is not ready to save.", 409);
    const saved = persistentResolvedAnswer(turn.answer, turn.citations);
    const warnings = turn.warnings ?? [];
    const warningNote = warnings.length > 0
      ? `Note: ${warnings.length} statement(s) lack a verified adjacent citation or numeric support.\n\n`
      : "";
    const partialNote = turn.state === "partial"
      ? `Partial answer — ${(turn.error ?? "This answer needs review.").replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&")}\n\n` : "";
    return { answer: partialNote + warningNote + saved.text,
      citations: saved.citations, revisionIds: turn.revisionIds, state: turn.state };
  }
  private startTurn(input: RunTurnInput): Promise<TurnView> {
    // Fresh acceptance needs the same durable input as queue promotion until
    // project validation and the first app-owned payload finish.
    this.changeState({ active: input.turnId, queued: input, stopRequested: false });
    const task = this.runTurn(input);
    this.current = task;
    this.ctx.waitUntil(task.finally(() => this.advanceQueue(input.turnId)));
    return task;
  }
  private advanceQueue(finishedTurnId: string) {
    if (this.state.active !== finishedTurnId) return;
    const queued = this.state.queued;
    this.current = undefined;
    this.controller = undefined;
    // A failed self-handoff only finishes storage. Never dispatch it again; keep
    // its durable input if storage is still unavailable so a read can recover it.
    if (queued?.turnId === finishedTurnId) { this.recoverStoppedHandoff(); return; }
    if (this.readTurn(finishedTurnId)?.settlementPending) {
      try { this.preserveWaitingQuestion(); } catch { /* Keep accepted input until a later storage-only read can save it. */ }
      return;
    }
    if (!queued) {
      this.changeState({ active: null, queued: null, stopRequested: false });
      this.notifyQueued(null);
      return;
    }
    // Claim the queued ID synchronously before runTurn performs its first await.
    // A concurrent submit therefore cannot jump ahead or replace this payload.
    this.changeState({ active: queued.turnId, queued, stopRequested: false });
    this.notifyQueued(null);
    const task = this.runTurn(queued);
    this.current = task;
    this.ctx.waitUntil(task.finally(() => this.advanceQueue(queued.turnId)));
  }
  async submitTurn(input: RunTurnInput, wait = false): Promise<TurnView | { turnId: string; queued?: boolean } | { busy: true; message: string }> {
    await this.ensureProject(input.projectId);
    if (input.chatId !== this.name) throw new LibraryError("invalid", "Chat identity mismatch.", 400);
    this.requireRecoveredHandoff();
    await this.recoverFinishedTurn();
    const prior = this.readTurn(input.turnId);
    if (prior) return wait && this.state.active === input.turnId && this.current ? this.current.then(publicTurn) : publicTurn(prior);
    if (this.state.active === input.turnId) return wait && this.current ? this.current.then(publicTurn) : { turnId: input.turnId };
    if (this.state.active) {
      const settlementError = this.readTurn(this.state.active)?.settlementError;
      if (!this.current && settlementError) return { busy: true, message: settlementError };
      if (wait) return { busy: true, message: "Another answer is running. Wait or stop it first." };
      if (this.state.queued) {
        if (this.state.queued.turnId === this.state.active) return { busy: true, message: "The current question is still being saved. Wait before sending another question." };
        if (this.state.queued.turnId !== input.turnId) return { busy: true, message: "One question is already queued." };
        if (!sameTurnRequest(this.state.queued, input)) throw new LibraryError("conflict", "This turn ID is already queued with different input.", 409);
        return { turnId: input.turnId, queued: true };
      }
      this.changeState({ ...this.state, queued: input });
      this.notifyQueued({ turnId: input.turnId, question: input.question });
      return { turnId: input.turnId, queued: true };
    }
    const task = this.startTurn(input);
    return wait ? task.then(publicTurn) : { turnId: input.turnId };
  }
  async stopTurn(projectId: string, turnId: string) {
    await this.ensureProject(projectId);
    this.requireRecoveredHandoff();
    await this.recoverFinishedTurn();
    if (this.state.queued?.turnId === turnId && this.state.active !== turnId) { this.changeState({ ...this.state, queued: null }); this.notifyQueued(null); }
    if (this.state.active === turnId) { this.changeState({ ...this.state, stopRequested: true }); this.controller?.abort(); }
    return { turnId };
  }
  async runTurn(input: RunTurnInput): Promise<TurnView> {
    try { await this.ensureProject(input.projectId); }
    catch (error) {
      const queued = this.state.queued;
      if (!queued || this.state.active !== input.turnId || !sameTurnRequest(queued, input)) throw error;
      const turn = this.preserveUndispatched(queued, "This accepted question was not sent to the model because its conversation could not be validated. Reopen the conversation before sending a new question.");
      this.changeState({ ...this.state, queued: null });
      return publicTurn(turn);
    }
    if (this.state.active !== input.turnId) throw new LibraryError("conflict", "Turn was not admitted by this chat.", 409);
    const started = Date.now();
    const turn: TurnView = { turnId: input.turnId, question: input.question, answer: "", state: "started", model: input.model ?? "",
      scopeMode: input.scopeMode, revisionIds: [], sourceIds: input.sourceIds ?? [], citations: [], invalidLabels: 0, inputTokens: null, cachedTokens: null, outputTokens: null,
      tokenLimit: null, firstTokenMs: null, totalMs: null, error: null };
    this.writeTurn(turn, false);
    if (this.state.queued?.turnId === input.turnId) this.changeState({ ...this.state, queued: null });
    this.notify(JSON.stringify({ type: "turn", turn }));
    const controller = new AbortController();
    this.controller = controller;
    let checkpointFailed = false;
    let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.state.stopRequested) controller.abort();
    let dispatched = false, usage: LanguageModelUsage | undefined, selectedModel: ModelSpec | undefined;
    let labelSources: LabelSource[] = [], sourceMode = "none", streamError = "";
    try {
      const settings = await this.env.DB.prepare(`SELECT COALESCE(p.answer_model,s.answer_model) AS model,p.instructions
        FROM project p CROSS JOIN settings s WHERE p.id=? AND s.id=1`).bind(input.projectId).first<{ model: string; instructions: string }>();
      if (!settings) throw new LibraryError("not_found", "Project or model settings not found.", 404);
      turn.model = input.model ?? settings.model;
      const model = await requireAvailableModel(this.env, turn.model);
      selectedModel = model;
      const commandCode = model.routing?.provider.gatewaySlug === "custom-command-code";
      turn.settlementPending = true;
      this.writeTurn(turn, false); // An INSERT can commit even when its acknowledgement is lost.
      await this.env.DB.prepare(`INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,created_at)
        VALUES(?,?,?,?,?,'none','started',?)`).bind(this.name, turn.turnId, turn.model, turn.scopeMode, "[]", started).run();
      turn.tokenLimit = await admitTurn(this.env, this.name, turn.turnId, model);
      turn.tokenLimitKind = turn.tokenLimit === null ? "unknown" : "published";
      this.writeTurn(turn);
      const priorTurns = (await this.getTurns(input.projectId)).filter((item) => item.turnId !== turn.turnId
        && (item.state === "completed" || (item.state === "partial" && item.citations.length > 0)));
      const partialTurnIds = new Set(priorTurns.filter((item) => item.state === "partial").map((item) => item.turnId));
      // Command Code uses question plus current frozen context without prior conversation history.
      const history = commandCode ? [] : priorTurns.flatMap((item) => {
        return [{ role: "user" as const, content: item.question, revisionIds: item.revisionIds },
          { role: "assistant" as const, content: item.answer, turnId: item.turnId,
            revisionIds: [...new Set(item.citations.map((citation) => citation.revisionId))],
            citations: item.citations }];
      });
      const context = await buildContext(this.env, { type: "owner", id: "owner", authentication: "access" }, {
        projectId: input.projectId, scopeMode: input.scopeMode, model, history, question: input.question,
        instructions: [settings.instructions, ...(partialTurnIds.size ? [PARTIAL_HISTORY_NOTICE] : [])].filter(Boolean).join("\n\n"),
        ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }),
      });
      turn.revisionIds = context.revisionIds;
      turn.contextMode = context.mode;
      turn.sourceIds = context.sources.map((source) => source.sourceId);
      labelSources = context.sources; sourceMode = context.mode;
      const transport = await resolveModelTransport(this.env, model, this.name);
      const partialHistory = context.messages.some((message) => message.role === "assistant" && message.turnId !== undefined && partialTurnIds.has(message.turnId));
      const instructions = [...context.messages.filter((message) => message.role === "system").map((message) => message.content), settings.instructions,
        ...(partialHistory ? [PARTIAL_HISTORY_NOTICE] : [])].filter(Boolean).join("\n\n");
      const messages = context.messages.filter((message) => message.role !== "system")
        .map(({ role, content }) => ({ role: role as "user" | "assistant", content }));
      messages.push({ role: "user", content: input.question });
      const inputTokens = estimateModelInput({ instructions, messages });
      if (inputTokens > modelInputLimit(model)) throw new LibraryError("invalid", "This question and source set exceed whole-reading context. Narrow the selection.", 400);
      const maxOutputTokens = modelOutputLimit(model, inputTokens);
      this.writeTurn(turn);
      await this.env.DB.prepare("UPDATE chat_turn SET scope_json=?,context_mode=? WHERE chat_id=? AND turn_id=? AND state='started'")
        .bind(JSON.stringify(turn.revisionIds), context.mode, this.name, turn.turnId).run();
      if (controller.signal.aborted) throw controller.signal.reason;
      dispatched = true;
      const result = streamText({ model: transport, instructions, messages,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), maxRetries: 0, ...(selectedModel?.supportsTemperature ? { temperature: 0 } : {}), abortSignal: controller.signal,
        onError: ({ error }) => { if (error instanceof Error && ["AI_InvalidPromptError", "AI_InvalidArgumentError"].includes(error.name)) dispatched = false;
          streamError = modelFailure(error, model); console.error("Chat model stream failed", streamError); } });
      let lastWrite = 0;
      const checkpoint = () => {
        if (checkpointTimer !== undefined) clearTimeout(checkpointTimer);
        checkpointTimer = undefined;
        if (controller.signal.aborted) return;
        try {
          // Persist usable citation targets with the streamed text, so restart can
          // retain them without reconstructing the frozen scope or rereading sources.
          // Keep the raw accumulator intact: the next chunk may finish a label or code span.
          const resolved = resolveCitations(turn.answer, labelSources);
          this.writeTurn({ ...turn, answer: resolved.text, citations: resolved.citations, invalidLabels: resolved.invalidLabels,
            ...(resolved.invalidLabelExamples ? { invalidLabelExamples: resolved.invalidLabelExamples } : {}) });
          lastWrite = Date.now();
        }
        catch { checkpointFailed = true; controller.abort(); }
      };
      for await (const text of result.textStream) {
        if (!text) continue;
        turn.answer += text;
        const firstText = turn.firstTokenMs === null && turn.answer.trim().length > 0;
        if (firstText) turn.firstTokenMs = Date.now() - started;
        const delay = 1000 - (Date.now() - lastWrite);
        if (firstText || delay <= 0) checkpoint();
        else if (checkpointTimer === undefined) checkpointTimer = setTimeout(checkpoint, delay);
      }
      usage = await result.totalUsage;
      turn.answer = await result.text;
      const finish = await result.finishReason;
      const rawFinish = finish === "other" ? await result.rawFinishReason : undefined;
      if (controller.signal.aborted) throw controller.signal.reason;
      // Preserve a short provider status code, never an arbitrary upstream message.
      const finishDetail = rawFinish && rawFinish !== finish && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(rawFinish)
        ? `${finish}; provider: ${rawFinish}` : finish;
      if (finish === "stop" && !streamError) turn.state = "completed";
      else {
        turn.state = "partial";
        turn.error = streamError || `The model stopped before a normal completion (${finishDetail}).`;
      }
      if (!turn.answer.trim()) {
        turn.state = "failed";
        turn.error = streamError || `The model returned no answer text (finish: ${finishDetail}).`;
      }
    } catch (error) {
      const ownerStop = controller.signal.aborted && this.state.stopRequested;
      if (ownerStop) {
        turn.state = turn.answer ? "partial" : "cancelled";
        turn.error = "Stopped. A new Send starts a new turn.";
      } else {
        turn.state = turn.answer ? "partial" : "failed";
        turn.error = streamError || (error instanceof LibraryError ? error.message : selectedModel ? modelFailure(error, selectedModel) : "The answer could not be completed.");
      }
    } finally { if (checkpointTimer !== undefined) clearTimeout(checkpointTimer); }
    if (checkpointFailed) {
      turn.state = turn.answer ? "partial" : "failed";
      turn.error = "The answer stopped because its progress could not be saved. A new Send starts a new turn; no retry was started.";
    }
    const resolved = resolveCitations(turn.answer, labelSources);
    turn.answer = resolved.text; turn.citations = resolved.citations; turn.invalidLabels = resolved.invalidLabels;
    if (resolved.invalidLabelExamples !== undefined && resolved.invalidLabelExamples.length > 0) turn.invalidLabelExamples = resolved.invalidLabelExamples;
    else delete turn.invalidLabelExamples;
    if (turn.state === "completed" && turn.invalidLabels > 0) {
      turn.state = "partial";
      turn.error = `The model finished, but some source references could not be verified. Rejected references: ${turn.invalidLabelExamples?.join(", ") ?? turn.invalidLabels}. Review the answer against its sources.`;
    }
    if (turn.state === "completed" && turn.citations.length === 0
      && (sourceMode === "whole" || sourceMode === "claims") && turn.answer.trim().length > 0) {
      turn.state = "partial"; turn.error = "No source citations were resolved. This answer is incomplete.";
    }
    // Step1 advisory warnings: missing-citation and unsupported-number never change state.
    // Real truncation, stream, provider and protocol failures above keep partial/failed.
    // Reuse the existing numeric-label and R2 quote path; no extra source rereads.
    const grounded = sourceMode !== "none" && turn.answer.trim().length > 0;
    const numericLabels = grounded
      ? new Set(numericCitationLabels(turn.answer, turn.citations)) : new Set<string>();
    const passages = new Map<string, string>();
    if (numericLabels.size > 0) {
      for (const citation of turn.citations) {
        if (!numericLabels.has(citation.label)) continue;
        try {
          const response = await readText(this.env, { type: "owner", id: "owner", authentication: "access" },
            citation.revisionId, { start: citation.start, end: citation.end });
          passages.set(citation.label, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer()));
        } catch {
          continue;
        }
      }
    }
    if (grounded) {
      try {
        const warnings = answerWarnings(turn.answer, turn.citations, passages);
        if (warnings.length > 0) turn.warnings = warnings;
        else delete turn.warnings;
      } catch {
        delete turn.warnings;
      }
    } else {
      delete turn.warnings;
    }
    Object.assign(turn, turnUsageProjection(dispatched, usage));
    turn.totalMs = Date.now() - started;
    this.writeTurn(turn);
    const settled = await this.settleTurn(turn);
    await this.env.DB.prepare("UPDATE chat SET updated_at=? WHERE id=?").bind(Date.now(), this.name).run();
    return publicTurn(settled);
  }
}
