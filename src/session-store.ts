/**
 * Durable session registry + Droid session-file discovery.
 *
 * Droid already persists every session as JSONL under
 * `~/.factory/sessions/<cwd with / replaced by ->/<sessionId>.jsonl` (first
 * line: a `session_start` record with id, title and cwd), so the adapter never
 * needs its own transcript store. It keeps only:
 *
 *   1. a scan of that directory to rebuild the sidebar after a restart, and
 *   2. a small registry JSON for adapter-owned metadata Droid does not keep
 *      (the archive flag, the last model chosen from the UI).
 *
 * OpenChamber session ids are derived from the Droid session id (`ses_` + the
 * UUID without hyphens), so they are stable across restarts and reversible.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ocIdFor(droidSessionId: string): string {
  return `ses_${droidSessionId.replaceAll("-", "")}`;
}

/** Inverse of {@link ocIdFor}; undefined when the id is not one of ours. */
export function droidIdFor(ocSessionId: string): string | undefined {
  const m = /^ses_([0-9a-f]{32})$/i.exec(ocSessionId);
  if (m === null) return undefined;
  const h = m[1]!.toLowerCase();
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return UUID_RE.test(id) ? id : undefined;
}

export function droidSessionsRoot(): string {
  return join(homedir(), ".factory", "sessions");
}

/** Droid's per-cwd session directory name. */
export function droidSessionDirName(cwd: string): string {
  return cwd.replaceAll("/", "-").replaceAll("\\", "-").replaceAll(":", "-");
}

/** One session discovered on disk, not (yet) backed by a live droid process. */
export interface ScannedSession {
  droidSessionId: string;
  path: string;
  directory: string;
  title: string;
  created: number;
  updated: number;
}

/** Adapter-owned metadata that Droid's files do not carry. */
export interface SessionRegistryEntry {
  droidSessionId: string;
  directory: string;
  title?: string;
  /** Archive timestamp (absent/0 = live), OpenChamber's archive toggle. */
  archived?: number;
  metadata?: Record<string, unknown>;
  model?: { providerID: string; modelID: string };
  created: number;
  updated: number;
}

const HEAD_BYTES = 16 * 1024;

function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, Math.max(statSync(path).size, 1)));
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

interface SessionStartRecord {
  type?: string;
  id?: unknown;
  title?: unknown;
  cwd?: unknown;
  decompSessionType?: unknown;
}

export function scanSessionFile(path: string): ScannedSession | undefined {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const droidSessionId = fileName.slice(0, -".jsonl".length);
  if (!UUID_RE.test(droidSessionId)) return undefined;
  let rec: SessionStartRecord;
  try {
    rec = JSON.parse(readHead(path).split("\n", 1)[0] ?? "") as SessionStartRecord;
  } catch {
    return undefined;
  }
  if (rec.type !== "session_start" || typeof rec.cwd !== "string" || rec.cwd === "") return undefined;
  // Mission/worker sessions are Droid internals, not user conversations.
  if (rec.decompSessionType !== undefined && rec.decompSessionType !== null) return undefined;
  const st = statSync(path);
  return {
    droidSessionId,
    path,
    directory: rec.cwd,
    title: typeof rec.title === "string" && rec.title !== "" ? rec.title : `Droid session ${droidSessionId.slice(0, 8)}`,
    created: Math.floor(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs),
    updated: Math.floor(st.mtimeMs),
  };
}

function scanDir(dir: string): ScannedSession[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ScannedSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const s = scanSessionFile(join(dir, name));
      if (s !== undefined) out.push(s);
    } catch {
      /* unreadable file: skip it, never take the server down */
    }
  }
  return out;
}

/** Sessions Droid recorded for `directory`. The header cwd is authoritative. */
export function scanDroidSessions(directory: string): ScannedSession[] {
  return scanDir(join(droidSessionsRoot(), droidSessionDirName(directory)))
    .filter((s) => s.directory === directory)
    .sort((a, b) => b.updated - a.updated);
}

/** Every session on disk, regardless of directory. */
export function scanAllDroidSessions(): ScannedSession[] {
  const root = droidSessionsRoot();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  return dirs.flatMap((d) => scanDir(join(root, d))).sort((a, b) => b.updated - a.updated);
}

