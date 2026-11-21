/**
 * Model/provider catalog: Droid's selectable models (SDK `listModels`),
 * translated into OpenCode v2 Provider/Model shapes and cached for the adapter
 * lifetime. All models are exposed under one provider, `droid`, so a model id
 * alone identifies what Droid runs.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AutonomyLevel, createSession, listModels, type ModelInfo } from "@factory/droid-sdk/node";
import { removeDroidSessionFiles } from "./session-store.js";

export const PROVIDER_ID = "droid";

interface OCv2Model {
  id: string;
  providerID: string;
  api: { id: string; url: string; npm: string };
  name: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    interleaved: boolean;
  };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
  /** One entry per selectable reasoning effort; the key is what the UI sends back as `variant`. */
  variants: Record<string, { reasoningEffort: string }>;
  options: Record<string, unknown>;
}

export interface OCv2Provider {
  id: string;
  name: string;
  source: "config";
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, OCv2Model>;
}

export interface Catalog {
  providers: OCv2Provider[];
  /** providerID → default modelID */
  defaults: Record<string, string>;
  /**
   * The model Droid would start a new session with. The client pins its picker
   * to this and validates it against the catalog, so it must be listed.
   */
  default?: { providerID: string; modelID: string };
  /** modelID → reasoning efforts Droid accepts for it, used to validate the UI's variant. */
  efforts?: Record<string, { supported: string[]; default: string }>;
}

/** Wall-clock cap so a stuck probe cannot hold up the model list. */
const CONTEXT_PROBE_TIMEOUT_MS = 20_000;

function toOCModel(m: ModelInfo, contextLimit: number): OCv2Model {
  const image = m.noImageSupport !== true;
  const efforts = m.supportedReasoningEfforts.filter((e) => e !== "none");
  const reasoning = efforts.length > 0;
  return {
    id: m.id,
    providerID: PROVIDER_ID,
    api: { id: m.id, url: "", npm: "@ai-sdk/openai-compatible" },
    name: m.displayName,
    capabilities: {
      temperature: false,
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, audio: false, image, video: false, pdf: false },
      output: { text: true, audio: false, image: m.supportsImageGeneration === true, video: false, pdf: false },
      interleaved: reasoning,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: contextLimit, output: 0 },
    variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
    options: { provider: m.modelProvider },
  };
}

/**
 * Droid's model list carries no context size, but a live session reports the
 * input limit of whichever model/effort it is set to. Switch one throwaway
 * session through every model (settings only, no LLM call) and read it back.
 * A model that cannot be probed keeps 0, which the UI treats as "unknown".
 */
async function probeContextLimits(directory: string, models: ModelInfo[]): Promise<Map<string, number>> {
  const limits = new Map<string, number>();
  const probe = async (): Promise<void> => {
    const session = await createSession({ cwd: directory, autonomyLevel: AutonomyLevel.Off });
    try {
      for (const m of models) {
        // The router picks a concrete model per request, so a session cannot report its size.
        if (m.kind === "router") continue;
        try {
          await session.updateSettings({ modelId: m.id, reasoningEffort: m.defaultReasoningEffort });
          const { limit } = await session.getContextStats();
          if (Number.isFinite(limit) && limit > 0) limits.set(m.id, limit);
        } catch (err) {
          console.error(`[catalog] no context size for ${m.id}:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      await session.close().catch(() => undefined);
      // The probe session would otherwise show up in Droid's history and the sidebar.
      removeDroidSessionFiles(session.id, directory);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("context probe timed out")), CONTEXT_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error("[catalog] context probe failed:", err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
  return limits;
}

/** The model Droid itself would pick: env override, then the user's settings. */
function configuredDefaultModel(): string | undefined {
  const fromEnv = process.env.OCDROID_MODEL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".factory", "settings.json"), "utf8")) as {
      sessionDefaultSettings?: { model?: unknown };
      model?: unknown;
    };
    const m = raw.sessionDefaultSettings?.model ?? raw.model;
    if (typeof m === "string" && m !== "") return m;
  } catch {
    /* missing or unparseable settings: fall back to the first listed model */
  }
  return undefined;
}

export async function loadCatalog(directory: string): Promise<Catalog> {
  const models = await listModels({ includeDisabled: false });
  const contextLimits = await probeContextLimits(directory, models);
  const preferred = configuredDefaultModel();
  const ordered = [...models].sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));

  const provider: OCv2Provider = { id: PROVIDER_ID, name: "Droid", source: "config", env: [], options: {}, models: {} };
  const efforts: NonNullable<Catalog["efforts"]> = {};
  for (const m of ordered) {
    provider.models[m.id] = toOCModel(m, contextLimits.get(m.id) ?? 0);
    efforts[m.id] = { supported: m.supportedReasoningEfforts.map(String), default: String(m.defaultReasoningEffort) };
  }

  const first = ordered[0];
  if (first === undefined) return { providers: [provider], defaults: {}, efforts };
  return {
    providers: [provider],
    defaults: { [PROVIDER_ID]: first.id },
    default: { providerID: PROVIDER_ID, modelID: first.id },
    efforts,
  };
}
