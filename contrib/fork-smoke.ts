/**
 * Fork smoke test, against a real Droid.
 *
 * Forking from a message must give a session that holds only what came before
 * it (OpenCode semantics), leave the working tree and the parent alone, and be
 * usable. Messages sent in this run carry client-made ids; messages of a restored
 * session carry ids derived from Droid's. Both have to resolve.
 *
 *   npm run fork-smoke
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OCDROID_STATE_DIR = mkdtempSync(join(tmpdir(), "ocdroid-state-"));
process.env.OCDROID_MODEL ??= "claude-haiku-5-5";

const { AdapterServer } = await import("../src/server.js");
const { SseCollector, api } = await import("./util.js");
import type { OCMessageWithParts, OCSession } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocdroid-fork-"));
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

const textOf = (m: OCMessageWithParts): string => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ");
const userTexts = (msgs: OCMessageWithParts[]): string[] => msgs.filter((m) => m.info.role === "user").map(textOf);

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();
  const idleCount = (): number => sse.all.filter((e) => e.type === "session.idle").length;
  const messagesOf = async (sid: string): Promise<OCMessageWithParts[]> => (await api<OCMessageWithParts[]>(url, `/session/${sid}/message`)).body;
  const send = async (sid: string, text: string, messageID: string): Promise<void> => {
    const before = idleCount();
    await api(url, `/session/${sid}/prompt_async`, { method: "POST", body: JSON.stringify({ messageID, parts: [{ type: "text", text }] }) });
    await sse.waitFor(() => idleCount() > before, 180_000, `idle after ${messageID}`);
  };
  const fork = async (sid: string, messageID?: string): Promise<{ status: number; body: OCSession }> =>
    api<OCSession>(url, `/session/${sid}/fork`, { method: "POST", body: JSON.stringify(messageID === undefined ? {} : { messageID }) });

  const sid = (await api<OCSession>(url, "/session", { method: "POST", body: "{}" })).body.id;
  const file = join(WORKSPACE, "a.txt");
  await send(sid, "Reply with exactly: ONE", "msg_smoke_1");
  await send(sid, `Create the file ${file} containing the word two, then reply TWO`, "msg_smoke_2");
  await send(sid, "Reply with exactly: THREE", "msg_smoke_3");
  const parent = await messagesOf(sid);
  ok("parent has three turns", userTexts(parent).length === 3, JSON.stringify(userTexts(parent)));
  ok("the file exists before forking", existsSync(file));

  console.log("— fork before a user message —");
  const f2 = await fork(sid, "msg_smoke_2");
  ok("fork from the second message succeeds", f2.status === 200 && typeof f2.body.id === "string", JSON.stringify(f2.body).slice(0, 200));
  const m2 = await messagesOf(f2.body.id);
  ok("it holds only the first turn", JSON.stringify(userTexts(m2)) === JSON.stringify(["Reply with exactly: ONE"]), JSON.stringify(userTexts(m2)));
  ok("the working tree is untouched", existsSync(file));
  ok("the title is numbered", /\(fork #1\)$/.test(f2.body.title), f2.body.title);
  ok("the parent is unchanged", userTexts(await messagesOf(sid)).length === 3);

  console.log("— fork at an assistant message —");
  const assistantOfTurn2 = parent.find((m) => m.info.role === "assistant" && (m.info as { parentID?: string }).parentID === "msg_smoke_2");
  ok("found the assistant message of turn two", assistantOfTurn2 !== undefined);
  if (assistantOfTurn2 !== undefined) {
    const fa = await fork(sid, assistantOfTurn2.info.id);
    const ma = await messagesOf(fa.body.id);
    ok("it keeps that whole turn and stops before the next", userTexts(ma).length === 2 && !userTexts(ma).some((t) => t.includes("THREE")), JSON.stringify(userTexts(ma)));
  }

  console.log("— the last user message and the whole transcript —");
  const f3 = await fork(sid, "msg_smoke_3");
  const m3 = await messagesOf(f3.body.id);
  ok("forking before the last message leaves two turns", userTexts(m3).length === 2, JSON.stringify(userTexts(m3)));
  const fall = await fork(sid);
  ok("no message id copies everything", userTexts(await messagesOf(fall.body.id)).length === 3);

  console.log("— a fork of a restored session —");
  const shown = await messagesOf(f3.body.id);
  const secondUser = shown.filter((m) => m.info.role === "user")[1]!;
  ok("restored messages carry ids derived from Droid's", secondUser.info.id.startsWith("msg_") && secondUser.info.id !== "msg_smoke_2", secondUser.info.id);
  const ff = await fork(f3.body.id, secondUser.info.id);
  ok("fork from it succeeds", ff.status === 200, JSON.stringify(ff.body).slice(0, 200));
  ok("it holds one turn", userTexts(await messagesOf(ff.body.id)).length === 1);

  console.log("— errors —");
  const missing = await fork(sid, "msg_does_not_exist");
  ok("an unknown message is a 404", missing.status === 404, String(missing.status));

  console.log("— the fork is usable —");
  await send(f2.body.id, "Reply with exactly: FORKED", "msg_smoke_f1");
  const after = await messagesOf(f2.body.id);
  ok("the fork continues from its own history", userTexts(after).length === 2 && after.some((m) => m.info.role === "assistant" && textOf(m).includes("FORKED")), JSON.stringify(userTexts(after)));
  ok("the parent still has three turns", userTexts(await messagesOf(sid)).length === 3);

  for (const id of [sid, f2.body.id, f3.body.id, fall.body.id, ff.body.id]) await api(url, `/session/${id}`, { method: "DELETE" });
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