/** Newest mtime across the sessions root and its subdirectories (scan cache key). */
export function droidSessionsMtime(directory?: string): number | undefined {
  const root = droidSessionsRoot();
  try {
    if (directory !== undefined) return statSync(join(root, droidSessionDirName(directory))).mtimeMs;
    let newest = statSync(root).mtimeMs;
    for (const name of readdirSync(root)) {
      try {
        newest = Math.max(newest, statSync(join(root, name)).mtimeMs);
      } catch {
        /* vanished mid-scan */
      }
    }
    return newest;
  } catch {
    return undefined;
  }
}

/** Locate a session's JSONL: the expected per-cwd path first, then a full scan. */
export function findSessionFile(droidSessionId: string, directory?: string): string | undefined {
  const root = droidSessionsRoot();
  const file = `${droidSessionId}.jsonl`;
  if (directory !== undefined) {
    const direct = join(root, droidSessionDirName(directory), file);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, file);
      if (existsSync(p)) return p;
    }
  } catch {
    /* no sessions dir yet */
  }
  return undefined;
}

/** Size of the last model call Droid recorded for a session, i.e. its current context. */
export interface LastCallUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export function readLastCallUsage(sessionFile: string): LastCallUsage | undefined {
  try {
    const settings = JSON.parse(readFileSync(sessionFile.replace(/\.jsonl$/, ".settings.json"), "utf8")) as { lastCallTokenUsage?: Record<string, unknown> };
    return lastCallUsage(settings.lastCallTokenUsage);
  } catch {
    return undefined;
  }
}

/** Droid's `lastCallTokenUsage` object to our shape; all-zero means no call has completed yet. */
export function lastCallUsage(raw: unknown): LastCallUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage = { input: num(r.inputTokens), output: num(r.outputTokens), cacheRead: num(r.cacheReadTokens) };
  return usage.input + usage.output + usage.cacheRead > 0 ? usage : undefined;
}

/** Delete a Droid session's transcript, settings and their `.bak` copies. */
export function removeDroidSessionFiles(droidSessionId: string, directory?: string): void {
  const file = findSessionFile(droidSessionId, directory);
  if (file === undefined) return;
  for (const suffix of ["", ".bak"].flatMap((b) => [`.jsonl${b}`, `.settings.json${b}`])) {
    const p = file.replace(/\.jsonl$/, suffix);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Persistent oc-session-id to metadata registry. Atomic writes, lazy load; a
 * corrupt file degrades to an empty map.
 */
export class SessionStore {
  private readonly file: string;
  private entries: Map<string, SessionRegistryEntry> | undefined;

  constructor(stateDir?: string) {
    const dir = stateDir ?? process.env.OCDROID_STATE_DIR ?? join(homedir(), ".config", "openchamber-droid-connector");
    this.file = join(dir, "sessions.json");
  }

  private load(): Map<string, SessionRegistryEntry> {
    if (this.entries !== undefined) return this.entries;
    this.entries = new Map();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, SessionRegistryEntry>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.droidSessionId === "string" && typeof v.directory === "string") {
          if (v.model !== undefined && (typeof v.model.providerID !== "string" || typeof v.model.modelID !== "string")) {
            delete v.model;
          }
          this.entries.set(k, v);
        }
      }
    } catch {
      /* missing or corrupt: start empty */
    }
    return this.entries;
  }

  private persist(): void {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.load()), null, 2));
      renameSync(tmp, this.file);
    } catch {
      /* best-effort: the registry only holds cosmetic metadata */
    }
  }

  get(ocSessionId: string): SessionRegistryEntry | undefined {
    return this.load().get(ocSessionId);
  }

  set(ocSessionId: string, entry: SessionRegistryEntry): void {
    this.load().set(ocSessionId, entry);
    this.persist();
  }

  remove(ocSessionId: string): void {
    if (this.load().delete(ocSessionId)) this.persist();
  }

  directories(): string[] {
    return [...new Set([...this.load().values()].map((e) => e.directory))];
  }
}
