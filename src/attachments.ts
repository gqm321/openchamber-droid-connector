import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Base64ImageSource, DocumentSource } from "@factory/droid-sdk/node";

/** A `file` part of an OpenCode prompt: OpenChamber sends attachments as data URLs. */
export interface Attachment {
  mime: string;
  filename?: string;
  url: string;
}

export interface PreparedAttachments {
  images: Base64ImageSource[];
  files: DocumentSource[];
  /** Appended to the prompt for attachments Droid cannot take natively. */
  note: string;
}

const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Map<string, Base64ImageSource["mediaType"]>([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
]);

/** Marks the paragraph listing attachments that could not be passed natively, so history can hide it again. */
export const SAVED_NOTE_MARKER = "[Attached files and links:";

export function attachmentsOf(parts: Array<{ type: string; [key: string]: unknown }> | undefined): Attachment[] {
  const out: Attachment[] = [];
  for (const p of parts ?? []) {
    if (p.type !== "file" || typeof p.url !== "string" || p.url === "") continue;
    out.push({
      mime: typeof p.mime === "string" && p.mime !== "" ? p.mime : "application/octet-stream",
      ...(typeof p.filename === "string" && p.filename !== "" ? { filename: p.filename } : {}),
      url: p.url,
    });
  }
  return out;
}

function decodeDataUrl(url: string): { mime: string; bytes: Buffer } | undefined {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (m === null) return undefined;
  const base64 = (m[2] ?? "").split(";").includes("base64");
  try {
    const bytes = base64 ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8");
    return { mime: m[1] ?? "", bytes };
  } catch {
    return undefined;
  }
}

function readSource(att: Attachment): { mime: string; bytes: Buffer } | string {
  if (att.url.startsWith("data:")) {
    const decoded = decodeDataUrl(att.url);
    if (decoded === undefined) return "not a valid data URL";
    return { mime: decoded.mime !== "" ? decoded.mime : att.mime, bytes: decoded.bytes };
  }
  if (att.url.startsWith("file:")) {
    try {
      const path = fileURLToPath(att.url);
      if (statSync(path).size > MAX_BYTES) return "file is too large";
      return { mime: att.mime, bytes: readFileSync(path) };
    } catch {
      return "file could not be read";
    }
  }
  return "unsupported URL";
}

function asText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString("utf8");
  return text.includes("\uFFFD") ? undefined : text;
}

function saveLocally(name: string, bytes: Buffer): string {
  const dir = join(tmpdir(), "ocdroid-attachments", randomUUID());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, basename(name) || "attachment");
  writeFileSync(path, bytes);
  return path;
}

/** Sort prompt attachments into what Droid accepts: images, PDFs and text documents; the rest is saved to disk. */
export function prepareAttachments(attachments: Attachment[]): PreparedAttachments {
  const images: Base64ImageSource[] = [];
  const files: DocumentSource[] = [];
  const notes: string[] = [];
  for (const att of attachments) {
    const name = att.filename ?? "attachment";
    if (/^https?:/.test(att.url)) {
      notes.push(`- ${name}: ${att.url}`);
      continue;
    }
    const source = readSource(att);
    if (typeof source === "string") {
      notes.push(`- ${name}: could not be attached (${source})`);
      continue;
    }
    if (source.bytes.length > MAX_BYTES) {
      notes.push(`- ${name}: could not be attached (file is too large)`);
      continue;
    }
    const mime = source.mime.toLowerCase();
    const imageType = IMAGE_TYPES.get(mime);
    if (imageType !== undefined) {
      images.push({ type: "base64", mediaType: imageType, data: source.bytes.toString("base64") });
    } else if (mime === "application/pdf") {
      files.push({ type: "base64", mediaType: "application/pdf", data: source.bytes.toString("base64"), name });
    } else {
      const text = asText(source.bytes);
      if (text !== undefined) {
        files.push({ type: "text", mediaType: "text/plain", data: text, name });
      } else {
        notes.push(`- ${saveLocally(name, source.bytes)} (${mime || "unknown type"})`);
      }
    }
  }
  const saved = notes.length === 0 ? "" : `\n\n${SAVED_NOTE_MARKER}\n${notes.join("\n")}]`;
  return { images, files, note: saved };
}

/**
 * Splits a stored prompt into what the user typed and the attachments listed in
 * the note `prepareAttachments` appended (files saved to disk).
 */
export function parseAttachmentNote(text: string): { text: string; saved: Attachment[] } {
  const at = text.lastIndexOf(`\n\n${SAVED_NOTE_MARKER}`);
  if (at < 0) return { text, saved: [] };
  const saved: Attachment[] = [];
  for (const line of text.slice(at).split("\n")) {
    const m = /^- (\/.+) \(([^()]*)\)\]?$/.exec(line.trim());
    if (m !== null) saved.push({ mime: m[2] === "unknown type" ? "application/octet-stream" : m[2]!, filename: basename(m[1]!), url: pathToFileURL(m[1]!).href });
  }
  return { text: text.slice(0, at), saved };
}

/** Largest stored attachment read back from disk when showing history. */
export function readStoredFile(path: string): Buffer | undefined {
  try {
    return statSync(path).size > MAX_BYTES ? undefined : readFileSync(path);
  } catch {
    return undefined;
  }
}

export function dataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}
