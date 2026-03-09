import * as FS from "node:fs";
import * as Path from "node:path";

import { DEFAULT_VOICE_MODEL_ID, getDefaultVoiceModelPath } from "./voiceCatalog";

export interface PersistedVoiceConfig {
  readonly modelId: string;
  readonly modelPath: string;
}

function voiceConfigFilePath(stateDir: string): string {
  return Path.join(stateDir, "voice", "config.json");
}

function normalizeModelPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? Path.resolve(trimmed) : null;
}

export function createDefaultVoiceConfig(stateDir: string): PersistedVoiceConfig {
  return {
    modelId: DEFAULT_VOICE_MODEL_ID,
    modelPath: getDefaultVoiceModelPath(stateDir, DEFAULT_VOICE_MODEL_ID),
  };
}

export function readPersistedVoiceConfig(stateDir: string): PersistedVoiceConfig {
  const fallback = createDefaultVoiceConfig(stateDir);
  const configPath = voiceConfigFilePath(stateDir);
  if (!FS.existsSync(configPath)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(FS.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const modelId =
      typeof parsed.modelId === "string" && parsed.modelId.trim().length > 0
        ? parsed.modelId.trim()
        : fallback.modelId;
    const modelPath = normalizeModelPath(parsed.modelPath) ?? getDefaultVoiceModelPath(stateDir, modelId);
    return {
      modelId,
      modelPath,
    };
  } catch {
    return fallback;
  }
}

export function writePersistedVoiceConfig(stateDir: string, config: PersistedVoiceConfig): PersistedVoiceConfig {
  const normalized: PersistedVoiceConfig = {
    modelId: config.modelId.trim().length > 0 ? config.modelId.trim() : DEFAULT_VOICE_MODEL_ID,
    modelPath:
      normalizeModelPath(config.modelPath) ?? getDefaultVoiceModelPath(stateDir, config.modelId),
  };
  const configPath = voiceConfigFilePath(stateDir);
  FS.mkdirSync(Path.dirname(configPath), { recursive: true });
  FS.writeFileSync(`${configPath}.tmp`, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  FS.renameSync(`${configPath}.tmp`, configPath);
  return normalized;
}
