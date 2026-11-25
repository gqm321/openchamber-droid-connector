/**
 * Droid to OpenCode translation helpers that do not depend on live state:
 * tool name/input mapping and rebuilding a transcript from a session file.
 */

import { readFileSync } from "node:fs";
import type { OCAssistantMessage, OCMessageWithParts, OCModelRef, OCPart, OCQuestionInfo, OCTodo, OCToolPart, OCUserMessage } from "./types.js";
import { dataUrl, parseAttachmentNote, readStoredFile } from "./attachments.js";

type Json = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function shorten(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const TODO_STATUSES = new Set<string>(["pending", "in_progress", "completed", "cancelled"]);
const TODO_PRIORITIES = new Set<string>(["high", "medium", "low"]);

/**
 * Droid's TodoWrite sends `todos` as numbered text ("1. [in_progress] Fix it");
 * OpenCode (and so OpenChamber) wants objects. Arrays pass through normalised.
 * Returns undefined when nothing usable was found.
 */
export function parseTodos(raw: unknown): OCTodo[] | undefined {
  const todos: OCTodo[] = [];
  if (typeof raw === "string") {
    for (const line of raw.split("\n")) {
      const m = /^\s*(?:\d+[.)]\s*)?\[([A-Za-z_ -]+)\]\s*(.+?)\s*$/.exec(line);
      if (m === null) continue;
      const status = m[1]!.trim().toLowerCase().replace(/[ -]/g, "_");
      todos.push({ id: String(todos.length + 1), content: m[2]!, status: (TODO_STATUSES.has(status) ? status : "pending") as OCTodo["status"], priority: "medium" });
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const t = item as Json;
      const content = str(t.content) ?? str(t.text) ?? str(t.title);
      if (content === undefined) continue;
      const status = typeof t.status === "string" && TODO_STATUSES.has(t.status) ? t.status : "pending";
      const priority = typeof t.priority === "string" && TODO_PRIORITIES.has(t.priority) ? t.priority : "medium";
      todos.push({ id: str(t.id) ?? String(todos.length + 1), content, status: status as OCTodo["status"], priority: priority as OCTodo["priority"] });
    }
  } else {
    return undefined;
  }
  return todos.length > 0 || Array.isArray(raw) ? todos : undefined;
}

/** The todo list a `todowrite` tool part carries, if its input holds one. */
export function todosOfPart(part: OCToolPart): OCTodo[] | undefined {
  if (part.tool !== "todowrite") return undefined;
  const todos = part.state.input.todos;
  return Array.isArray(todos) ? (todos as OCTodo[]) : undefined;
}

/**
 * Droid's AskUser questions (the tool input, or the handler's simplified copy)
 * in OpenCode's QuestionInfo shape. The two Droid shapes differ in the label
 * of the header (`header`/`topic`) and in how options carry descriptions.
 */
export function questionsOf(input: Json): OCQuestionInfo[] {
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  const questions: OCQuestionInfo[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Json;
    const options = Array.isArray(q.options) ? (q.options as unknown[]) : [];
    const descriptions = Array.isArray(q.optionDescriptions) ? (q.optionDescriptions as unknown[]) : [];
    questions.push({
      question: str(q.question) ?? "",
      header: shorten(str(q.header) ?? str(q.topic) ?? "", 30),
      options: options.map((o, i) =>
        typeof o === "object" && o !== null
          ? { label: str((o as Json).label) ?? "", description: str((o as Json).description) ?? "" }
          : { label: String(o), description: str(descriptions[i]) ?? "" },
      ),
      multiple: q.multiSelect === true,
      custom: true,
    });
  }
  return questions;
}

/** Answers out of AskUser's result text ("[answer] a, b" per question), for the card's metadata. */
function answersOf(text: string): string[][] {
  return [...text.matchAll(/^\[answer\][ \t]*(.*)$/gm)].map((m) => (m[1] ?? "").split(", ").filter((a) => a !== ""));
}

