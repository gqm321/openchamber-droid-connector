/**
 * AskUser and plan-mode smoke test, against a real Droid.
 *
 * Droid's AskUser tool must surface as question.asked and wait for
 * POST /question/{id}/reply (or /reject). The UI's `plan` agent must run the
 * session in spec mode, and approving the plan must surface as a question too.
 *
 *   npm run question-smoke
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OCDROID_STATE_DIR = mkdtempSync(join(tmpdir(), "ocdroid-state-"));

const { AdapterServer } = await import("../src/server.js");
const { SseCollector, api } = await import("./util.js");
import type { OCEvent, OCMessageWithParts, OCQuestionRequest, OCSession, OCToolPart } from "../src/types.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "ocdroid-question-"));
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

const prompt = (text: string, agent?: string): string => JSON.stringify({ parts: [{ type: "text", text }], ...(agent !== undefined ? { agent } : {}) });
const toolParts = (msgs: OCMessageWithParts[], tool: string): OCToolPart[] =>
  msgs.flatMap((m) => m.parts.filter((p): p is OCToolPart => p.type === "tool" && p.tool === tool));

async function main(): Promise<void> {
  console.log(`workspace: ${WORKSPACE}`);
  const server = new AdapterServer({ port: 0, host: "127.0.0.1", defaultDirectory: WORKSPACE });
  await server.start();
  const url = server.url;
  const sse = new SseCollector(url);
  await sse.start();
  const idleCount = (): number => sse.all.filter((e) => e.type === "session.idle").length;
  const askedCount = (): number => sse.all.filter((e) => e.type === "question.asked").length;

  const agents = await api<Array<{ name: string }>>(url, "/agent");
  ok("plan agent is published", agents.body.some((a) => a.name === "plan"));

  const created = await api<OCSession>(url, "/session", { method: "POST", body: "{}" });
  const sid = created.body.id;

  console.log("— AskUser: single and multiple choice —");
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt(
      "Use the AskUser tool exactly once with two questions. Question 1 (header Color, single choice): options Red, Blue. Question 2 (header Fruit, multiple choice allowed): options Apple, Pear, Plum. After the answers, reply with one line: PICKED followed by the answers.",
    ),
  });
  const asked = (await sse.waitFor((e) => e.type === "question.asked", 120_000, "question.asked")) as Extract<OCEvent, { type: "question.asked" }>;
  const req: OCQuestionRequest = asked.properties;
  ok("question.asked carries both questions", req.sessionID === sid && req.questions.length === 2, JSON.stringify(req).slice(0, 300));
  ok("multiple flag is mapped", req.questions[0]?.multiple === false && req.questions[1]?.multiple === true);
  ok("options are mapped", req.questions[0]?.options.map((o) => o.label).join() === "Red,Blue", JSON.stringify(req.questions[0]?.options));
  ok("tool reference points at the running question call", typeof req.tool?.callID === "string" && req.tool.callID !== "");
  const listed = await api<OCQuestionRequest[]>(url, "/question");
  ok("GET /question lists it", listed.body.some((q) => q.id === req.id));
  const idleBefore = idleCount();
  const reply = await api<boolean>(url, `/question/${req.id}/reply`, { method: "POST", body: JSON.stringify({ answers: [["Blue"], ["Apple", "Plum"]] }) });
  ok("POST /question/{id}/reply", reply.status === 200 && reply.body === true);
  await sse.waitFor((e) => e.type === "question.replied", 10_000, "question.replied");
  await sse.waitFor(() => idleCount() > idleBefore, 120_000, "idle after answers");
  let msgs = (await api<OCMessageWithParts[]>(url, `/session/${sid}/message`)).body;
  const card = toolParts(msgs, "question")[0];
  ok("question tool part completed", card?.state.status === "completed", card?.state.status);
  const answers = card?.state.status === "completed" ? (card.state.metadata as { answers?: string[][] }).answers : undefined;
  ok("card metadata carries the answers", JSON.stringify(answers) === JSON.stringify([["Blue"], ["Apple", "Plum"]]), JSON.stringify(answers));
  const finalText = msgs.flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ");
  ok("Droid received the answers", finalText.includes("Blue") && finalText.includes("Apple") && finalText.includes("Plum"), finalText.slice(-200));
  ok("pending questions are empty", (await api<OCQuestionRequest[]>(url, "/question")).body.length === 0);

  console.log("— AskUser: dismissed —");
  const seenAsked = askedCount();
  const idleB = idleCount();
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt("Use the AskUser tool once: ask 'Continue?' (header Go) with options Yes, No. If it is dismissed or cancelled, reply with exactly: DISMISSED"),
  });
  await sse.waitFor(() => askedCount() > seenAsked, 120_000, "second question.asked");
  const second = sse.all.filter((e) => e.type === "question.asked").at(-1) as Extract<OCEvent, { type: "question.asked" }>;
  await api(url, `/question/${second.properties.id}/reject`, { method: "POST", body: "{}" });
  await sse.waitFor((e) => e.type === "question.rejected", 10_000, "question.rejected");
  await sse.waitFor(() => idleCount() > idleB, 120_000, "idle after dismissal");
  ok("session finished after dismissal", true);

  console.log("— plan mode: approve —");
  const file = join(WORKSPACE, "plan-ok.txt");
  const planSeen = askedCount();
  const idleC = idleCount();
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt(`Plan how to create the file ${file} containing the word hello. Keep the plan to three lines, then present it for approval.`, "plan"),
  });
  await sse.waitFor(() => askedCount() > planSeen, 180_000, "plan approval question");
  const approval = sse.all.filter((e) => e.type === "question.asked").at(-1) as Extract<OCEvent, { type: "question.asked" }>;
  const q = approval.properties.questions[0];
  ok("plan approval is a question with the plan", q?.header === "Plan approval" && q.question.includes("plan-ok.txt"), JSON.stringify(q).slice(0, 300));
  ok("plan approval offers choices", (q?.options.length ?? 0) >= 2, JSON.stringify(q?.options));
  ok("nothing was written before approval", !existsSync(file));
  // Plain "proceed" would still ask before each action; the low level lets the file edit through.
  const proceed = q!.options.find((o) => o.label.includes("(Low)")) ?? q!.options[0]!;
  await api(url, `/question/${approval.properties.id}/reply`, { method: "POST", body: JSON.stringify({ answers: [[proceed.label]] }) });
  await sse.waitFor(() => idleCount() > idleC, 180_000, "idle after plan approval");
  msgs = (await api<OCMessageWithParts[]>(url, `/session/${sid}/message`)).body;
  ok("plan_exit tool part is shown", toolParts(msgs, "plan_exit").length > 0);
  ok("approved plan was carried out", existsSync(file));

  console.log("— plan mode: refuse —");
  const file2 = join(WORKSPACE, "plan-no.txt");
  const planSeen2 = askedCount();
  const idleD = idleCount();
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt(`Plan how to create the file ${file2} containing the word no. Keep the plan to three lines, then present it for approval.`, "plan"),
  });
  await sse.waitFor(() => askedCount() > planSeen2, 180_000, "second plan approval");
  const approval2 = sse.all.filter((e) => e.type === "question.asked").at(-1) as Extract<OCEvent, { type: "question.asked" }>;
  await api(url, `/question/${approval2.properties.id}/reject`, { method: "POST", body: "{}" });
  await sse.waitFor(() => idleCount() > idleD, 180_000, "idle after refusal");
  ok("refused plan was not carried out", !existsSync(file2));

  console.log("— back to the build agent —");
  const buildFile = join(WORKSPACE, "build.txt");
  const idleE = idleCount();
  const askedBefore = askedCount();
  await api(url, `/session/${sid}/prompt_async`, {
    method: "POST",
    body: prompt(`Create the file ${buildFile} containing the word build. Then reply DONE.`, "build"),
  });
  await sse.waitFor(() => idleCount() > idleE, 180_000, "idle after build prompt");
  ok("build agent edits directly without asking for plan approval", existsSync(buildFile) && askedCount() === askedBefore);

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
