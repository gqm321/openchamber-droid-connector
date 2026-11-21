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
import { prepareAttachments, type Attachment, type PreparedAttachments } from "./attachments.js";
import { getAgentName } from "./agent-name.js";
import { COMPACTED_FALLBACK_TEXT, compactionMessages, compactionToolPart, completeCompactionPart, latestCompactionSummary, mapTool, outerScriptId, parseDroidSessionFile, resultText, todosOfPart } from "./droid-map.js";
import {
  droidIdFor,
  droidSessionsMtime,
  findSessionFile,
  ocIdFor,
  removeDroidSessionFiles,
  scanAllDroidSessions,
  scanDroidSessions,
  lastCallUsage,
  readLastCallUsage,
  scanSessionFile,
  SessionStore,
  type LastCallUsage,
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
  OCTodo,
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

function usageToTokens(u: LastCallUsage): OCAssistantMessage["tokens"] {
  return { input: u.input, output: u.output, reasoning: 0, cache: { read: u.cacheRead, write: 0 } };
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
}

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
  /** The user renamed the session; Droid's auto-title must not override it. */
  titleLocked: boolean;
  pending: Map<string, PendingPermission>;
  dormant: boolean;
  /** Settles when the in-flight turn has fully finished (events emitted). */
  turnDone: Promise<void> | undefined;
  /** A prompt is being set up (resume, model switch) and its turn has not started yet. */
  preparing?: boolean;
  /** A user-requested /compact is in flight; its own flow reports it. */
  manualCompaction?: boolean;
  /** Compaction Droid started on its own (context threshold), awaiting its summary. */
  autoCompaction?: { record: OCAssistantMessage; card: OCToolPart } | undefined;
  /** Droid summary ids already shown, so a late notification does not add a second card. */
  compactedIds?: Set<string>;
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
      titleLocked: title !== undefined && title !== "",
      pending: new Map(),
      dormant: false,
      turnDone: undefined,
    };
    holder.s = managed;
    await this.configure(droid);
    this.watchUsage(managed, droid);
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

  /**
   * Droid's stream only carries session-wide running totals, which grow past the
   * model's window and say nothing about context size. The raw notification also
   * has `lastCallTokenUsage`, the size of the latest model call, which is what
   * OpenCode records per message and what OpenChamber divides by the context limit.
   */
  private watchUsage(s: ManagedSession, droid: DroidSession): void {
    droid.onNotification((n) => {
      const inner = (n.params as { notification?: Json } | undefined)?.notification;
      if (inner?.type === "droid_working_state_changed" || inner?.type === "session_compacted") {
        this.onCompactionNotification(s, inner);
        return;
      }
      if (inner?.type !== "session_token_usage_changed") return;
      const turn = s.turn;
      const usage = lastCallUsage(inner.lastCallTokenUsage);
      if (turn === undefined || usage === undefined) return;
      const before = turn.message.tokens;
      if (before.input === usage.input && before.output === usage.output && before.cache.read === usage.cacheRead) return;
      turn.message.tokens = usageToTokens(usage);
      this.emit(s.info.directory, { type: "message.updated", properties: { info: turn.message } });
    });
  }

  /** Spawn a droid process for a dormant session and adopt it as live. */
  private async revive(s: ManagedSession): Promise<DroidSession> {
    if (s.droid !== undefined) return s.droid;
    const holder = { s };
    const droid = await resumeSession(s.droidSessionId, {
      permissionHandler: (p) => this.onPermission(holder.s, p),
    });
    await this.configure(droid);
    this.watchUsage(s, droid);
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
  update(
    sessionId: string,
    patch: { title?: string | undefined; archived?: number | undefined; metadata?: Record<string, unknown> | undefined },
  ): OCSession | undefined {
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
    if (patch.metadata !== undefined) {
      if (Object.keys(patch.metadata).length > 0) s.info.metadata = patch.metadata;
      else delete s.info.metadata;
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

  /** The list from the newest TodoWrite call, which is how Droid's own todo panel works. */
  todos(sessionId: string): OCTodo[] | undefined {
    const s = this.get(sessionId);
    if (s === undefined) return undefined;
    const messages = this.ensureMessages(s);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const parts = messages[i]!.parts;
      for (let j = parts.length - 1; j >= 0; j -= 1) {
        const part = parts[j]!;
        const todos = part.type === "tool" ? todosOfPart(part) : undefined;
        if (todos !== undefined) return todos;
      }
    }
    return [];
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
    attachments: Attachment[] = [],
  ): Promise<void> {
    const s = this.get(sessionId);
    if (!s) throw new Error(`unknown session: ${sessionId}`);
    const media = prepareAttachments(attachments);

    // Resuming a dormant session and switching model can take several seconds.
    // The UI treats "idle with an unanswered user message" as a lost prompt after
    // a few seconds, so the session goes busy before any of that work starts.
    const wasBusy = s.turn !== undefined || s.status.type !== "idle" || s.preparing === true;
    const owner = !noReply && !wasBusy;
    if (owner) {
      s.preparing = true;
      this.setStatus(s, { type: "busy" });
    }
    let reported = false;
    try {
      const droid = await this.revive(s);
      this.ensureMessages(s);

      if (model !== undefined) {
        try {
          await this.setModel(sessionId, model, variant);
        } catch (err) {
          reported = true;
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
      const parts: OCPart[] = text !== "" ? [{ id: id("prt"), sessionID: s.info.id, messageID: userMsg.id, type: "text", text }] : [];
      for (const att of attachments) {
        parts.push({ id: id("prt"), sessionID: s.info.id, messageID: userMsg.id, type: "file", mime: att.mime, ...(att.filename !== undefined ? { filename: att.filename } : {}), url: att.url });
      }
      s.messages?.push({ info: userMsg, parts });
      s.info.time.updated = Date.now();
      const titleText = text.trim() !== "" ? text : (attachments[0]?.filename ?? "");
      if (s.info.title === "New session" && titleText !== "") {
        s.info.title = titleText.slice(0, 60);
        this.emit(s.info.directory, { type: "session.updated", properties: { info: s.info } });
      }
      this.emit(s.info.directory, { type: "message.updated", properties: { info: userMsg } });
      for (const p of parts) this.emitPart(s, p);

      if (noReply) return;
      // An interrupted turn needs a moment to wind down; wait for it rather than
      // failing a prompt the user sent right after pressing stop.
      // A compaction in flight also leaves the session busy without a turn.
      if (wasBusy) {
        await Promise.race([s.turnDone, new Promise<void>((resolve) => setTimeout(resolve, 15_000))]);
        if (s.turn !== undefined || s.status.type !== "idle" || s.preparing === true) throw new Error("session is busy");
      }
      s.preparing = false;
      s.turnDone = this.runTurn(s, droid, text + media.note, userMsg.id, media);
    } catch (err) {
      if (owner) {
        s.preparing = false;
        if (!reported) this.emitError(s, err instanceof Error ? err.message : String(err));
        this.setStatus(s, { type: "idle" });
        this.emit(s.info.directory, { type: "session.idle", properties: { sessionID: s.info.id } });
      }
      throw err;
    }
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

  /**
   * POST /session/{id}/fork, used by OpenChamber's /btw side conversations.
   * Droid forks the whole transcript (there is no cut point), so a `messageID`
   * is only honoured when nothing the user said comes after it; a fork from
   * an earlier message would silently carry later turns and is refused.
   * The new session is registered dormant, like one restored from disk, so
   * its first prompt starts a droid process bound to the new session.
   */
  async fork(sessionId: string, messageID?: string): Promise<OCSession> {
    const s = this.get(sessionId);
    if (s === undefined) throw new Error(`unknown session: ${sessionId}`);
    if (messageID !== undefined) {
      const messages = this.ensureMessages(s);
      const at = messages.findIndex((m) => m.info.id === messageID);
      if (at < 0) throw new Error(`unknown message: ${messageID}`);
      if (messages.slice(at).some((m) => m.info.role === "user")) throw new Error("forking from an earlier message is not supported");
    }
    // Forking through the session's own handle invalidates that handle ("replaced
    // by" the fork), which would break the parent mid-turn. A throwaway process
    // resumed on the same session forks it and leaves the parent untouched.
    const reader = await resumeSession(s.droidSessionId, {});
    let droidId: string;
    try {
      const forked = await reader.fork({ title: this.forkTitle(s) });
      droidId = forked.id;
      await forked.close().catch(() => undefined);
    } finally {
      await reader.close().catch(() => undefined);
    }

    let file = findSessionFile(droidId, s.info.directory);
    for (let i = 0; file === undefined && i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      file = findSessionFile(droidId, s.info.directory);
    }
    const scanned = file === undefined ? undefined : scanSessionFile(file);
    if (scanned === undefined) throw new Error("forked session was not written to disk");

    const now = Date.now();
    this.store.set(ocIdFor(droidId), {
      droidSessionId: droidId,
      directory: s.info.directory,
      title: scanned.title,
      ...(s.model !== undefined ? { model: { providerID: s.model.providerID, modelID: s.model.modelID } } : {}),
      created: now,
      updated: now,
    });
    const child = this.adopt(scanned);
    child.titleLocked = true;
    this.emit(child.info.directory, { type: "session.created", properties: { info: child.info } });
    return child.info;
  }

  /** "<title> (fork #n)", numbered after the highest fork of the same title in the directory. */
  private forkTitle(s: ManagedSession): string {
    const base = s.info.title.replace(/ \(fork #\d+\)$/, "");
    let highest = 0;
    for (const other of this.sessions.values()) {
      if (other.info.directory !== s.info.directory) continue;
      const m = /^(.*) \(fork #(\d+)\)$/.exec(other.info.title);
      if (m !== null && m[1] === base) highest = Math.max(highest, Number(m[2]));
    }
    return `${base} (fork #${highest + 1})`;
  }

  /**
   * Adds the transcript OpenCode produces for a compaction: a user message with a
   * `compaction` part (shown as /compact) answered by a flagged summary message
   * whose card is filled in once Droid has written the summary.
   */
  private openCompaction(s: ManagedSession, auto: boolean): { user: OCMessageWithParts; record: OCAssistantMessage; card: OCToolPart } {
    const { user, summary } = compactionMessages({
      sessionID: s.info.id,
      directory: s.info.directory,
      agentName: getAgentName(),
      model: s.model ?? { providerID: PROVIDER_ID, modelID: "unknown" },
      userId: id("msg"),
      summaryId: id("msg"),
      userPartId: id("prt"),
      created: Date.now(),
      auto,
    });
    const record = summary.info as OCAssistantMessage;
    this.ensureMessages(s).push(user, summary);
    this.emit(s.info.directory, { type: "message.updated", properties: { info: user.info } });
    for (const p of user.parts) this.emitPart(s, p);
    this.emit(s.info.directory, { type: "message.updated", properties: { info: record } });
    const card = compactionToolPart({ id: id("prt"), sessionID: s.info.id, messageID: record.id, start: Date.now() });
    summary.parts.push(card);
    this.emitPart(s, card);
    return { user, record, card };
  }

  private closeCompaction(s: ManagedSession, record: OCAssistantMessage, card: OCToolPart, text: string): void {
    const now = Date.now();
    completeCompactionPart(card, text.trim() !== "" ? text : COMPACTED_FALLBACK_TEXT, now);
    this.emitPart(s, card);
    record.time.completed = now;
    record.finish = "stop";
    this.emit(s.info.directory, { type: "message.updated", properties: { info: record } });
    s.info.time.updated = now;
    this.persistMeta(s);
    this.emit(s.info.directory, { type: "session.compacted", properties: { sessionID: s.info.id } });
  }

  private failCompaction(s: ManagedSession, record: OCAssistantMessage, card: OCToolPart, err: unknown): void {
    const failedAt = Date.now();
    const message = err instanceof Error ? err.message : String(err);
    card.state = { status: "error", input: {}, error: message, time: { start: card.state.status === "pending" ? failedAt : card.state.time.start, end: failedAt } };
    this.emitPart(s, card);
    record.time.completed = failedAt;
    record.finish = "error";
    record.error = { name: "UnknownError", data: { message } };
    this.emit(s.info.directory, { type: "message.updated", properties: { info: record } });
  }

  private async runCompaction(s: ManagedSession, droid: DroidSession): Promise<void> {
    this.setStatus(s, { type: "busy" });
    s.manualCompaction = true;
    const { record, card } = this.openCompaction(s, false);
    try {
      await droid.compact();
      // The next model call will report the real size; until then Droid's estimate
      // keeps the pre-compaction figure from lingering.
      const stats = await droid.getContextStats().catch(() => undefined);
      if (stats !== undefined && stats.used > 0) record.tokens = usageToTokens({ input: stats.used, output: 0, cacheRead: 0 });
      const file = findSessionFile(s.droidSessionId, s.info.directory);
      const written = file === undefined ? undefined : latestCompactionSummary(file);
      if (written !== undefined) (s.compactedIds ??= new Set()).add(written.id);
      this.closeCompaction(s, record, card, written?.text ?? "");
    } catch (err) {
      this.failCompaction(s, record, card, err);
      throw err;
    } finally {
      s.manualCompaction = false;
      this.setStatus(s, { type: "idle" });
      this.emit(s.info.directory, { type: "session.idle", properties: { sessionID: s.info.id } });
    }
  }

  /**
   * Droid compacts on its own when the context fills up, usually in the middle of
   * a turn. It announces it with a working-state change and, once the summary is
   * written, `session_compacted`; neither is part of the event stream.
   */
  private onCompactionNotification(s: ManagedSession, inner: Json): void {
    if (s.manualCompaction === true) return;
    if (inner.type === "droid_working_state_changed") {
      if (inner.newState === "compacting_conversation" && s.autoCompaction === undefined) this.beginAutoCompaction(s);
      return;
    }
    const summaryId = typeof inner.summaryId === "string" ? inner.summaryId : "";
    if (summaryId !== "" && s.compactedIds?.has(summaryId) === true) return;
    if (summaryId !== "") (s.compactedIds ??= new Set()).add(summaryId);
    if (s.autoCompaction === undefined) this.beginAutoCompaction(s);
    void this.finishAutoCompaction(s, summaryId);
  }

  private beginAutoCompaction(s: ManagedSession): void {
    const turn = s.turn;
    if (turn !== undefined) {
      // What Droid says after compacting belongs below the compaction marker, as
      // when the history is replayed from disk, so the message in progress ends here.
      turn.message.time.completed = Date.now();
      turn.message.finish = "stop";
      this.emit(s.info.directory, { type: "message.updated", properties: { info: turn.message } });
    }
    const { user, record, card } = this.openCompaction(s, true);
    s.autoCompaction = { record, card };
    if (turn === undefined) return;
    const next = this.newAssistantMessage(s, user.info.id);
    const nextRecord: OCMessageWithParts = { info: next, parts: [] };
    s.messages?.push(nextRecord);
    turn.message = next;
    turn.record = nextRecord;
    this.emit(s.info.directory, { type: "message.updated", properties: { info: next } });
  }

  private async finishAutoCompaction(s: ManagedSession, summaryId: string): Promise<void> {
    const pending = s.autoCompaction;
    if (pending === undefined) return;
    // The record is written around the same moment as the notification.
    let text = "";
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const file = findSessionFile(s.droidSessionId, s.info.directory);
      const written = file === undefined ? undefined : latestCompactionSummary(file);
      if (written !== undefined && (summaryId === "" || written.id === summaryId)) {
        text = written.text;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (s.autoCompaction !== pending) return;
    s.autoCompaction = undefined;
    this.closeCompaction(s, pending.record, pending.card, text);
  }

  /** Resolves once the session's in-flight turn (if any) has finished. */
  async waitForTurn(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.turnDone;
  }

  private newAssistantMessage(s: ManagedSession, parentID: string): OCAssistantMessage {
    return {
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
  }

  private async runTurn(s: ManagedSession, droid: DroidSession, text: string, parentID: string, media?: PreparedAttachments): Promise<void> {
    const assistant = this.newAssistantMessage(s, parentID);
    const record: OCMessageWithParts = { info: assistant, parts: [] };
    s.messages?.push(record);
    s.turn = { message: assistant, record, blocks: new Map(), tools: new Map(), scripts: new Map() };
    this.setStatus(s, { type: "busy" });
    this.emit(s.info.directory, { type: "message.updated", properties: { info: assistant } });

    let finish = "stop";
    try {
      const hasMedia = media !== undefined && (media.images.length > 0 || media.files.length > 0);
      // Droid rejects an empty prompt, and an attachment alone is a valid message.
      const prompt = text.trim() === "" && hasMedia ? "See the attached file." : text;
      const options = {
        includePartialMessages: true as const,
        ...(media !== undefined && media.images.length > 0 ? { images: media.images } : {}),
        ...(media !== undefined && media.files.length > 0 ? { files: media.files } : {}),
      };
      for await (const ev of droid.stream(prompt, options)) {
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
        const outer = outerScriptId(block);
        if (outer !== undefined) turn.scripts.get(outer)?.nested.add(block.id);
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
    const todos = todosOfPart(part);
    if (todos !== undefined) this.emit(s.info.directory, { type: "todo.updated", properties: { sessionID: s.info.id, todos } });
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
      // Only the newest assistant message gets the size: it is the one the UI reads. A
      // compaction summary last means the recorded call predates it, so leave it empty.
      const last = s.messages.at(-1)?.info;
      const usage = file === undefined ? undefined : readLastCallUsage(file);
      if (last?.role === "assistant" && last.summary !== true && usage !== undefined) last.tokens = usageToTokens(usage);
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
      ...(reg?.metadata !== undefined ? { metadata: reg.metadata } : {}),
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
      ...(s.info.metadata !== undefined ? { metadata: s.info.metadata } : {}),
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
