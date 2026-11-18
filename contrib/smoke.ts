/**
 * End-to-end smoke test for the Droid adapter — no OpenChamber required.
 *
 * Drives the adapter's OpenCode HTTP surface exactly the way OpenChamber
 * would (bootstrap probes → session create → tool-forcing prompt_async +
 * SSE → sync prompt → abort + reuse → rename → delete), with a real Droid
 * agent behind every prompt.
 *
 *   npm run smoke
 *   npm run smoke
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterServer } from "../src/server.js";
import { SseCollector, api } from "./util.js";
import type { OCEvent, OCSession, OCMessageWithParts } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocdroid-smoke-"));

let failures = 0;
let checks = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function promptBody(text: string): string {
  return JSON.stringify({ parts: [{ type: "text", text }] });
}

function textOf(m: OCMessageWithParts | undefined): string {
  if (!m) return "";
  return m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  console.log("— boot adapter —");
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();
  console.log(`adapter: ${url}`);

  // 1. bootstrap probes
  console.log("— bootstrap probes —");
  const health = await api<{ healthy: boolean }>(url, "/global/health");
  ok("GET /global/health", health.status === 200 && health.body.healthy === true);
  for (const probe of ["/provider", "/question", "/permission", "/lsp", "/formatter", "/experimental/session", "/path", "/vcs", "/agent", "/command", "/mcp", "/config", "/project", "/project/current"]) {
    const r = await api<unknown>(url, probe);
    ok(`GET ${probe}`, r.status === 200, `status ${r.status}`);
  }

  // 2. session create + tool-forcing prompt
  console.log("— session create + tool round (real droid run) —");
  const created = await api<OCSession>(url, "/session", { method: "POST", body: JSON.stringify({}) });
  ok("POST /session", created.status === 200 && typeof created.body.id === "string");
  const sessionId = created.body.id;
  await sse.waitFor((e) => e.type === "session.created", 5_000, "session.created");

  const asyncRes = await api<unknown>(url, `/session/${sessionId}/prompt_async`, {
    method: "POST",
    // OpenChamber sends a client-generated messageID (optimistic insert) —
    // the adapter must reuse it and echo the user part, or the UI renders
    // the message twice (verified against OpenChamber's event-reducer).
    body: JSON.stringify({ messageID: "msg_clientecho0001", parts: [{ type: "text", text: 'Use your bash tool to run exactly this command: echo tool-droid-smoke. Then reply with exactly: DROID-TOOLS-DONE' }] }),
  });
  ok("POST /prompt_async accepted", asyncRes.status === 204, `status ${asyncRes.status}`);

  const userPartEcho = await sse.waitFor(
    (e) =>
      e.type === "message.part.updated" &&
      (e.properties as { part?: { messageID?: string; type?: string } }).part?.messageID === "msg_clientecho0001" &&
      (e.properties as { part?: { type?: string } }).part?.type === "text",
    10_000,
    "user part echo",
  );
  ok("client messageID reused + user part echoed", true, JSON.stringify((userPartEcho.properties as { part: unknown }).part).slice(0, 120));

  const toolEv = await sse.waitFor(
    (e) => e.type === "message.part.updated" && (e.properties as { part?: { type?: string } }).part?.type === "tool",
    180_000,
    "streaming tool part",
  );
  ok("SSE streams a tool part", true, JSON.stringify((toolEv.properties as { part: unknown }).part).slice(0, 120));
  await sse.waitFor((e) => e.type === "session.idle" && (e.properties as { sessionID: string }).sessionID === sessionId, 240_000, "session.idle");
  ok("SSE session.idle after turn", true);

  const messages = await api<OCMessageWithParts[]>(url, `/session/${sessionId}/message`);
  const toolPart = (messages.body ?? []).flatMap((m) => m.parts).find((p) => p.type === "tool") as
    | { type: "tool"; tool: string; state: { status: string; input: Record<string, unknown>; output?: string } }
    | undefined;
  ok("message list contains a tool part", toolPart !== undefined);
  ok(
    "tool part is bash + completed (v2 ToolState)",
    toolPart !== undefined && toolPart.tool === "bash" && toolPart.state?.status === "completed",
    JSON.stringify(toolPart)?.slice(0, 240),
  );
  ok(
    "tool state.input carries the command",
    toolPart !== undefined && String(toolPart.state?.input?.command ?? "").includes("tool-droid-smoke"),
    JSON.stringify(toolPart?.state?.input),
  );
  ok(
    "tool state.output carries the stdout",
    toolPart !== undefined && (toolPart.state?.output ?? "").includes("tool-droid-smoke"),
    JSON.stringify(toolPart?.state?.output)?.slice(0, 160),
  );
  const assistants = (messages.body ?? []).filter((m) => m.info.role === "assistant");
  ok("assistant text answer after tools", assistants.some((m) => textOf(m).includes("DROID-TOOLS-DONE")), assistants.map(textOf).join(" | ").slice(0, 160));
  const userStored = (messages.body ?? []).find((m) => m.info.role === "user");
  ok("user message keeps the client messageID", userStored?.info.id === "msg_clientecho0001", userStored?.info.id);

  // 3. sync prompt
  const syncRes = await api<OCMessageWithParts>(url, `/session/${sessionId}/message`, { method: "POST", body: promptBody("Reply with exactly: DROID-SYNC-OK") });
  ok("POST /message (sync)", syncRes.status === 200 && textOf(syncRes.body).includes("DROID-SYNC-OK"), textOf(syncRes.body).slice(0, 120));

  // 4. abort mid-run, then prove the session is still usable
  console.log("— abort mid-run + reuse —");
  await api<unknown>(url, `/session/${sessionId}/prompt_async`, { method: "POST", body: promptBody("Write a very detailed 4000-word essay about the history of computing, starting from the abacus. Do not summarize.") });
  await sse.waitFor(
    (e) => e.type === "message.part.updated" && typeof (e.properties as { delta?: string }).delta === "string",
    180_000,
    "first delta of long run",
  );
  const abortRes = await api<unknown>(url, `/session/${sessionId}/abort`, { method: "POST" });
  ok("POST /abort", abortRes.status === 200);
  await sse.waitFor((e) => e.type === "session.idle" && (e.properties as { sessionID: string }).sessionID === sessionId, 60_000, "idle after abort");
  ok("idle after abort", true);

  const syncRes2 = await api<OCMessageWithParts>(url, `/session/${sessionId}/message`, { method: "POST", body: promptBody("Reply with exactly: DROID-AFTER-ABORT-OK") });
  ok("sync prompt after abort still works", syncRes2.status === 200 && textOf(syncRes2.body).includes("DROID-AFTER-ABORT-OK"), JSON.stringify(syncRes2.body).slice(0, 300));

  // 5. rename + delete
  const renamed = await api<OCSession>(url, `/session/${sessionId}`, { method: "PATCH", body: JSON.stringify({ title: "droid-smoke-renamed" }) });
  ok("PATCH rename", renamed.status === 200 && renamed.body.title === "droid-smoke-renamed");
  const del = await api<unknown>(url, `/session/${sessionId}`, { method: "DELETE" });
  ok("DELETE session", del.status === 200);
  const listedAfter = await api<OCSession[]>(url, "/session");
  ok("session gone from list", !(listedAfter.body ?? []).some((x) => x.id === sessionId));

  sse.stop();
  await server.stop();

  console.log(`\n${failures === 0 ? "ALL PASS" : "FAILURES"}: ${checks - failures}/${checks} checks passed`);
  rmSync(WORKSPACE, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
