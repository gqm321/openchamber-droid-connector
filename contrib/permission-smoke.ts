/**
 * Permission bridge + restart-restore smoke test, against a real Droid.
 *
 * With autonomy "off" Droid asks before running a command. The adapter must
 * surface that as permission.asked, wait for POST /permission/{id}/reply, and
 * then either run the command (once) or refuse it (reject). A second adapter
 * instance must rebuild the session and its history from Droid's session file
 * and keep chatting in it.
 *
 *   npm run permission-smoke
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OCDROID_AUTONOMY = "off";
process.env.OCDROID_STATE_DIR = mkdtempSync(join(tmpdir(), "ocdroid-state-"));

const { AdapterServer } = await import("../src/server.js");
const { SseCollector, api } = await import("./util.js");
import type { OCEvent, OCMessageWithParts, OCPermissionRequest, OCSession } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocdroid-perm-"));
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

const body = (text: string): string => JSON.stringify({ parts: [{ type: "text", text }] });
const textOf = (m: OCMessageWithParts | undefined): string =>
  (m?.parts ?? []).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();

  const created = await api<OCSession>(url, "/session", { method: "POST", body: "{}" });
  const sid = created.body.id;
  ok("POST /session", created.status === 200 && typeof sid === "string");

  console.log("— approve once —");
  const fileA = join(WORKSPACE, "approved.txt");
  await api(url, `/session/${sid}/prompt_async`, { method: "POST", body: body(`Run exactly this shell command: echo approved > ${fileA}. Then reply with exactly: APPROVED-DONE`) });
  const askedA = (await sse.waitFor((e) => e.type === "permission.asked", 90_000, "permission.asked")) as Extract<OCEvent, { type: "permission.asked" }>;
  const reqA: OCPermissionRequest = askedA.properties;
  ok("permission.asked carries session and pattern", reqA.sessionID === sid && reqA.patterns.join(" ").includes("approved.txt"), JSON.stringify(reqA).slice(0, 200));
  const pending = await api<OCPermissionRequest[]>(url, "/permission");
  ok("GET /permission lists the pending request", pending.body.some((p) => p.id === reqA.id));
  ok("command has not run before approval", !existsSync(fileA));
  const replyA = await api<boolean>(url, `/permission/${reqA.id}/reply`, { method: "POST", body: JSON.stringify({ reply: "once" }) });
  ok("POST /permission/{id}/reply", replyA.status === 200 && replyA.body === true);
  await sse.waitFor((e) => e.type === "permission.replied", 10_000, "permission.replied");
  await sse.waitFor((e) => e.type === "session.idle" && (e.properties as { sessionID: string }).sessionID === sid, 90_000, "idle after approval");
  ok("command ran after approval", existsSync(fileA));
  const pendingAfter = await api<OCPermissionRequest[]>(url, "/permission");
  ok("pending list is empty after reply", pendingAfter.body.length === 0);

  console.log("— reject —");
  const fileB = join(WORKSPACE, "rejected.txt");
  const seen = sse.all.filter((e) => e.type === "permission.asked").length;
  await api(url, `/session/${sid}/prompt_async`, { method: "POST", body: body(`Run exactly this shell command: echo rejected > ${fileB}. Then reply with one short sentence.`) });
  const askedB = (await sse.waitFor((e) => e.type === "permission.asked" && sse.all.filter((x) => x.type === "permission.asked").length > seen, 90_000, "second permission.asked")) as Extract<OCEvent, { type: "permission.asked" }>;
  const idleBefore = sse.all.filter((e) => e.type === "session.idle").length;
  await api(url, `/permission/${askedB.properties.id}/reply`, { method: "POST", body: JSON.stringify({ reply: "reject" }) });
  await sse.waitFor((e) => e.type === "session.idle" && sse.all.filter((x) => x.type === "session.idle").length > idleBefore, 90_000, "idle after rejection");
  ok("rejected command did not run", !existsSync(fileB));

  console.log("— restart: history restored from Droid's session file —");
  sse.stop();
  await server.stop();
  const server2 = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server2.start();
  const url2 = server2.url;
  const list = await api<OCSession[]>(url2, `/session?directory=${encodeURIComponent(WORKSPACE)}`);
  ok("session listed after restart", list.body.some((s) => s.id === sid), JSON.stringify(list.body).slice(0, 200));
  const msgs = await api<OCMessageWithParts[]>(url2, `/session/${sid}/message`);
  const all = msgs.body ?? [];
  ok("history has both user prompts", all.filter((m) => m.info.role === "user").length === 2, String(all.length));
  ok("history keeps the assistant answer", all.some((m) => textOf(m).includes("APPROVED-DONE")));
  ok(
    "history keeps the completed bash tool part",
    all.some((m) => m.parts.some((p) => p.type === "tool" && p.tool === "bash" && p.state.status === "completed")),
  );
  ok("system context is not shown as a user message", !all.some((m) => m.info.role === "user" && textOf(m).includes("system-reminder")));

  const follow = await api<OCMessageWithParts>(url2, `/session/${sid}/message`, { method: "POST", body: body("What was the exact word I asked you to reply with in my first message? Answer with just that word.") });
  ok("resumed session continues with context", follow.status === 200 && textOf(follow.body).includes("APPROVED-DONE"), textOf(follow.body).slice(0, 120));

  await api(url2, `/session/${sid}`, { method: "DELETE" });
  await server2.stop();
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("smoke crashed:", err);
} finally {
  rmSync(WORKSPACE, { recursive: true, force: true });
}
console.log(failures === 0 ? `\nALL PASS: ${checks}/${checks} checks passed` : `\nFAILURES: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
