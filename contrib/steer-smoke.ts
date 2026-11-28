/**
 * Steering smoke test, against a real Droid.
 *
 * A message sent while the agent works is queued inside Droid and picked up
 * before its next model call, in the same turn: no "session is busy" error, no
 * second busy/idle cycle, and the reply that follows answers the new message.
 *
 *   npm run steer-smoke
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OCDROID_STATE_DIR = mkdtempSync(join(tmpdir(), "ocdroid-state-"));

const { AdapterServer } = await import("../src/server.js");
const { SseCollector, api } = await import("./util.js");
import type { OCAssistantMessage, OCMessageWithParts, OCSession, OCToolPart } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocdroid-steer-"));
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

const prompt = (text: string): string => JSON.stringify({ parts: [{ type: "text", text }] });
const textOf = (m: OCMessageWithParts): string => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();
  const count = (type: string): number => sse.all.filter((e) => e.type === type).length;
  const messages = async (sid: string): Promise<OCMessageWithParts[]> => (await api<OCMessageWithParts[]>(url, `/session/${sid}/message`)).body;
  const waitFor = async (what: string, test: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await test()) return;
      await sleep(300);
    }
    throw new Error(`timeout waiting for ${what}`);
  };
  const toolRunning = (sid: string) => async (): Promise<boolean> =>
    (await messages(sid)).some((m) => m.parts.some((p) => p.type === "tool" && (p as OCToolPart).state.status === "running"));

  console.log("— message sent while a command runs —");
  const sid = (await api<OCSession>(url, "/session", { method: "POST", body: "{}" })).body.id;
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt("用 Execute 工具运行命令 `sleep 15; echo FIRSTDONE`，等它结束后，用一句话告诉我它输出了什么。"),
  });
  await waitFor("the command to run", toolRunning(sid));
  const idleBefore = count("session.idle");
  const errorsBefore = count("session.error");
  const sent = await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt("补充一点：回复的最后请另起一行写上暗号 ZEBRA42。"),
  });
  ok("the message is accepted while busy", sent.status >= 200 && sent.status < 300, String(sent.status));
  let msgs = await messages(sid);
  ok("the user message is shown right away", msgs.some((m) => m.info.role === "user" && /ZEBRA42/.test(textOf(m))));
  await waitFor("the turn to end", async () => count("session.idle") > idleBefore);
  await sleep(4000);
  ok("one turn only: a single idle after the message", count("session.idle") === idleBefore + 1, `${count("session.idle") - idleBefore}`);
  ok("no error was reported", count("session.error") === errorsBefore);
  msgs = await messages(sid);
  const order = msgs.map((m) => m.info.role[0]).join("");
  ok("order is user, assistant, user, assistant", order === "uaua", order);
  const second = msgs.at(-1)!;
  const userTwo = msgs[2]!;
  ok("the new assistant message answers the new user message", second.info.role === "assistant" && (second.info as OCAssistantMessage).parentID === userTwo.info.id);
  ok("the first assistant message is complete", (msgs[1]!.info as OCAssistantMessage).time.completed !== undefined);
  ok("the second assistant message is complete", (second.info as OCAssistantMessage).time.completed !== undefined);
  ok("the reply carries the codeword", /ZEBRA42/.test(textOf(second)), textOf(second).slice(0, 200));
  ok("the command output is reported", /FIRSTDONE/.test(msgs.map(textOf).join(" ")));
  const status = (await api<Record<string, { type: string }>>(url, "/session/status")).body;
  ok("session is idle afterwards", status[sid]?.type === "idle" || status[sid] === undefined, JSON.stringify(status[sid]));

  console.log("— the session still works afterwards —");
  const idle2 = count("session.idle");
  await api(url, `/session/${sid}/prompt_async`, { method: "POST", body: prompt("只回答一个词：好") });
  await waitFor("a normal turn", async () => count("session.idle") > idle2);
  msgs = await messages(sid);
  ok("a normal prompt gets its own answer", msgs.at(-1)!.info.role === "assistant" && textOf(msgs.at(-1)!) !== "");

  console.log("— message sent, then stop —");
  const sid2 = (await api<OCSession>(url, "/session", { method: "POST", body: "{}" })).body.id;
  await api(url, `/session/${sid2}/prompt_async`, { method: "POST", body: prompt("用 Execute 工具运行 `sleep 60`，然后说完成。") });
  await waitFor("the command to run", toolRunning(sid2));
  const idle3 = count("session.idle");
  await api(url, `/session/${sid2}/prompt_async`, { method: "POST", body: prompt("算了，改成只回答一个词：好") });
  await sleep(1500);
  await api(url, `/session/${sid2}/abort`, { method: "POST", body: "{}" });
  await waitFor("the stop to settle", async () => count("session.idle") > idle3);
  await sleep(5000);
  const status2 = (await api<Record<string, { type: string }>>(url, "/session/status")).body[sid2];
  console.log(`    after stop: ${JSON.stringify(status2)}, messages: ${(await messages(sid2)).map((m) => m.info.role[0]).join("")}`);
  const idle4 = count("session.idle");
  const sent2 = await api(url, `/session/${sid2}/prompt_async`, { method: "POST", body: prompt("只回答一个词：行") });
  ok("a prompt after the stop is accepted", sent2.status >= 200 && sent2.status < 300, String(sent2.status));
  await waitFor("the next turn", async () => count("session.idle") > idle4);
  ok("it answers", textOf((await messages(sid2)).at(-1)!) !== "");

  console.log("— message sent while the reply streams (no tool) —");
  const sid3 = (await api<OCSession>(url, "/session", { method: "POST", body: "{}" })).body.id;
  await api(url, `/session/${sid3}/prompt_async`, { method: "POST", body: prompt("请写一篇约 400 字的短文介绍月球，分三段。") });
  await waitFor("text to stream", async () => (await messages(sid3)).some((m) => m.info.role === "assistant" && textOf(m) !== ""));
  await api(url, `/session/${sid3}/prompt_async`, { method: "POST", body: prompt("补充：请再单独回复一句，写上暗号 OTTER77。") });
  await sleep(2000);
  await waitFor("everything to settle", async () => (await api<Record<string, { type: string }>>(url, "/session/status")).body[sid3]?.type !== "busy");
  await sleep(6000);
  const st3 = (await api<Record<string, { type: string }>>(url, "/session/status")).body[sid3];
  ok("session is idle", st3 === undefined || st3.type === "idle", JSON.stringify(st3));
  msgs = await messages(sid3);
  console.log(`    messages: ${msgs.map((m) => m.info.role[0]).join("")}`);
  const after = msgs.slice(msgs.findIndex((m) => m.info.role === "user" && /OTTER77/.test(textOf(m))) + 1);
  ok("the message was answered", /OTTER77/.test(after.map(textOf).join(" ")), after.map(textOf).join(" ").slice(0, 200));
  ok("nothing is left running", msgs.every((m) => m.info.role !== "assistant" || (m.info as OCAssistantMessage).time.completed !== undefined));

  for (const id of [sid, sid2, sid3]) await api(url, `/session/${id}`, { method: "DELETE" });
  sse.stop();
  await server.stop();
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