/** Extra `metadata` a completed tool part carries so OpenChamber's renderers have what they expect. */
export function toolMetadata(tool: string, output: string): Json {
  return tool === "question" ? { answers: answersOf(output) } : {};
}

export interface MappedTool {
  tool: string;
  input: Json;
  title: string;
}

/**
 * Droid tool names/inputs to the OpenCode vocabulary OpenChamber's renderers
 * know (bash, read, edit, write, ...). Unknown tools pass through unchanged,
 * and the original input fields are always kept alongside the mapped ones.
 */
export function mapTool(name: string, input: Json): MappedTool {
  const path = str(input.file_path) ?? str(input.path) ?? str(input.filePath);
  switch (name) {
    case "Execute": {
      const command = str(input.command) ?? "";
      const description = str(input.summary) ?? str(input.description);
      return {
        tool: "bash",
        input: { ...input, command, ...(description !== undefined ? { description } : {}) },
        title: shorten(description ?? command),
      };
    }
    case "Read":
      return { tool: "read", input: { ...input, ...(path !== undefined ? { filePath: path } : {}) }, title: path ?? "read" };
    case "Create":
      return { tool: "write", input: { ...input, ...(path !== undefined ? { filePath: path } : {}) }, title: path ?? "write" };
    case "Edit": {
      const mapped: Json = { ...input, ...(path !== undefined ? { filePath: path } : {}) };
      if (typeof input.old_str === "string") mapped.oldString = input.old_str;
      if (typeof input.new_str === "string") mapped.newString = input.new_str;
      if (typeof input.change_all === "boolean") mapped.replaceAll = input.change_all;
      return { tool: "edit", input: mapped, title: path ?? "edit" };
    }
    case "Grep":
      return { tool: "grep", input: { ...input }, title: shorten(str(input.pattern) ?? "grep") };
    case "Glob": {
      const patterns = input.patterns;
      const pattern = Array.isArray(patterns) ? patterns.filter((p) => typeof p === "string").join(", ") : str(patterns);
      return { tool: "glob", input: { ...input, ...(pattern !== undefined ? { pattern } : {}) }, title: shorten(pattern ?? "glob") };
    }
    case "LS":
      return { tool: "list", input: { ...input, ...(str(input.directory_path) !== undefined ? { path: input.directory_path } : {}) }, title: str(input.directory_path) ?? "list" };
    case "FetchUrl":
      return { tool: "webfetch", input: { ...input }, title: shorten(str(input.url) ?? "webfetch") };
    case "WebSearch":
      return { tool: "websearch", input: { ...input }, title: shorten(str(input.query) ?? "websearch") };
    case "Task":
      return { tool: "task", input: { ...input }, title: shorten(str(input.description) ?? "task") };
    case "TodoWrite": {
      const todos = parseTodos(input.todos);
      if (todos === undefined) return { tool: "todowrite", input: { ...input }, title: "todowrite" };
      const done = todos.filter((t) => t.status === "completed").length;
      return { tool: "todowrite", input: { ...input, todos }, title: `${done}/${todos.length} done` };
    }
    case "AskUser": {
      const questions = questionsOf(input);
      return { tool: "question", input: { ...input, questions }, title: `Asked ${questions.length} question${questions.length === 1 ? "" : "s"}` };
    }
    case "ExitSpecMode":
      return { tool: "plan_exit", input: { ...input }, title: str(input.title) ?? "plan" };
    case "Script":
      return { tool: "script", input: { ...input }, title: "script" };
    default:
      return { tool: name.toLowerCase(), input: { ...input }, title: name };
  }
}

/**
 * The `Script` call a nested tool call belongs to. The live SDK stream uses
 * `scriptExecution.outerToolUseId`; Droid's session files store the same fact
 * as `script_execution.outer_tool_use_id`.
 */
export function outerScriptId(block: Json): string | undefined {
  const live = (block.scriptExecution as Json | undefined)?.outerToolUseId;
  if (typeof live === "string") return live;
  const stored = (block.script_execution as Json | undefined)?.outer_tool_use_id;
  return typeof stored === "string" ? stored : undefined;
}

