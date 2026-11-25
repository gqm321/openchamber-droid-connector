/**
 * OpenCode plugin tools, exposed to Droid as an MCP server.
 *
 * OpenChamber adds its own tools (`openchamber`, `openchamber_web`) by putting
 * a plugin into OPENCODE_CONFIG_CONTENT. The plugin is plain JavaScript that
 * answers `tool` hooks, so it is loaded here in-process and each tool is
 * served to Droid over an SDK MCP server. A server is built per session
 * because a tool call must know which session (and directory) it belongs to,
 * and MCP handlers only receive the call's arguments.
 */

import { pathToFileURL } from "node:url";
import { createSdkMcpServer, tool, type DroidTool, type SdkMcpServer } from "@factory/droid-sdk/node";
import { z } from "zod";
import { PLUGIN_TOOL_PREFIX } from "./droid-map.js";

type Json = Record<string, unknown>;

export interface PluginToolContext {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata: (input: unknown) => void;
  ask: () => Promise<void>;
}

export interface PluginTool {
  name: string;
  description: string;
  /** Plain JSON-schema properties, or zod types when a plugin uses OpenCode's `tool.schema`. */
  args: Record<string, unknown>;
  execute: (input: Json, context: PluginToolContext) => unknown;
}

let loaded: Promise<PluginTool[]> | undefined;

/** Plugin tools named by OPENCODE_CONFIG_CONTENT; loaded once per process. */
export function loadPluginTools(directory: string): Promise<PluginTool[]> {
  loaded ??= loadAll(directory);
  return loaded;
}

async function loadAll(directory: string): Promise<PluginTool[]> {
  if (process.env.OCDROID_PLUGINS?.trim() === "0") return [];
  const out = new Map<string, PluginTool>();
  for (const url of pluginUrls()) {
    try {
      const mod = (await import(url)) as Json;
      const factories = new Set(Object.values(mod).filter((v): v is (input: unknown) => unknown => typeof v === "function"));
      for (const factory of factories) {
        const hooks = (await factory({
          directory,
          worktree: directory,
          project: { id: "global", worktree: directory },
          serverUrl: new URL("http://127.0.0.1"),
        })) as { tool?: Record<string, Partial<PluginTool>> } | undefined;
        for (const [name, def] of Object.entries(hooks?.tool ?? {})) {
          if (typeof def.execute !== "function") continue;
          out.set(name, { name, description: def.description ?? name, args: def.args ?? {}, execute: def.execute });
        }
      }
    } catch (err) {
      console.error(`[plugins] could not load ${url}:`, err instanceof Error ? err.message : err);
    }
  }
  if (out.size > 0) console.error(`[plugins] tools: ${[...out.keys()].join(", ")}`);
  return [...out.values()];
}

/** Local plugin files only; npm package specifiers need OpenCode's installer. */
function pluginUrls(): string[] {
  let config: { plugin?: unknown };
  try {
    config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as { plugin?: unknown };
  } catch {
    return [];
  }
  const urls: string[] = [];
  for (const entry of Array.isArray(config.plugin) ? (config.plugin as unknown[]) : []) {
    const spec = Array.isArray(entry) ? entry[0] : entry;
    if (typeof spec !== "string") continue;
    if (spec.startsWith("file://")) urls.push(spec);
    else if (spec.startsWith("/")) urls.push(pathToFileURL(spec).href);
    else console.error(`[plugins] skipping "${spec}": only local plugin files are supported`);
  }
  return urls;
}

export interface PluginBinding {
  sessionID: () => string;
  directory: string;
  messageID: () => string;
  agent: () => string;
  /** Aborted when the user stops the running turn. */
  signal: () => AbortSignal;
}

/** One MCP server serving every plugin tool for a single session; undefined when there are none. */
export function buildPluginServer(tools: PluginTool[], bind: PluginBinding): SdkMcpServer | undefined {
  if (tools.length === 0) return undefined;
  const served: DroidTool[] = tools.map((t) =>
    tool(t.name, t.description, shapeOf(t.args), async (input) => {
      const result = await t.execute(input as Json, {
        sessionID: bind.sessionID(),
        messageID: bind.messageID(),
        agent: bind.agent(),
        directory: bind.directory,
        worktree: bind.directory,
        abort: bind.signal(),
        metadata: () => undefined,
        ask: async () => undefined,
      });
      return outputOf(result);
    }),
  );
  return createSdkMcpServer({ name: PLUGIN_TOOL_PREFIX.replace(/_+$/, ""), tools: served });
}

function outputOf(result: unknown): string {
  if (typeof result === "string") return result;
  const output = (result as { output?: unknown } | null)?.output;
  return typeof output === "string" ? output : JSON.stringify(result ?? "");
}

function shapeOf(args: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, def] of Object.entries(args)) shape[name] = isZod(def) ? def : fromJsonSchema(def);
  return shape;
}

function isZod(value: unknown): value is z.ZodTypeAny {
  return typeof value === "object" && value !== null && "_def" in value && typeof (value as { parse?: unknown }).parse === "function";
}

/** The subset of JSON Schema the plugins in use emit: scalars, enums, `oneOf` of consts, arrays and objects. */
export function fromJsonSchema(schema: unknown): z.ZodTypeAny {
  if (typeof schema !== "object" || schema === null) return z.unknown();
  const s = schema as Json;
  const described = (t: z.ZodTypeAny): z.ZodTypeAny => (typeof s.description === "string" ? t.describe(s.description) : t);

  const options = Array.isArray(s.oneOf) ? (s.oneOf as Json[]) : Array.isArray(s.anyOf) ? (s.anyOf as Json[]) : undefined;
  if (options !== undefined && options.length > 0 && options.every((o) => typeof o === "object" && o !== null && "const" in o)) {
    const values = options.map((o) => String(o.const));
    const notes = options.map((o) => (typeof o.description === "string" ? `${String(o.const)}: ${o.description}` : String(o.const)));
    const header = typeof s.description === "string" ? `${s.description}\n` : "";
    return z.enum(values as [string, ...string[]]).describe(`${header}${notes.join("\n")}`);
  }
  if (Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every((v) => typeof v === "string")) {
    return described(z.enum(s.enum as [string, ...string[]]));
  }
  switch (s.type) {
    case "string":
      return described(z.string());
    case "boolean":
      return described(z.boolean());
    case "integer":
    case "number": {
      let n = s.type === "integer" ? z.number().int() : z.number();
      if (typeof s.minimum === "number") n = n.min(s.minimum);
      if (typeof s.maximum === "number") n = n.max(s.maximum);
      return described(n);
    }
    case "array":
      return described(z.array(fromJsonSchema(s.items)));
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(props)) shape[key] = required.has(key) ? fromJsonSchema(value) : fromJsonSchema(value).optional();
      const obj = z.object(shape);
      return described(s.additionalProperties === false ? obj.strict() : obj.passthrough());
    }
    default:
      return described(z.unknown());
  }
}
