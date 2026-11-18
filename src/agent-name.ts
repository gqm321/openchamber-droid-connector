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

export function getExposedAgentNames(): string[] {
  const name = getAgentName();
  return name === "build" ? ["build"] : ["build", name];
}
