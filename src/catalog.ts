/**
 * Model/provider catalog: Droid's selectable models (SDK `listModels`),
 * translated into OpenCode v2 Provider/Model shapes and cached for the adapter
 * lifetime. All models are exposed under one provider, `droid`, so a model id
 * alone identifies what Droid runs.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listModels, type ModelInfo } from "@factory/droid-sdk/node";

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
}

function toOCModel(m: ModelInfo): OCv2Model {
  const image = m.noImageSupport !== true;
  const reasoning = m.supportedReasoningEfforts.some((e) => e !== "none");
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
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: reasoning,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    options: { provider: m.modelProvider },
  };
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

export async function loadCatalog(_directory: string): Promise<Catalog> {
  const models = await listModels({ includeDisabled: false });
  const preferred = configuredDefaultModel();
  const ordered = [...models].sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));

  const provider: OCv2Provider = { id: PROVIDER_ID, name: "Droid", source: "config", env: [], options: {}, models: {} };
  for (const m of ordered) provider.models[m.id] = toOCModel(m);

  const first = ordered[0];
  if (first === undefined) return { providers: [provider], defaults: {} };
  return {
    providers: [provider],
    defaults: { [PROVIDER_ID]: first.id },
    default: { providerID: PROVIDER_ID, modelID: first.id },
  };
}
