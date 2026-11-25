/**
 * Plugin tool smoke test, against a real Droid.
 *
 * OpenChamber hands its tools over as an OpenCode plugin file named in
 * OPENCODE_CONFIG_CONTENT. A stand-in plugin with the same shape (JSON-schema
 * args, a callback to OPENCHAMBER_AGENT_TOOL_URL with a bearer token) is
 * loaded, and Droid must be able to call it, with the session's directory
 * passed as the call context.
 *
 *   npm run plugin-smoke
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocdroid-plugin-"));
const pluginFile = join(WORKSPACE, "plugin.mjs");
writeFileSync(
  pluginFile,
  `export const TestPlugin = async () => ({
  tool: {
    openchamber: {
      description: "Control the test app. Use one action per call.",
      args: {
        action: { type: "string", oneOf: [{ const: "projects.list", description: "List projects" }, { const: "session.status", description: "Status of sessionId" }], description: "Action to perform" },
        parameters: { type: "object", properties: { sessionId: { type: "string" }, limit: { type: "integer", minimum: 1 } }, additionalProperties: false, description: "Inputs for the action; use an empty object when none are needed" },
      },
      async execute(input, context) {
        context.metadata({ title: input.action });
        const response = await fetch(process.env.OPENCHAMBER_AGENT_TOOL_URL, {
          method: "POST",
          headers: { authorization: "Bearer " + process.env.OPENCHAMBER_AGENT_TOOL_TOKEN, "content-type": "application/json" },
          body: JSON.stringify({ input, contextDirectory: context.directory, tool: "openchamber" }),
          signal: context.abort,
        });
        return { title: input.action, output: await response.text(), metadata: {} };
      },
    },
  },
});
`,
);

const calls: Array<{ auth: string | undefined; body: { input?: { action?: string }; contextDirectory?: string; tool?: string } }> = [];
const callback = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw) as (typeof calls)[number]["body"];
    calls.push({ auth: req.headers.authorization, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ schemaVersion: 1, ok: true, action: body.input?.action, projects: [{ id: "p1", name: "plugin-smoke-project" }] }));
  });
});
await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
const port = (callback.address() as { port: number }).port;

process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: [pathToFileURL(pluginFile).href] });
process.env.OPENCHAMBER_AGENT_TOOL_URL = `http://127.0.0.1:${port}/api/openchamber/agent-tool`;
process.env.OPENCHAMBER_AGENT_TOOL_TOKEN = "plugin-smoke-token";
process.env.OCDROID_STATE_DIR = mkdtempSync(join(tmpdir(), "ocdroid-state-"));

const { AdapterServer } = await import("../src/server.js");
const { SseCollector, api } = await import("./util.js");
import type { OCMessageWithParts, OCSession, OCToolPart } from "../src/types.js";

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();
  const idleCount = (): number => sse.all.filter((e) => e.type === "session.idle").length;

  const created = await api<OCSession>(url, "/session", { method: "POST", body: "{}" });
  const sid = created.body.id;

  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "Call the openchamber tool once with action projects.list and an empty parameters object. Then reply with the project name it returned, nothing else." }] }),
  });
  // Plugin tools may change things, so Droid asks first; approve like a user would.
  const asked = await sse.waitFor((e) => e.type === "permission.asked", 120_000, "permission.asked");
  const request = (asked as { properties: { id: string; permission: string } }).properties;
  ok("plugin tool call asks for permission as an MCP tool", request.permission === "mcp", request.permission);
  await api(url, `/permission/${request.id}/reply`, { method: "POST", body: JSON.stringify({ reply: "once" }) });
  await sse.waitFor(() => idleCount() > 0, 180_000, "idle");

  ok("plugin callback was reached", calls.length === 1, String(calls.length));
  ok("callback carries the bearer token", calls[0]?.auth === "Bearer plugin-smoke-token");
  ok("callback carries the action", calls[0]?.body.input?.action === "projects.list", JSON.stringify(calls[0]?.body));
  ok("callback carries the session directory", calls[0]?.body.contextDirectory === WORKSPACE, calls[0]?.body.contextDirectory);

  const msgs = (await api<OCMessageWithParts[]>(url, `/session/${sid}/message`)).body;
  const part = msgs.flatMap((m) => m.parts).find((p): p is OCToolPart => p.type === "tool" && p.tool === "openchamber");
  ok("tool part is named openchamber", part !== undefined, JSON.stringify(msgs.flatMap((m) => m.parts.map((p) => (p.type === "tool" ? p.tool : p.type)))));
  ok("tool part completed with the plugin's JSON", part?.state.status === "completed" && part.state.output.includes("plugin-smoke-project"));
  const answer = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ");
  ok("Droid saw the result", answer.includes("plugin-smoke-project"), answer.slice(-200));

  await api(url, `/session/${sid}`, { method: "DELETE" });
  sse.stop();
  await server.stop();
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("smoke crashed:", err);
} finally {
  callback.close();
  rmSync(WORKSPACE, { recursive: true, force: true });
}
console.log(failures === 0 ? `\nALL PASS: ${checks}/${checks} checks passed` : `\nFAILURES: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
