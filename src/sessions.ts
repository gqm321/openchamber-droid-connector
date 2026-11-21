/**
 * Session registry: one OpenCode session maps to one Droid session, driven
 * through the official @factory/droid-sdk (a `droid exec` stream-jsonrpc
 * subprocess per live session). Also owns the Droid-stream to OpenCode-event
 * translation.
 */

import { randomUUID } from "node:crypto";
import {
  AutonomyLevel,
  ToolConfirmationOutcome,
  createSession,
  resumeSession,
  type DroidSession,
} from "@factory/droid-sdk/node";
import { PROVIDER_ID } from "./catalog.js";
import { getAgentName } from "./agent-name.js";
import { COMPACTED_FALLBACK_TEXT, compactionMessages, latestCompactionSummary, mapTool, parseDroidSessionFile, resultText } from "./droid-map.js";
import {
  droidIdFor,
  droidSessionsMtime,
  findSessionFile,
  ocIdFor,
  removeDroidSessionFiles,
  scanAllDroidSessions,
  scanDroidSessions,
  scanSessionFile,
  SessionStore,
  type ScannedSession,
} from "./session-store.js";
import type {
  OCAssistantMessage,
  OCEvent,
  OCMessageWithParts,
  OCModelRef,
  OCPart,
  OCPermissionRequest,
  OCReasoningPart,
  OCSession,
  OCSessionStatus,
  OCTextPart,
  OCToolPart,
  OCUserMessage,
} from "./types.js";

export const ADAPTER_VERSION = "0.1.0";

type Json = Record<string, unknown>;

const SCRIPT_TOOL = "Script";

/** Outcomes a handler may return without an edited spec (ProceedEdit needs one). */
type Outcome = Exclude<ToolConfirmationOutcome, ToolConfirmationOutcome.ProceedEdit>;

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function autonomy(): AutonomyLevel {
  switch (process.env.OCDROID_AUTONOMY?.trim().toLowerCase()) {
    case "off":
      return AutonomyLevel.Off;
    case "medium":
      return AutonomyLevel.Medium;
    case "high":
      return AutonomyLevel.High;
    default:
      return AutonomyLevel.Low;
  }
}

interface TurnState {
  message: OCAssistantMessage;
  record: OCMessageWithParts;
  /** `<kind>:<droid message id>:<block index>` to the part streaming that block. */
  blocks: Map<string, OCTextPart | OCReasoningPart>;
  /** tool_use id to tool part, for results and permission attribution. */
  tools: Map<string, OCToolPart>;
  /**
   * Droid can run its tools through a `Script` wrapper whose nested calls
   * (Execute, Read, ...) arrive as ordinary tool calls of their own. The
   * wrapper is kept off the UI unless it did something its nested calls
   * did not show, so each action appears once.
   */
  scripts: Map<string, { input: Json; nested: Set<string> }>;
  tokenBase: Tokens;
}

interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_TOKENS: Tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

interface PendingPermission {
  request: OCPermissionRequest;
  options: Array<{ label: string; value: string }>;
  resolve: (outcome: Outcome) => void;
}

export interface ManagedSession {
  info: OCSession;
  droidSessionId: string;
  /** undefined while dormant (known from disk, no droid process yet). */
  droid: DroidSession | undefined;
  /** undefined for dormant sessions until history is parsed from the JSONL. */
  messages: OCMessageWithParts[] | undefined;
  status: OCSessionStatus;
  model: OCModelRef | undefined;
  turn: TurnState | undefined;
  tokens: Tokens;
  /** The user renamed the session; Droid's auto-title must not override it. */
  titleLocked: boolean;
  pending: Map<string, PendingPermission>;
  dormant: boolean;
  /** Settles when the in-flight turn has fully finished (events emitted). */
  turnDone: Promise<void> | undefined;
}

type EventSink = (directory: string, event: OCEvent) => void;