/** tool_result content (string or content blocks) to plain text. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .join("");
}

/** Images and documents on a stored user message, as the data URLs OpenChamber shows. */
function userAttachments(blocks: Json[]): Array<{ mime: string; filename?: string; url: string }> {
  const out: Array<{ mime: string; filename?: string; url: string }> = [];
  for (const b of blocks) {
    const src = b.source as Json | undefined;
    if (src === undefined) continue;
    // Large documents are stored as a file next to the session, with an empty `data`.
    const stored = typeof src.data !== "string" || src.data === "" ? (typeof src.path === "string" ? readStoredFile(src.path) : undefined) : undefined;
    const data = stored !== undefined ? stored.toString("base64") : src.data;
    if (typeof data !== "string" || data === "") continue;
    const mime = str(src.media_type) ?? str(src.mediaType);
    if (b.type === "image" && mime !== undefined) {
      out.push({ mime, url: dataUrl(mime, data) });
    } else if (b.type === "document") {
      const name = str(src.name);
      const isText = src.type === "text";
      const type = isText ? "text/plain" : (mime ?? "application/pdf");
      out.push({ mime: type, ...(name !== undefined ? { filename: name } : {}), url: dataUrl(type, isText ? Buffer.from(data, "utf8").toString("base64") : data) });
    }
  }
  return out;
}

export const COMPACTED_FALLBACK_TEXT = "Session compacted";
export const COMPACT_TOOL = "compact";

/**
 * The summary as a tool part rather than a text part: OpenChamber renders text
 * of a summary message as ordinary model output (unless the user has activity
 * text enabled), whereas a tool part is always a collapsible card.
 */
export function compactionToolPart(o: { id: string; sessionID: string; messageID: string; start: number }): OCToolPart {
  return {
    id: o.id,
    sessionID: o.sessionID,
    messageID: o.messageID,
    type: "tool",
    callID: o.id,
    tool: COMPACT_TOOL,
    state: { status: "running", input: {}, title: "Compacting context", time: { start: o.start } },
  };
}

export function completeCompactionPart(part: OCToolPart, text: string, end: number): void {
  part.state = {
    status: "completed",
    input: {},
    output: text,
    title: COMPACTED_FALLBACK_TEXT,
    metadata: {},
    time: { start: part.state.status === "pending" ? end : part.state.time.start, end },
  };
}

export interface CompactionMessageOptions {
  sessionID: string;
  directory: string;
  agentName: string;
  model: OCModelRef;
  userId: string;
  summaryId: string;
  userPartId: string;
  created: number;
  /** Droid compacted on its own rather than at the user's request. */
  auto?: boolean;
}

/**
 * OpenCode's shape for a compaction: a user message carrying a `compaction`
 * part (OpenChamber shows it as /compact) answered by an assistant message
 * flagged `summary` whose text is the summary. The caller adds that text part.
 */
export function compactionMessages(o: CompactionMessageOptions): { user: OCMessageWithParts; summary: OCMessageWithParts } {
  const user: OCUserMessage = {
    id: o.userId,
    sessionID: o.sessionID,
    role: "user",
    time: { created: o.created },
    agent: o.agentName,
    model: o.model,
  };
  const summary: OCAssistantMessage = {
    id: o.summaryId,
    sessionID: o.sessionID,
    role: "assistant",
    time: { created: o.created },
    parentID: o.userId,
    modelID: o.model.modelID,
    providerID: o.model.providerID,
    mode: "compaction",
    path: { cwd: o.directory, root: o.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: true,
  };
  return {
    user: { info: user, parts: [{ id: o.userPartId, sessionID: o.sessionID, messageID: o.userId, type: "compaction", auto: o.auto === true }] },
    summary: { info: summary, parts: [] },
  };
}

/** Text of the newest `compaction_state` record in a Droid session file. */
export function latestCompactionSummary(path: string): { id: string; text: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.includes('"compaction_state"')) continue;
    try {
      const e = JSON.parse(line) as FileEntry;
      if (e.type === "compaction_state" && typeof e.id === "string") return { id: e.id, text: typeof e.summaryText === "string" ? e.summaryText : "" };
    } catch {
      /* torn trailing write */
    }
  }
  return undefined;
}

