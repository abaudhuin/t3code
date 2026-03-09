import * as Path from "node:path";

import type { VoiceModel } from "@t3tools/contracts";

export interface VoiceModelDownloadFile {
  readonly name: string;
  readonly url: string;
}

export interface VoiceModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly downloadPageUrl: string;
  readonly downloadSizeBytes: number | null;
  readonly files: readonly VoiceModelDownloadFile[];
}

export const DEFAULT_VOICE_MODEL_ID = "parakeet-tdt-0.6b-v3";

export const VOICE_MODEL_CATALOG: ReadonlyArray<VoiceModelCatalogEntry> = [
  {
    id: DEFAULT_VOICE_MODEL_ID,
    displayName: "Parakeet TDT 0.6B v3",
    downloadPageUrl: "https://huggingface.co/maxkulish/parakeet-tdt-0.6b-v3",
    downloadSizeBytes: 2_557_000_000,
    files: [
      {
        name: "encoder-model.onnx",
        url: "https://huggingface.co/maxkulish/parakeet-tdt-0.6b-v3/resolve/main/encoder-model.onnx?download=1",
      },
      {
        name: "encoder-model.onnx.data",
        url: "https://huggingface.co/maxkulish/parakeet-tdt-0.6b-v3/resolve/main/encoder-model.onnx.data?download=1",
      },
      {
        name: "decoder_joint-model.onnx",
        url: "https://huggingface.co/maxkulish/parakeet-tdt-0.6b-v3/resolve/main/decoder_joint-model.onnx?download=1",
      },
      {
        name: "vocab.txt",
        url: "https://huggingface.co/maxkulish/parakeet-tdt-0.6b-v3/resolve/main/vocab.txt?download=1",
      },
    ],
  },
];

export function getVoiceModelCatalogEntry(modelId: string): VoiceModelCatalogEntry | undefined {
  return VOICE_MODEL_CATALOG.find((entry) => entry.id === modelId);
}

export function getDefaultVoiceModelPath(stateDir: string, modelId = DEFAULT_VOICE_MODEL_ID): string {
  return Path.join(stateDir, "voice", "models", modelId);
}

export function toVoiceModelList(input: {
  readonly activeModelId: string;
  readonly installedModelIds: ReadonlySet<string>;
}): VoiceModel[] {
  return VOICE_MODEL_CATALOG.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    installed: input.installedModelIds.has(entry.id),
    isDefault: input.activeModelId === entry.id,
    downloadSizeBytes: entry.downloadSizeBytes,
  }));
}
