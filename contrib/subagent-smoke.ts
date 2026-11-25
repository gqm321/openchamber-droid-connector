/**
 * Sub-agent smoke test, against a real Droid.
 *
 * A sub-agent runs in the background; when it finishes, Droid starts a turn of
 * its own to report on it. That turn must show up as a busy/idle cycle with its
 * own assistant message. A custom droid's `model:` must also pick the model.
 *
 *   npm run subagent-smoke
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.OCDROID_STATE_DIR = mkdtempSync(join(tmpdir(), "ocdroid-state-"));

const { AdapterServer } = await import("../src/server.js");
const { SseCollector, api } = await import("./util.js");
import type { OCAssistantMessage, OCEvent, OCMessageWithParts, OCSession, OCToolPart } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocdroid-subagent-"));
const HELPER_MODEL = "claude-haiku-5-5";
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

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  mkdirSync(join(WORKSPACE, ".factory", "droids"), { recursive: true });
  writeFileSync(
    join(WORKSPACE, ".factory", "droids", "haiku-helper.md"),
    `---\nname: haiku-helper\ndescription: Answers short factual questions\nmodel: ${HELPER_MODEL}\ntools: read-only\n---\nAnswer the question in one short sentence.\n`,
  );
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();
  const count = (type: string): number => sse.all.filter((e) => e.type === type).length;
  const idleCount = (): number => count("session.idle");

  const created = await api<OCSession>(url, "/session", { method: "POST", body: "{}" });
  const sid = created.body.id;

  console.log("— sub-agent report turn —");
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt("请用 Task 工具调用 haiku-helper 子智能体，让它先用 Read 工具读取 .factory/droids/haiku-helper.md，再用 LS 列出当前目录，最后回答：法国的首都是哪里？启动后不要等待，直接结束这一轮；它完成后你会收到通知，到时在回复里写出它的答案。"),
  });
  await sse.waitFor(() => idleCount() >= 1, 180_000, "first idle");
  let msgs = (await api<OCMessageWithParts[]>(url, `/session/${sid}/message`)).body;
  const task = msgs.flatMap((m) => m.parts).find((p): p is OCToolPart => p.type === "tool" && p.tool === "task");
  ok("the Task call is shown as a tool card", task !== undefined, JSON.stringify(msgs.flatMap((m) => m.parts.map((p) => (p.type === "tool" ? p.tool : p.type)))));

  const busyAfterFirst = (): number => sse.all.filter((e) => e.type === "session.status" && (e.properties as { status: { type: string } }).status.type === "busy").length;
  const busyBefore = busyAfterFirst();
  const assistantCount = (): number => msgs.filter((m) => m.info.role === "assistant").length;
  const firstTurnMessages = assistantCount();
  await sse.waitFor(() => idleCount() >= 2, 180_000, "idle after the report turn");
  ok("the report turn set the session busy again", busyAfterFirst() > busyBefore);
  msgs = (await api<OCMessageWithParts[]>(url, `/session/${sid}/message`)).body;
  ok("the report turn got its own assistant message", assistantCount() > firstTurnMessages, `${firstTurnMessages} -> ${assistantCount()}`);
  const last = msgs.at(-1)!;
  ok("the report message is complete", last.info.role === "assistant" && (last.info as OCAssistantMessage).time.completed !== undefined);
  ok("the report names the answer", /巴黎|Paris/i.test(textOf(last)), textOf(last).slice(0, 200));
  const status = (await api<Record<string, { type: string }>>(url, "/session/status")).body;
  ok("session is idle afterwards", status[sid]?.type === "idle" || status[sid] === undefined, JSON.stringify(status[sid]));
  const live = sse.all.filter((e) => e.type === "message.part.updated" || e.type === "message.part.delta").length;
  ok("the report text was streamed as events", live > 0);

  console.log("— custom droid model —");
  const dir = join(homedir(), ".factory", "sessions", WORKSPACE.replaceAll("/", "-"));
  const models = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".settings.json"))
        .map((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { model?: string }).model)
    : [];
  ok("the sub-agent ran on the droid's own model", models.includes(HELPER_MODEL), JSON.stringify(models));

  console.log("— language of AskUser —");
  const seen = count("question.asked");
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt("用 AskUser 工具问我一个问题：晚饭想吃什么？给两个选项。"),
  });
  const asked = (await sse.waitFor(() => count("question.asked") > seen, 120_000, "question.asked")) as Extract<OCEvent, { type: "question.asked" }>;
  const q = asked.properties.questions[0];
  const shown = [q?.question, ...(q?.options ?? []).map((o) => o.label)].join(" ");
  ok("question and options are in Chinese", /[\u4e00-\u9fff]/.test(shown), shown);
  await api(url, `/question/${asked.properties.id}/reject`, { method: "POST", body: "{}" });
  await sse.waitFor(() => idleCount() >= 3, 120_000, "idle after dismiss");

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
  rmSync(WORKSPACE, { recursive: true, force: true });
}
console.log(failures === 0 ? `\nALL PASS: ${checks}/${checks} checks passed` : `\nFAILURES: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
