import { createSession, listModels, resumeSession, DroidMessageType, AutonomyLevel, ToolConfirmationOutcome } from "@factory/droid-sdk/node";
import { writeFileSync } from "node:fs";
const log: unknown[] = [];
const models = await listModels({ includeDisabled: false });
console.log("MODELS", models.length, JSON.stringify(models.slice(0, 2), null, 1));
const session = await createSession({
  cwd: process.argv[2] ?? process.cwd(),
  autonomyLevel: AutonomyLevel.Off,
  permissionHandler: ({ toolUses, options }) => {
    console.log("PERMISSION", JSON.stringify({ toolUses, options }).slice(0, 1500));
    return ToolConfirmationOutcome.ProceedOnce;
  },
});
console.log("SETTINGS", JSON.stringify(session.settings), session.id, session.cwd);
for await (const ev of session.stream("Run the shell command 'echo hi-from-droid' and then say done in one word.", { includePartialMessages: true })) {
  log.push(ev);
  const s = JSON.stringify(ev);
  console.log("EV", s.length > 400 ? s.slice(0, 400) + "..." : s);
}
await session.close();
writeFileSync("/tmp/droid-probe-events.json", JSON.stringify(log, null, 1));
console.log("SESSION_ID", session.id);
