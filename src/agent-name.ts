/**
 * Agent naming: the adapter reports one OpenCode "agent" to the UI.
 * OpenChamber's default-agent resolution prefers a primary agent named
 * `build`, so that is the single published name unless OCDROID_AGENT says
 * otherwise (in which case `build` is still published as an alias).
 */

export function getAgentName(): string {
  const fromEnv = process.env.OCDROID_AGENT?.trim();
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : "build";
}

/** Selecting this agent in the UI runs the session in Droid's spec (plan) mode. */
export const PLAN_AGENT = "plan";

export function agentDescription(name: string): string {
  if (name === PLAN_AGENT) return "Plan mode (Droid spec mode): researches and proposes a plan, changes nothing until you approve it";
  const droidName = getAgentName();
  return name === droidName ? `${droidName} (Droid via openchamber-droid-connector)` : `${name} — ${droidName} (Droid via openchamber-droid-connector)`;
}

export function getExposedAgentNames(): string[] {
  const name = getAgentName();
  return name === "build" ? ["build", PLAN_AGENT] : ["build", name, PLAN_AGENT];
}