/** Reasoning efforts a model accepts, as reported by Droid's model list. */
export interface ModelEfforts {
  supported: string[];
  default: string;
}
export type EffortResolver = (modelID: string) => Promise<ModelEfforts | undefined>;

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private readonly store: SessionStore;
  private scanCache = new Map<string, { mtimeMs: number; at: number }>();
  private scanAllCache: { mtimeMs: number; at: number } | undefined;
  private resolveEfforts: EffortResolver | undefined;

  constructor(
    private emit: EventSink,
    store?: SessionStore,
    private defaultDirectory?: string,
  ) {
    this.store = store ?? new SessionStore();
  }

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  async create(directory: string, title?: string, parentID?: string): Promise<OCSession> {
    const holder: { s?: ManagedSession } = {};
    const modelId = process.env.OCDROID_MODEL?.trim();
    const droid = await createSession({
      cwd: directory,
      autonomyLevel: autonomy(),
      ...(modelId ? { modelId } : {}),
      permissionHandler: (p) => this.onPermission(holder.s, p),
    });

    const now = Date.now();
    const info: OCSession = {
      id: ocIdFor(droid.id),
      projectID: directory,
      directory,
      title: title ?? "New session",
      version: ADAPTER_VERSION,
      time: { created: now, updated: now },
      ...(parentID !== undefined ? { parentID } : {}),
    };
    const managed: ManagedSession = {
      info,
      droidSessionId: droid.id,
      droid,
      messages: [],
      status: { type: "idle" },
      model: undefined,
      turn: undefined,
      tokens: { ...ZERO_TOKENS },
      titleLocked: title !== undefined && title !== "",
      pending: new Map(),
      dormant: false,
      turnDone: undefined,
    };
    holder.s = managed;
    await this.configure(droid);
    this.sessions.set(info.id, managed);

    this.emit(directory, { type: "session.created", properties: { info } });
    // Announce the real model after session.created so the client already knows
    // the session when the switch marker lands in its transcript.
    this.applyModel(managed, droid.settings.modelId);
    this.persistMeta(managed);
    return info;
  }

  /**
   * Droid may run its tools through a `Script` wrapper; OpenChamber's tool
   * renderers only understand individual calls (Execute, Read, Edit, ...), so
   * force direct execution. Autonomy is re-applied on resume, where the SDK
   * does not accept it as an option.
   */
  private async configure(droid: DroidSession): Promise<void> {
    const mode = process.env.OCDROID_TOOL_MODE?.trim() === "script_only" ? "script_only" : "direct_only";
    await droid
      .updateSettings({ autonomyLevel: autonomy(), toolExecutionMode: mode } as Parameters<DroidSession["updateSettings"]>[0])
      .catch((err: unknown) => console.error("[droid] could not apply session settings:", err instanceof Error ? err.message : err));
  }

  /** Spawn a droid process for a dormant session and adopt it as live. */
  private async revive(s: ManagedSession): Promise<DroidSession> {
    if (s.droid !== undefined) return s.droid;
    const holder = { s };
    const droid = await resumeSession(s.droidSessionId, {
      permissionHandler: (p) => this.onPermission(holder.s, p),
    });
    await this.configure(droid);
    s.droid = droid;
    s.dormant = false;
    this.ensureMessages(s);
    this.applyModel(s, droid.settings.modelId);
    return droid;
  }

  list(directory?: string): OCSession[] {
    if (directory !== undefined) {
      this.ensureScanned(directory);
      return [...this.sessions.values()].map((s) => s.info).filter((s) => s.directory === directory);
    }
    return [...this.sessions.values()].filter((s) => !s.dormant).map((s) => s.info);
  }

  /** Every session on disk plus live ones; backs the directory-less global list. */
  listAll(): OCSession[] {
    this.ensureAllScanned();
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId) ?? this.resolveRestored(sessionId);
  }

  async remove(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    this.emit(s.info.directory, { type: "session.deleted", properties: { info: s.info } });
    this.cancelPending(s);
    if (s.droid !== undefined) await s.droid.close().catch(() => undefined);
    removeDroidSessionFiles(s.droidSessionId, s.info.directory);
    this.store.remove(sessionId);
    return true;
  }

  /**
   * PATCH /session/{id}: rename and/or archive. `title` is only touched when
   * actually sent, otherwise an archive-only PATCH would blank the title.
   */
  update(sessionId: string, patch: { title?: string | undefined; archived?: number | undefined }): OCSession | undefined {
    const s = this.get(sessionId);
    if (!s) return undefined;
    if (typeof patch.title === "string" && patch.title !== "") {
      s.info.title = patch.title;
      s.titleLocked = true;
      if (s.droid !== undefined) void s.droid.rename({ title: patch.title }).catch(() => undefined);
    }
    if (patch.archived !== undefined) {
      if (patch.archived > 0) s.info.time.archived = patch.archived;
      else delete s.info.time.archived;
    }
    s.info.time.updated = Date.now();
    this.persistMeta(s);
    this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    return s.info;
  }

  messages(sessionId: string): OCMessageWithParts[] | undefined {
    const s = this.get(sessionId);
    return s ? this.ensureMessages(s) : undefined;
  }

  statuses(): Record<string, OCSessionStatus> {
    const out: Record<string, OCSessionStatus> = {};
    for (const s of this.sessions.values()) out[s.info.id] = s.status;
    return out;
  }

  async abort(sessionId: string): Promise<boolean> {
    const s = this.get(sessionId);
    if (!s) return false;
    if (s.droid === undefined) return true; // dormant sessions are idle by definition
    this.cancelPending(s);
    await s.droid.interrupt().catch(() => undefined);
    return true;
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => (s.droid !== undefined ? s.droid.close().catch(() => undefined) : undefined)));
    this.sessions.clear();
  }

  // ------------------------------------------------------------------
  // models
  // ------------------------------------------------------------------

  /**
   * POST /api/session/{id}/model. OpenChamber awaits this before every prompt,
   * so it is the path from the model picker to Droid. Errors are not swallowed:
   * a silent no-op lets the UI and Droid disagree about the model.
   */
  async setModel(sessionId: string, ref: OCModelRef, variant?: string): Promise<OCModelRef> {
    const s = this.get(sessionId);
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`);
    const droid = await this.revive(s);
    if (s.model === undefined || s.model.modelID !== ref.modelID) {
      await droid.updateSettings({ modelId: ref.modelID });
      this.applyModel(s, droid.settings.modelId || ref.modelID);
    }
    await this.applyReasoningEffort(droid, s.model?.modelID ?? ref.modelID, variant);
    return s.model ?? { providerID: PROVIDER_ID, modelID: ref.modelID };
  }

  /**
   * The UI's "variant" is a Droid reasoning effort. No variant means the picker
   * is on the model's default, so the effort is reset to it; otherwise a level
   * chosen for the previous model would silently carry over.
   */
  private async applyReasoningEffort(droid: DroidSession, modelID: string, variant: string | undefined): Promise<void> {
    const efforts = await this.resolveEfforts?.(modelID);
    if (efforts === undefined) return;
    const wanted = variant !== undefined && efforts.supported.includes(variant) ? variant : efforts.default;
    if (droid.settings.reasoningEffort === wanted) return;
    try {
      await droid.updateSettings({ reasoningEffort: wanted } as Parameters<DroidSession["updateSettings"]>[0]);
    } catch (err) {
      console.error(`[model] could not set reasoning effort "${wanted}" for ${modelID}:`, err instanceof Error ? err.message : err);
    }
  }

  setEffortResolver(resolver: EffortResolver): void {
    this.resolveEfforts = resolver;
  }

  /** Single funnel for "Droid is now running this model": adopt, persist, tell the UI. */
  private applyModel(s: ManagedSession, modelId: unknown): boolean {
    if (typeof modelId !== "string" || modelId === "") return false;
    const previous = s.model;
    if (previous !== undefined && previous.modelID === modelId) return false;
    const model: OCModelRef = { providerID: PROVIDER_ID, modelID: modelId };
    s.model = model;
    this.persistMeta(s);
    this.emit(s.info.directory, {
      type: "model.changed",
      properties: { sessionID: s.info.id, model, ...(previous !== undefined ? { previous } : {}) },
    });
    return true;
  }

  // ------------------------------------------------------------------
  // prompt / turn
  // ------------------------------------------------------------------

  async prompt(
    sessionId: string,
    text: string,
    model?: OCModelRef,
    noReply = false,
    messageID?: string,
    variant?: string,
  ): Promise<void> {
    const s = this.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    const droid = await this.revive(s);
    this.ensureMessages(s);

    if (model !== undefined) {
      try {
        await this.setModel(sessionId, model, variant);
      } catch (err) {
        this.emitError(s, err instanceof Error ? err.message : String(err));
        throw err;
      }
    }

    // OpenChamber sends a client-generated messageID with its optimistic insert;
    // the server must reuse it so the echoed events reconcile the optimistic
    // entry in place instead of rendering the user's message twice.
    const userMsg: OCUserMessage = {
      id: typeof messageID === "string" && messageID !== "" ? messageID : id("msg"),
      sessionID: s.info.id,
      role: "user",
      time: { created: Date.now() },
      agent: getAgentName(),
      model: s.model ?? model ?? { providerID: PROVIDER_ID, modelID: "unknown" },
    };
    const parts: OCPart[] = [{ id: id("prt"), sessionID: s.info.id, messageID: userMsg.id, type: "text", text }];
    s.messages?.push({ info: userMsg, parts });
    s.info.time.updated = Date.now();
    if (s.info.title === "New session") {
      s.info.title = text.slice(0, 60);
      this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
    }
    this.emit(s.info.directory, { type: "message.updated", properties: { info: userMsg } });
    for (const p of parts) this.emitPart(s, p);

    if (noReply) return;
    // An interrupted turn needs a moment to wind down; wait for it rather than
    // failing a prompt the user sent right after pressing stop.
    // A compaction in flight also leaves the session busy without a turn.
    if (s.turn !== undefined || s.status.type !== "idle") {
      await Promise.race([s.turnDone, new Promise<void>((resolve) => setTimeout(resolve, 15_000))]);
      if (s.turn !== undefined || s.status.type !== "idle") throw new Error("session is busy");
    }
    s.turnDone = this.runTurn(s, droid, text, userMsg.id);
  }

  /**
   * POST /session/{id}/summarize and /api/session/{id}/compact. Droid compacts in
   * place (same session id, a `compaction_state` record is appended), so the
   * transcript shown in the UI is kept, as in OpenCode, while Droid's own context
   * shrinks. `model` only switches the session when it differs from the current
   * one: re-sending the current model would reset the chosen reasoning effort.
   */
  async compact(sessionId: string, model?: OCModelRef): Promise<void> {
    const s = this.get(sessionId);
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`);
    if (s.turn !== undefined || s.status.type !== "idle") throw new Error("session is busy");
    const droid = await this.revive(s);
    if (model !== undefined && s.model?.modelID !== model.modelID) await this.setModel(sessionId, model);
    const done = this.runCompaction(s, droid);
    s.turnDone = done.catch(() => undefined);
    await done;
  }

  private async runCompaction(s: ManagedSession, droid: DroidSession): Promise<void> {
    this.setStatus(s, { type: "busy" });
    // Same transcript shape OpenCode produces, so OpenChamber shows the /compact
    // marker immediately and the summary once Droid has written it.
    const { user, summary } = compactionMessages({
      sessionID: s.info.id,
      directory: s.info.directory,
      agentName: getAgentName(),
      model: s.model ?? { providerID: PROVIDER_ID, modelID: "unknown" },
      userId: id("msg"),
      summaryId: id("msg"),
      userPartId: id("prt"),
      created: Date.now(),
    });
    const record = summary.info as OCAssistantMessage;
    this.ensureMessages(s).push(user, summary);
    this.emit(s.info.directory, { type: "message.updated", properties: { info: user.info } });
    for (const p of user.parts) this.emitPart(s, p);
    this.emit(s.info.directory, { type: "message.updated", properties: { info: record } });
    try {
      await droid.compact();
      const file = findSessionFile(s.droidSessionId, s.info.directory);
      const written = file === undefined ? undefined : latestCompactionSummary(file);
      const now = Date.now();
      const part: OCTextPart = {
        id: id("prt"),
        sessionID: s.info.id,
        messageID: record.id,
        type: "text",
        text: written !== undefined && written.text.trim() !== "" ? written.text : COMPACTED_FALLBACK_TEXT,
        time: { start: now, end: now },
      };
      summary.parts.push(part);
      this.emitPart(s, part);
      record.time.completed = now;
      record.finish = "stop";
      this.emit(s.info.directory, { type: "message.updated", properties: { info: record } });
      s.info.time.updated = now;
      this.persistMeta(s);
      this.emit(s.info.directory, { type: "session.compacted", properties: { sessionID: s.info.id } });
    } catch (err) {
      record.time.completed = Date.now();
      record.finish = "error";
      record.error = { name: "UnknownError", data: { message: err instanceof Error ? err.message : String(err) } };
      this.emit(s.info.directory, { type: "message.updated", properties: { info: record } });
      throw err;
    } finally {
      this.setStatus(s, { type: "idle" });
      this.emit(s.info.directory, { type: "session.idle", properties: { sessionID: s.info.id } });
    }
  }

  /** Resolves once the session's in-flight turn (if any) has finished. */
  async waitForTurn(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.turnDone;
  }

  private async runTurn(s: ManagedSession, droid: DroidSession, text: string, parentID: string): Promise<void> {
    const assistant: OCAssistantMessage = {
      id: id("msg"),
      sessionID: s.info.id,
      role: "assistant",
      time: { created: Date.now() },
      parentID,
      modelID: s.model?.modelID ?? "unknown",
      providerID: s.model?.providerID ?? PROVIDER_ID,
      mode: getAgentName(),
      path: { cwd: s.info.directory, root: s.info.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    const record: OCMessageWithParts = { info: assistant, parts: [] };
    s.messages?.push(record);
    s.turn = { message: assistant, record, blocks: new Map(), tools: new Map(), scripts: new Map(), tokenBase: { ...s.tokens } };
    this.setStatus(s, { type: "busy" });
    this.emit(s.info.directory, { type: "message.updated", properties: { info: assistant } });

    let finish = "stop";
    try {
      for await (const ev of droid.stream(text, { includePartialMessages: true })) {
        const r = this.onDroidEvent(s, ev as unknown as Json);
        if (r !== undefined) finish = r;
      }
    } catch (err) {
      finish = "error";
      this.emitError(s, err instanceof Error ? err.message : String(err));
    } finally {
      this.finishTurn(s, finish);
    }
  }

  private finishTurn(s: ManagedSession, finish: string): void {
    const turn = s.turn;
    if (turn !== undefined) {
      this.finalizeDanglingTools(s, turn);
      turn.message.time.completed = Date.now();
      turn.message.finish = finish;
      this.applyTurnTokens(s, turn);
      this.emit(s.info.directory, { type: "message.updated", properties: { info: turn.message } });
      s.turn = undefined;
    }
    this.cancelPending(s);
    s.info.time.updated = Date.now();
    this.persistMeta(s);
    this.setStatus(s, { type: "idle" });
    this.emit(s.info.directory, { type: "session.idle", properties: { sessionID: s.info.id } });
  }

  /** Returns a finish reason when the event ends the turn. */
  private onDroidEvent(s: ManagedSession, ev: Json): string | undefined {
    const turn = s.turn;
    if (turn === undefined) return undefined;
    switch (ev.type) {
      case "assistant_text_delta":
        this.onBlockDelta(s, turn, "text", ev);
        return undefined;
      case "assistant_text_complete":
        this.onBlockComplete(s, turn, "text", ev);
        return undefined;
      case "thinking_text_delta":
        this.onBlockDelta(s, turn, "reasoning", ev);
        return undefined;
      case "thinking_text_complete":
        this.onBlockComplete(s, turn, "reasoning", ev);
        return undefined;
      case "tool_call_delta":
        this.onToolDelta(s, turn, ev.toolUse as Json | undefined);
        return undefined;
      case "tool_call":
        this.onToolCall(s, turn, String(ev.toolUseId), String(ev.name), (ev.input ?? {}) as Json);
        return undefined;
      case "tool_result":
        this.onToolResult(s, turn, ev);
        return undefined;
      case "assistant":
        this.onAssistantMessage(s, turn, ev.message as Json | undefined);
        return undefined;
      case "token_usage_update": {
        s.tokens = {
          input: Number(ev.inputTokens ?? 0),
          output: Number(ev.outputTokens ?? 0),
          reasoning: Number(ev.thinkingTokens ?? 0),
          cacheRead: Number(ev.cacheReadTokens ?? 0),
          cacheWrite: Number(ev.cacheCreationTokens ?? 0),
        };
        this.applyTurnTokens(s, turn);
        return undefined;
      }
      case "session_title_updated": {
        const title = typeof ev.title === "string" ? ev.title : "";
        if (title !== "" && !s.titleLocked && title !== s.info.title) {
          s.info.title = title;
          this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
        }
        return undefined;
      }
      case "error":
        this.emitError(s, typeof ev.message === "string" ? ev.message : "droid error");
        return "error";
      case "result":
        if (ev.interrupted === true) return "stop";
        if (ev.success === false) {
          const err = ev.error as { message?: string } | null | undefined;
          if (err?.message !== undefined) this.emitError(s, err.message);
          return "error";
        }
        return "stop";
      default:
        return undefined;
    }
  }

  private applyTurnTokens(s: ManagedSession, turn: TurnState): void {
    const sub = (a: number, b: number): number => Math.max(0, a - b);
    turn.message.tokens = {
      input: sub(s.tokens.input, turn.tokenBase.input),
      output: sub(s.tokens.output, turn.tokenBase.output),
      reasoning: sub(s.tokens.reasoning, turn.tokenBase.reasoning),
      cache: { read: sub(s.tokens.cacheRead, turn.tokenBase.cacheRead), write: sub(s.tokens.cacheWrite, turn.tokenBase.cacheWrite) },
    };
  }

  private onBlockDelta(s: ManagedSession, turn: TurnState, kind: "text" | "reasoning", ev: Json): void {
    const text = typeof ev.text === "string" ? ev.text : "";
    const key = `${kind}:${String(ev.messageId)}:${String(ev.blockIndex)}`;
    let part = turn.blocks.get(key);
    if (part === undefined) {
      part = this.newBlockPart(kind, s.info.id, turn.message.id);
      turn.blocks.set(key, part);
      turn.record.parts.push(part);
      this.emitPart(s, part);
    }
    part.text += text;
    this.emitPart(s, part, text);
  }

  private onBlockComplete(s: ManagedSession, turn: TurnState, kind: "text" | "reasoning", ev: Json): void {
    const part = turn.blocks.get(`${kind}:${String(ev.messageId)}:${String(ev.blockIndex)}`);
    if (part === undefined) return;
    if (part.time !== undefined) part.time.end = Date.now();
    this.emitPart(s, part);
    this.emit(s.info.directory, { type: "message.updated", properties: { info: turn.message } });
  }

  /** The full assistant message backfills any block the delta stream skipped. */
  private onAssistantMessage(s: ManagedSession, turn: TurnState, message: Json | undefined): void {
    if (message === undefined || !Array.isArray(message.content)) return;
    const messageId = String(message.id);
    (message.content as Json[]).forEach((block, index) => {
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        if (turn.blocks.has(`text:${messageId}:${index}`)) return;
        const part = this.newBlockPart("text", s.info.id, turn.message.id);
        part.text = block.text;
        if (part.time !== undefined) part.time.end = Date.now();
        turn.blocks.set(`text:${messageId}:${index}`, part);
        turn.record.parts.push(part);
        this.emitPart(s, part, block.text);
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const outer = (block.scriptExecution as Json | undefined)?.outerToolUseId;
        if (typeof outer === "string") turn.scripts.get(outer)?.nested.add(block.id);
        if (!turn.tools.has(block.id) && !turn.scripts.has(block.id)) {
          this.onToolCall(s, turn, block.id, String(block.name), (block.input ?? {}) as Json);
        }
      }
    });
  }

  private newToolPart(s: ManagedSession, turn: TurnState, callID: string, droidName: string): OCToolPart {
    const part: OCToolPart = {
      id: id("prt"),
      sessionID: s.info.id,
      messageID: turn.message.id,
      type: "tool",
      callID,
      tool: mapTool(droidName, {}).tool,
      state: { status: "pending", input: {}, raw: "" },
    };
    turn.tools.set(callID, part);
    turn.record.parts.push(part);
    return part;
  }

  /** Streaming argument snapshots: input grows as Droid parses the call. */
  private onToolDelta(s: ManagedSession, turn: TurnState, toolUse: Json | undefined): void {
    if (toolUse === undefined || typeof toolUse.id !== "string" || toolUse.name === SCRIPT_TOOL) return;
    let part = turn.tools.get(toolUse.id);
    const fresh = part === undefined;
    part ??= this.newToolPart(s, turn, toolUse.id, String(toolUse.name));
    if (part.state.status !== "pending") return;
    const input = (toolUse.input ?? {}) as Json;
    part.state.raw = JSON.stringify(input);
    part.state.input = input;
    if (fresh) this.emitPart(s, part);
    this.emitPart(s, part);
  }

  private onToolCall(s: ManagedSession, turn: TurnState, callID: string, droidName: string, input: Json): void {
    if (droidName === SCRIPT_TOOL) {
      const known = turn.scripts.get(callID);
      turn.scripts.set(callID, { input, nested: known?.nested ?? new Set() });
      return;
    }
    const part = turn.tools.get(callID) ?? this.newToolPart(s, turn, callID, droidName);
    const mapped = mapTool(droidName, input);
    part.tool = mapped.tool;
    part.state = { status: "running", input: mapped.input, title: mapped.title, time: { start: Date.now() } };
    this.emitPart(s, part);
    this.emit(s.info.directory, { type: "message.updated", properties: { info: turn.message } });
  }

  private onToolResult(s: ManagedSession, turn: TurnState, ev: Json): void {
    const callID = String(ev.toolUseId);
    const script = turn.scripts.get(callID);
    if (script !== undefined && (script.nested.size === 0 || ev.isError === true)) {
      this.onToolCall(s, turn, callID, "script", script.input);
      turn.scripts.delete(callID);
    } else if (script !== undefined) {
      turn.scripts.delete(callID);
      return;
    }
    const part = turn.tools.get(callID);
    if (part === undefined) return;
    const text = resultText(ev.content);
    const start = part.state.status !== "pending" ? part.state.time.start : Date.now();
    const input = part.state.input;
    part.state =
      ev.isError === true
        ? { status: "error", input, error: text !== "" ? text : `tool ${part.tool} failed`, time: { start, end: Date.now() } }
        : {
            status: "completed",
            input,
            output: text,
            title: part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool,
            metadata: {},
            time: { start, end: Date.now() },
          };
    this.emitPart(s, part);
    this.emit(s.info.directory, { type: "message.updated", properties: { info: turn.message } });
  }

  /** Tool parts that never received a result (interrupt, crash) must not spin forever. */
  private finalizeDanglingTools(s: ManagedSession, turn: TurnState): void {
    for (const part of turn.tools.values()) {
      if (part.state.status === "completed" || part.state.status === "error") continue;
      const start = part.state.status === "running" ? part.state.time.start : Date.now();
      part.state = { status: "error", input: part.state.input, error: "run ended without a tool result", time: { start, end: Date.now() } };
      this.emitPart(s, part);
    }
  }

  private newBlockPart(kind: "text" | "reasoning", sessionID: string, messageID: string): OCTextPart | OCReasoningPart {
    const base = { id: id("prt"), sessionID, messageID, text: "", time: { start: Date.now() } };
    return kind === "text" ? { ...base, type: "text" } : { ...base, type: "reasoning" };
  }

  // ------------------------------------------------------------------
  // permissions
  // ------------------------------------------------------------------

  pendingPermissions(): OCPermissionRequest[] {
    return [...this.sessions.values()].flatMap((s) => [...s.pending.values()].map((p) => p.request));
  }

  /** POST /permission/{id}/reply. Returns false when the request is unknown. */
  replyPermission(requestId: string, reply: "once" | "always" | "reject"): boolean {
    for (const s of this.sessions.values()) {
      const p = s.pending.get(requestId);
      if (p === undefined) continue;
      s.pending.delete(requestId);
      const wanted: Outcome =
        reply === "once" ? ToolConfirmationOutcome.ProceedOnce : reply === "always" ? ToolConfirmationOutcome.ProceedAlways : ToolConfirmationOutcome.Cancel;
      const offered = p.options.some((o) => o.value === wanted);
      // "always" may not be offered for every tool; falling back to once is
      // safer than silently denying a call the user just approved.
      const outcome: Outcome = offered ? wanted : reply === "reject" ? ToolConfirmationOutcome.Cancel : ToolConfirmationOutcome.ProceedOnce;
      this.emit(s.info.directory, { type: "permission.replied", properties: { sessionID: s.info.id, requestID: requestId, reply } });
      p.resolve(outcome);
      return true;
    }
    return false;
  }

  private onPermission(s: ManagedSession | undefined, params: unknown): Promise<Outcome> {
    if (s === undefined) return Promise.resolve(ToolConfirmationOutcome.Cancel);
    const p = params as { toolUses?: Json[]; options?: Array<{ label: string; value: string }> };
    const uses = p.toolUses ?? [];
    const first = uses[0] as { toolUse?: Json; confirmationType?: string; details?: Json } | undefined;
    const request: OCPermissionRequest = {
      id: id("per"),
      sessionID: s.info.id,
      permission: permissionName(first?.confirmationType),
      patterns: uses.map((u) => patternOf(u as { toolUse?: Json; details?: Json })),
      metadata: { confirmationType: first?.confirmationType, details: first?.details, tools: uses.map((u) => (u as { toolUse?: Json }).toolUse?.name) },
      always: [],
      ...(typeof first?.toolUse?.id === "string"
        ? { tool: { messageID: s.turn?.message.id ?? "", callID: this.openChamberCallId(s, first.toolUse.id) } }
        : {}),
    };
    return new Promise<Outcome>((resolve) => {
      s.pending.set(request.id, { request, options: p.options ?? [], resolve });
      this.emit(s.info.directory, { type: "permission.asked", properties: request });
    });
  }

  private openChamberCallId(s: ManagedSession, toolUseId: string): string {
    return s.turn?.tools.get(toolUseId)?.callID ?? toolUseId;
  }

  private cancelPending(s: ManagedSession): void {
    for (const [requestId, p] of [...s.pending]) {
      s.pending.delete(requestId);
      this.emit(s.info.directory, { type: "permission.replied", properties: { sessionID: s.info.id, requestID: requestId, reply: "reject" } });
      p.resolve(ToolConfirmationOutcome.Cancel);
    }
  }

  // ------------------------------------------------------------------
  // restore: dormant sessions backed by Droid's session files
  // ------------------------------------------------------------------

  private ensureMessages(s: ManagedSession): OCMessageWithParts[] {
    if (s.messages === undefined) {
      const file = findSessionFile(s.droidSessionId, s.info.directory);
      s.messages =
        file === undefined
          ? []
          : parseDroidSessionFile(file, s.info.id, s.info.directory, getAgentName(), s.model ?? { providerID: PROVIDER_ID, modelID: "unknown" }, PROVIDER_ID);
    }
    return s.messages;
  }

  private knownDroidIds(): Set<string> {
    return new Set([...this.sessions.values()].map((s) => s.droidSessionId));
  }

  private ensureScanned(directory: string): void {
    const mtimeMs = droidSessionsMtime(directory);
    if (mtimeMs === undefined) return;
    const cached = this.scanCache.get(directory);
    if (cached !== undefined && cached.mtimeMs === mtimeMs && Date.now() - cached.at < 5_000) return;
    this.scanCache.set(directory, { mtimeMs, at: Date.now() });
    const known = this.knownDroidIds();
    for (const sc of scanDroidSessions(directory)) if (!known.has(sc.droidSessionId)) this.adopt(sc);
  }

  private ensureAllScanned(): void {
    const mtimeMs = droidSessionsMtime();
    if (mtimeMs === undefined) return;
    const cached = this.scanAllCache;
    if (cached !== undefined && cached.mtimeMs === mtimeMs && Date.now() - cached.at < 5_000) return;
    this.scanAllCache = { mtimeMs, at: Date.now() };
    const known = this.knownDroidIds();
    for (const sc of scanAllDroidSessions()) if (!known.has(sc.droidSessionId)) this.adopt(sc);
  }

  private adopt(sc: ScannedSession): ManagedSession {
    const ocId = ocIdFor(sc.droidSessionId);
    const reg = this.store.get(ocId);
    const info: OCSession = {
      id: ocId,
      projectID: sc.directory,
      directory: sc.directory,
      title: reg?.title ?? sc.title,
      version: ADAPTER_VERSION,
      time: {
        created: sc.created,
        updated: Math.max(sc.updated, reg?.updated ?? 0),
        ...(reg?.archived ? { archived: reg.archived } : {}),
      },
    };
    const managed: ManagedSession = {
      info,
      droidSessionId: sc.droidSessionId,
      droid: undefined,
      messages: undefined,
      status: { type: "idle" },
      model: reg?.model !== undefined ? { providerID: reg.model.providerID, modelID: reg.model.modelID } : undefined,
      turn: undefined,
      tokens: { ...ZERO_TOKENS },
      titleLocked: reg?.title !== undefined,
      pending: new Map(),
      dormant: true,
      turnDone: undefined,
    };
    this.sessions.set(ocId, managed);
    return managed;
  }

  /** Resolve a bare session id (e.g. a deep link after restart) straight from disk. */
  private resolveRestored(sessionId: string): ManagedSession | undefined {
    const droidId = droidIdFor(sessionId);
    if (droidId === undefined) return undefined;
    const file = findSessionFile(droidId);
    if (file === undefined) return undefined;
    const sc = scanSessionFile(file);
    return sc === undefined ? undefined : this.adopt(sc);
  }

  private persistMeta(s: ManagedSession): void {
    this.store.set(s.info.id, {
      droidSessionId: s.droidSessionId,
      directory: s.info.directory,
      ...(s.titleLocked ? { title: s.info.title } : {}),
      ...(s.info.time.archived !== undefined ? { archived: s.info.time.archived } : {}),
      ...(s.model !== undefined ? { model: { providerID: s.model.providerID, modelID: s.model.modelID } } : {}),
      created: s.info.time.created,
      updated: s.info.time.updated,
    });
  }

  // ------------------------------------------------------------------
  // emit helpers
  // ------------------------------------------------------------------

  private setStatus(s: ManagedSession, status: OCSessionStatus): void {
    s.status = status;
    this.emit(s.info.directory, { type: "session.status", properties: { sessionID: s.info.id, status } });
  }

  private emitPart(s: ManagedSession, part: OCPart, delta?: string): void {
    this.emit(s.info.directory, {
      type: "message.part.updated",
      properties: delta === undefined ? { part } : { part, delta },
    });
  }

  private emitError(s: ManagedSession, message: string): void {
    this.emit(s.info.directory, {
      type: "session.error",
      properties: { sessionID: s.info.id, error: { name: "UnknownError", data: { message } } },
    });
  }
}

function permissionName(confirmationType: string | undefined): string {
  switch (confirmationType) {
    case "exec":
    case "script":
      return "bash";
    case "edit":
    case "create":
    case "apply_patch":
      return "edit";
    case "mcp_tool":
      return "mcp";
    default:
      return confirmationType ?? "tool";
  }
}

/** What the permission is about: the command, the file, or the tool name. */
function patternOf(use: { toolUse?: Json; details?: Json }): string {
  const d = use.details ?? {};
  if (typeof d.fullCommand === "string") return d.fullCommand;
  if (typeof d.filePath === "string") return d.filePath;
  if (Array.isArray(d.calls)) {
    const cmds = (d.calls as Json[])
      .map((c) => {
        const conf = c.confirmation as Json | undefined;
        if (typeof conf?.fullCommand === "string") return conf.fullCommand;
        if (typeof conf?.filePath === "string") return conf.filePath;
        return typeof c.toolName === "string" ? c.toolName : "";
      })
      .filter((c) => c !== "");
    if (cmds.length > 0) return cmds.join("; ");
  }
  return typeof use.toolUse?.name === "string" ? use.toolUse.name : "tool";
}