interface FileEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  summaryText?: string;
  message?: {
    role?: string;
    content?: Array<Json> | string;
    modelId?: string;
  };
}

function entryTime(e: FileEntry): number {
  const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function safeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * Rebuild OpenCode messages from a Droid session file. One assistant message
 * per user turn, matching how the live bridge groups a turn. Part ids are
 * deterministic so a re-parse reconciles in the UI instead of duplicating.
 * Never throws: unreadable or corrupt input degrades to [].
 */
export function parseDroidSessionFile(
  path: string,
  sessionID: string,
  directory: string,
  agentName: string,
  fallbackModel: OCModelRef,
  providerID: string,
): OCMessageWithParts[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const out: OCMessageWithParts[] = [];
  const toolParts = new Map<string, OCToolPart>();
  /** Script wrapper tool_use id to the ids of calls nested inside it. */
  const scriptNested = new Map<string, number>();
  const nestedParts = new Map<string, OCToolPart[]>();
  const seenCompactions = new Set<string>();
  let lastUserId = "";
  let current: { info: OCAssistantMessage; parts: OCPart[] } | undefined;
  let model = fallbackModel;

  for (const line of raw.split("\n")) {
    if (line === "") continue;
    let e: FileEntry;
    try {
      e = JSON.parse(line) as FileEntry;
    } catch {
      continue; // torn trailing write
    }
    if (e.type === "compaction_state" && typeof e.id === "string" && !seenCompactions.has(e.id)) {
      seenCompactions.add(e.id);
      const when = entryTime(e);
      const key = safeId(e.id);
      const { user, summary } = compactionMessages({
        sessionID,
        directory,
        agentName,
        model,
        userId: `msg_compaction_${key}`,
        summaryId: `msg_compaction_${key}_summary`,
        userPartId: `prt_compaction_${key}`,
        created: when,
      });
      const text = typeof e.summaryText === "string" && e.summaryText.trim() !== "" ? e.summaryText : COMPACTED_FALLBACK_TEXT;
      const summaryInfo = summary.info as OCAssistantMessage;
      summaryInfo.time.completed = when;
      summaryInfo.finish = "stop";
      const card = compactionToolPart({ id: `prt_compaction_${key}_summary`, sessionID, messageID: summary.info.id, start: when });
      completeCompactionPart(card, text, when);
      summary.parts.push(card);
      out.push(user, summary);
      lastUserId = user.info.id;
      current = undefined;
      continue;
    }
    if (e.type !== "message" || e.message === undefined || typeof e.id !== "string") continue;
    const m = e.message;
    const when = entryTime(e);
    const blocks: Json[] = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];

    if (m.role === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const part = typeof b.tool_use_id === "string" ? toolParts.get(b.tool_use_id) : undefined;
        if (part === undefined) continue;
        const text = resultText(b.content);
        const start = part.state.status !== "pending" ? part.state.time.start : when;
        part.state =
          b.is_error === true
            ? { status: "error", input: part.state.input, error: text !== "" ? text : `tool ${part.tool} failed`, time: { start, end: when } }
            : { status: "completed", input: part.state.input, output: text, title: part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool, metadata: toolMetadata(part.tool, text), time: { start, end: when } };
      }
      if (blocks.some((b) => b.type === "tool_result")) continue;
      // injected context and Droid's own notices (e.g. "history has been compacted"), not something the user typed
      if (e.id.startsWith("context-") || e.id.startsWith("__internal__")) continue;
      // Droid adds its own <system-reminder> blocks (e.g. local paths of attached images) next to what the user typed.
      const typed = parseAttachmentNote(
        blocks
          .map((b) => (b.type === "text" && typeof b.text === "string" && !b.text.trimStart().startsWith("<system-reminder>") ? b.text : ""))
          .join(""),
      );
      const text = typed.text.trim();
      const attachments = [...userAttachments(blocks), ...typed.saved];
      if (text === "" && attachments.length === 0) continue;
      const info: OCUserMessage = {
        id: `msg_${safeId(e.id)}`,
        sessionID,
        role: "user",
        time: { created: when },
        agent: agentName,
        model,
      };
      lastUserId = info.id;
      current = undefined;
      const uid = safeId(e.id);
      out.push({
        info,
        parts: [
          ...(text !== "" ? [{ id: `prt_${uid}_0`, sessionID, messageID: info.id, type: "text" as const, text, time: { start: when, end: when } }] : []),
          ...attachments.map((a, i): OCPart => ({ id: `prt_${uid}_f${i}`, sessionID, messageID: info.id, type: "file", mime: a.mime, ...(a.filename !== undefined ? { filename: a.filename } : {}), url: a.url })),
        ],
      });
      continue;
    }

    if (m.role !== "assistant") continue;
    if (typeof m.modelId === "string" && m.modelId !== "") model = { providerID, modelID: m.modelId };
    if (current === undefined) {
      const info: OCAssistantMessage = {
        id: `msg_${safeId(e.id)}`,
        sessionID,
        role: "assistant",
        time: { created: when, completed: when },
        parentID: lastUserId,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: agentName,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      };
      current = { info, parts: [] };
      out.push(current);
    }
    current.info.time.completed = when;
    blocks.forEach((b, i) => {
      const partId = `prt_${safeId(e.id as string)}_${i}`;
      const base = { id: partId, sessionID, messageID: current!.info.id };
      if (b.type === "text" && typeof b.text === "string" && b.text !== "") {
        current!.parts.push({ ...base, type: "text", text: b.text, time: { start: when, end: when } });
      } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking !== "") {
        current!.parts.push({ ...base, type: "reasoning", text: b.thinking, time: { start: when, end: when } });
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        const outer = outerScriptId(b);
        if (outer !== undefined) scriptNested.set(outer, (scriptNested.get(outer) ?? 0) + 1);
        const mapped = mapTool(b.name, (b.input ?? {}) as Json);
        const part: OCToolPart = {
          ...base,
          type: "tool",
          callID: b.id,
          tool: mapped.tool,
          state: { status: "running", input: mapped.input, title: mapped.title, time: { start: when } },
        };
        toolParts.set(b.id, part);
        current!.parts.push(part);
        if (outer !== undefined) nestedParts.set(outer, [...(nestedParts.get(outer) ?? []), part]);
      }
    });
  }

  for (const [scriptId, nested] of scriptNested) {
    const wrapper = toolParts.get(scriptId);
    if (wrapper === undefined || wrapper.state.status === "error") continue;
    const owner = out.find((o) => o.parts.includes(wrapper));
    if (owner !== undefined && nested > 0) owner.parts = owner.parts.filter((p) => p !== wrapper);
  }
  // A wrapper that stays (it failed) is shown after the calls it made, as it is live.
  for (const [scriptId, parts] of nestedParts) {
    const wrapper = toolParts.get(scriptId);
    const owner = wrapper === undefined ? undefined : out.find((o) => o.parts.includes(wrapper));
    if (wrapper === undefined || owner === undefined) continue;
    const without = owner.parts.filter((p) => p !== wrapper);
    const last = Math.max(...parts.map((p) => without.indexOf(p)));
    if (last >= 0) owner.parts = [...without.slice(0, last + 1), wrapper, ...without.slice(last + 1)];
  }
  for (const part of toolParts.values()) {
    if (part.state.status !== "running") continue;
    part.state = { status: "error", input: part.state.input, error: "no result was recorded for this call", time: { start: part.state.time.start, end: part.state.time.start } };
  }
  return out;
}
