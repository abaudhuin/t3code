import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { VoiceModel, VoiceSetupState, VoiceState, VoiceTranscriptEvent } from "@t3tools/contracts";

import {
  DEFAULT_VOICE_MODEL_ID,
  getDefaultVoiceModelPath,
  getVoiceModelCatalogEntry,
  toVoiceModelList,
  VOICE_MODEL_CATALOG,
} from "./voiceCatalog";
import {
  readPersistedVoiceConfig,
  writePersistedVoiceConfig,
  type PersistedVoiceConfig,
} from "./voiceConfig";

const SIDECAR_STARTUP_TIMEOUT_MS = 120_000;
const SIDECAR_COMMAND_TIMEOUT_MS = 120_000;
const SIDECAR_SHUTDOWN_TIMEOUT_MS = 5_000;
const SIDECAR_RESTART_DELAY_MS = 1_000;

interface VoiceRuntimeCommandResultMap {
  "voice.getState": VoiceState;
  "voice.startRecording": null;
  "voice.stopRecording": null;
  "voice.cancelRecording": null;
  "voice.shutdown": null;
}

type VoiceRuntimeCommand = keyof VoiceRuntimeCommandResultMap;

interface SidecarReadyMessage {
  kind: "ready";
  state: VoiceState;
}

interface SidecarEventMessage {
  kind: "event";
  event: "voice.stateChanged" | "voice.transcriptFinal" | "voice.error";
  payload: unknown;
}

interface SidecarResponseMessage {
  kind: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type SidecarMessage = SidecarReadyMessage | SidecarEventMessage | SidecarResponseMessage;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SidecarSpawnConfig {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface DownloadProgress {
  completedBytes: number;
  totalBytes: number | null;
}

export interface VoiceRuntimeOptions {
  stateDir: string;
  repoRoot: string;
  isPackaged: boolean;
  onState: (state: VoiceState) => void;
  onSetupState: (state: VoiceSetupState) => void;
  onTranscript: (event: VoiceTranscriptEvent) => void;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

function initialVoiceState(): VoiceState {
  return {
    status: "idle",
    modelId: null,
    message: null,
  };
}

function createUnsupportedState(message: string): VoiceState {
  return {
    status: "error",
    modelId: null,
    message,
  };
}

function isVoiceState(value: unknown): value is VoiceState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.status === "idle" ||
      candidate.status === "recording" ||
      candidate.status === "loading-model" ||
      candidate.status === "transcribing" ||
      candidate.status === "error") &&
    (candidate.modelId === null || typeof candidate.modelId === "string") &&
    (candidate.message === null || typeof candidate.message === "string")
  );
}

function isVoiceTranscriptEvent(value: unknown): value is VoiceTranscriptEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.text === "string" &&
    candidate.final === true &&
    typeof candidate.modelId === "string"
  );
}

function normalizeLine(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModelPath(modelPath: string): string {
  const trimmed = modelPath.trim();
  return trimmed.length > 0 ? Path.resolve(trimmed) : "";
}

function looksLikeInstalledModelDir(modelPath: string): boolean {
  if (modelPath.length === 0 || !FS.existsSync(modelPath)) {
    return false;
  }
  return (
    FS.statSync(modelPath).isDirectory() &&
    FS.existsSync(Path.join(modelPath, "encoder-model.onnx")) &&
    FS.existsSync(Path.join(modelPath, "decoder_joint-model.onnx")) &&
    FS.existsSync(Path.join(modelPath, "vocab.txt"))
  );
}

async function downloadModelFile(
  file: { readonly url: string; readonly destinationPath: string },
  onProgress: (chunkBytes: number, totalBytes: number | null) => void,
): Promise<void> {
  const response = await fetch(file.url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${Path.basename(file.destinationPath)} (${response.status}).`);
  }

  const tempPath = `${file.destinationPath}.part`;
  await FS.promises.mkdir(Path.dirname(file.destinationPath), { recursive: true });
  const totalBytesHeader = response.headers.get("content-length");
  const totalBytes =
    totalBytesHeader && Number.isFinite(Number(totalBytesHeader)) ? Number(totalBytesHeader) : null;

  const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  const destination = FS.createWriteStream(tempPath);

  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await new Promise<void>((resolve, reject) => {
        destination.write(buffer, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      onProgress(buffer.length, totalBytes);
    }
    await new Promise<void>((resolve, reject) => {
      destination.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await FS.promises.rm(file.destinationPath, { force: true });
    await FS.promises.rename(tempPath, file.destinationPath);
  } catch (error) {
    destination.destroy();
    await FS.promises.rm(tempPath, { force: true });
    throw error;
  }
}

export class VoiceSidecarRuntime {
  private readonly stateDir: string;
  private readonly repoRoot: string;
  private readonly isPackaged: boolean;
  private readonly onState: (state: VoiceState) => void;
  private readonly onSetupState: (state: VoiceSetupState) => void;
  private readonly onTranscript: (event: VoiceTranscriptEvent) => void;
  private readonly onLog: ((level: "info" | "warn" | "error", message: string) => void) | undefined;
  private child: ChildProcess.ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private isRestarting = false;
  private state = initialVoiceState();
  private config: PersistedVoiceConfig;
  private setupState: VoiceSetupState;
  private downloadInFlight = false;

  constructor(options: VoiceRuntimeOptions) {
    this.stateDir = options.stateDir;
    this.repoRoot = options.repoRoot;
    this.isPackaged = options.isPackaged;
    this.onState = options.onState;
    this.onSetupState = options.onSetupState;
    this.onTranscript = options.onTranscript;
    this.onLog = options.onLog;
    this.config = this.readConfig();
    this.setupState = this.computeSetupState();
  }

  start(): void {
    this.stopped = false;
    this.emitSetupState();
    if (this.child) {
      return;
    }
    try {
      this.spawnSidecar();
    } catch (error) {
      this.setState(
        createUnsupportedState(
          error instanceof Error ? error.message : "Voice sidecar could not start.",
        ),
      );
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.stopSidecarProcess();
  }

  getState(): VoiceState {
    return this.state;
  }

  getSetupState(): VoiceSetupState {
    return this.setupState;
  }

  async listModels(): Promise<VoiceModel[]> {
    const installedModelIds = new Set<string>();
    for (const entry of VOICE_MODEL_CATALOG) {
      if (
        entry.id === this.config.modelId &&
        looksLikeInstalledModelDir(this.resolveConfiguredModelPath(this.config))
      ) {
        installedModelIds.add(entry.id);
      }
    }
    return toVoiceModelList({
      activeModelId: this.config.modelId,
      installedModelIds,
    });
  }

  async installModel(input: { modelId: string }): Promise<void> {
    if (this.downloadInFlight) {
      throw new Error("Voice model download is already in progress.");
    }
    const entry = getVoiceModelCatalogEntry(input.modelId);
    if (!entry) {
      throw new Error(`Unsupported voice model: ${input.modelId}`);
    }

    const targetDir = getDefaultVoiceModelPath(this.stateDir, entry.id);
    this.writeConfig({
      modelId: entry.id,
      modelPath: targetDir,
    });
    this.downloadInFlight = true;
    this.setSetupState({
      ...this.setupState,
      status: "downloading",
      modelId: entry.id,
      modelPath: targetDir,
      downloadPercent: 0,
      message: "Downloading voice model…",
    });

    try {
      let completedBytes = 0;
      let totalBytes = entry.downloadSizeBytes;
      for (const file of entry.files) {
        await downloadModelFile(
          {
            url: file.url,
            destinationPath: Path.join(targetDir, file.name),
          },
          (chunkBytes, fileTotalBytes) => {
            completedBytes += chunkBytes;
            if (totalBytes === null && fileTotalBytes !== null) {
              totalBytes = fileTotalBytes;
            }
            this.updateDownloadProgress({
              completedBytes,
              totalBytes,
            });
          },
        );
      }

      this.downloadInFlight = false;
      this.setSetupState(
        this.computeSetupState({
          status: "ready",
          message: `Installed ${entry.displayName}.`,
          downloadPercent: 100,
        }),
      );
      await this.restartForConfigChange();
    } catch (error) {
      this.downloadInFlight = false;
      const message = error instanceof Error ? error.message : "Voice model download failed.";
      this.setSetupState(
        this.computeSetupState({
          status: "error",
          message,
          downloadPercent: null,
        }),
      );
      throw error;
    }
  }

  async setModelPath(input: { modelPath: string }): Promise<VoiceSetupState> {
    const nextPath = normalizeModelPath(input.modelPath);
    if (nextPath.length === 0) {
      throw new Error("Voice model path cannot be empty.");
    }
    this.writeConfig({
      ...this.config,
      modelPath: nextPath,
    });
    this.setSetupState(this.computeSetupState());
    await this.restartForConfigChange();
    return this.setupState;
  }

  async setDefaultModel(input: { modelId: string }): Promise<void> {
    if (!getVoiceModelCatalogEntry(input.modelId)) {
      throw new Error(`Unsupported voice model: ${input.modelId}`);
    }
    this.writeConfig({
      ...this.config,
      modelId: input.modelId,
    });
    this.setSetupState(this.computeSetupState());
    await this.restartForConfigChange();
  }

  async startRecording(): Promise<void> {
    if (this.setupState.status !== "ready") {
      throw new Error("Voice is not initialized yet. Open Settings > Voice to configure or download the model.");
    }
    await this.request("voice.startRecording", undefined);
  }

  async stopRecording(): Promise<void> {
    await this.request("voice.stopRecording", undefined);
  }

  async cancelRecording(): Promise<void> {
    await this.request("voice.cancelRecording", undefined);
  }

  private updateDownloadProgress(progress: DownloadProgress): void {
    const downloadPercent =
      progress.totalBytes && progress.totalBytes > 0
        ? Math.min(100, Math.round((progress.completedBytes / progress.totalBytes) * 100))
        : null;
    this.setSetupState({
      ...this.setupState,
      status: "downloading",
      downloadPercent,
      message:
        downloadPercent === null
          ? "Downloading voice model…"
          : `Downloading voice model… ${downloadPercent}%`,
    });
  }

  private readConfig(): PersistedVoiceConfig {
    const envModelPath = process.env.T3CODE_PARAKEET_MODEL_DIR?.trim();
    const envModelId = process.env.T3CODE_PARAKEET_MODEL_ID?.trim();
    if (envModelPath && envModelPath.length > 0) {
      return {
        modelId: envModelId && envModelId.length > 0 ? envModelId : DEFAULT_VOICE_MODEL_ID,
        modelPath: normalizeModelPath(envModelPath),
      };
    }
    return readPersistedVoiceConfig(this.stateDir);
  }

  private writeConfig(nextConfig: PersistedVoiceConfig): PersistedVoiceConfig {
    const envModelPath = process.env.T3CODE_PARAKEET_MODEL_DIR?.trim();
    if (envModelPath && envModelPath.length > 0) {
      this.config = {
        modelId: nextConfig.modelId,
        modelPath: normalizeModelPath(envModelPath),
      };
      return this.config;
    }
    this.config = writePersistedVoiceConfig(this.stateDir, nextConfig);
    return this.config;
  }

  private resolveConfiguredModelPath(config = this.config): string {
    const normalized = normalizeModelPath(config.modelPath);
    if (normalized.length > 0) {
      return normalized;
    }
    return getDefaultVoiceModelPath(this.stateDir, config.modelId);
  }

  private computeSetupState(
    override?: Partial<Pick<VoiceSetupState, "status" | "message" | "downloadPercent">>,
  ): VoiceSetupState {
    const modelId = this.config.modelId.trim().length > 0 ? this.config.modelId : DEFAULT_VOICE_MODEL_ID;
    const modelPath = this.resolveConfiguredModelPath();
    const entry = getVoiceModelCatalogEntry(modelId);
    const installed = looksLikeInstalledModelDir(modelPath);
    const defaultModelPath = getDefaultVoiceModelPath(this.stateDir, modelId);
    const fallbackStatus: VoiceSetupState["status"] = installed ? "ready" : "missing";
    return {
      status: override?.status ?? fallbackStatus,
      modelId,
      modelPath,
      defaultModelPath,
      downloadUrl: entry?.downloadPageUrl ?? null,
      downloadPercent: override?.downloadPercent ?? null,
      message:
        override?.message ??
        (installed ? "Voice model ready." : "Voice model not found at the configured path."),
    };
  }

  private emitSetupState(): void {
    this.onSetupState(this.setupState);
  }

  private setSetupState(nextState: VoiceSetupState): void {
    if (
      this.setupState.status === nextState.status &&
      this.setupState.modelId === nextState.modelId &&
      this.setupState.modelPath === nextState.modelPath &&
      this.setupState.defaultModelPath === nextState.defaultModelPath &&
      this.setupState.downloadUrl === nextState.downloadUrl &&
      this.setupState.downloadPercent === nextState.downloadPercent &&
      this.setupState.message === nextState.message
    ) {
      return;
    }
    this.setupState = nextState;
    this.emitSetupState();
  }

  private async restartForConfigChange(): Promise<void> {
    if (this.isRestarting) {
      return;
    }
    this.isRestarting = true;
    const wasStopped = this.stopped;
    try {
      await this.stopSidecarProcess();
      if (!wasStopped) {
        this.stopped = false;
        this.spawnSidecar();
      }
    } finally {
      this.isRestarting = false;
    }
  }

  private async stopSidecarProcess(): Promise<void> {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Voice sidecar request ${id} cancelled during shutdown.`));
    }
    this.pendingRequests.clear();
    const child = this.child;
    if (!child) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    try {
      await this.request("voice.shutdown", undefined, SIDECAR_SHUTDOWN_TIMEOUT_MS);
    } catch {
      child.kill("SIGTERM");
    }
    this.child = null;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, SIDECAR_SHUTDOWN_TIMEOUT_MS);
      timeout.unref();
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private ensureReady(): Promise<void> {
    if (!this.child) {
      this.start();
    }
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        const wrappedResolve = () => {
          clearTimeout(timeout);
          if (this.resolveReady === wrappedResolve) {
            this.resolveReady = null;
            this.rejectReady = null;
          }
          resolve();
        };
        const wrappedReject = (error: Error) => {
          clearTimeout(timeout);
          if (this.rejectReady === wrappedReject) {
            this.resolveReady = null;
            this.rejectReady = null;
            this.readyPromise = null;
          }
          reject(error);
        };
        const timeout = setTimeout(() => {
          if (this.rejectReady === wrappedReject) {
            this.resolveReady = null;
            this.rejectReady = null;
            this.readyPromise = null;
          }
          reject(new Error("Voice sidecar startup timed out."));
        }, SIDECAR_STARTUP_TIMEOUT_MS);
        timeout.unref();
        this.resolveReady = wrappedResolve;
        this.rejectReady = wrappedReject;
      });
    }
    return this.readyPromise;
  }

  private spawnSidecar(): void {
    const config = this.resolveSpawnConfig();
    const child = ChildProcess.spawn(config.command, config.args, {
      cwd: config.cwd,
      env: config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.stdoutBuffer = "";
    this.readyPromise = null;
    this.ensureReady().catch((error) => {
      this.log("error", error.message);
      this.setState(createUnsupportedState(error.message));
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.flushStdoutBuffer();
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const line = normalizeLine(chunk);
      if (line.length > 0) {
        this.log("warn", `voice-sidecar stderr: ${line}`);
      }
    });

    child.once("error", (error) => {
      if (this.child === child) {
        this.child = null;
      }
      this.failPendingRequests(error.message);
      this.rejectReady?.(new Error(`Voice sidecar failed to start: ${error.message}`));
      if (!this.stopped) {
        this.setState(createUnsupportedState(`Voice sidecar failed to start: ${error.message}`));
        this.scheduleRestart();
      }
    });

    child.once("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      const detail = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.failPendingRequests(`Voice sidecar exited (${detail}).`);
      if (this.stopped || this.isRestarting) {
        return;
      }
      this.rejectReady?.(new Error(`Voice sidecar exited before becoming ready (${detail}).`));
      this.setState(createUnsupportedState(`Voice sidecar exited unexpectedly (${detail}).`));
      this.scheduleRestart();
    });
  }

  private resolveSpawnConfig(): SidecarSpawnConfig {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      T3CODE_STATE_DIR: this.stateDir,
      T3CODE_PARAKEET_MODEL_DIR: this.resolveConfiguredModelPath(),
      T3CODE_PARAKEET_MODEL_ID: this.config.modelId,
    };

    const explicitPath = process.env.T3CODE_VOICE_SIDECAR_PATH?.trim();
    if (explicitPath) {
      return {
        command: explicitPath,
        args: [],
        cwd: Path.dirname(explicitPath),
        env: baseEnv,
      };
    }

    if (this.isPackaged) {
      const executableName = process.platform === "win32" ? "t3-voice.exe" : "t3-voice";
      const candidates = [
        Path.join(process.resourcesPath, "resources", "bin", executableName),
        Path.join(process.resourcesPath, "bin", executableName),
      ];
      const packagedBinary = candidates.find((candidate) => FS.existsSync(candidate));
      if (!packagedBinary) {
        throw new Error("Packaged voice sidecar binary not found.");
      }
      return {
        command: packagedBinary,
        args: [],
        cwd: Path.dirname(packagedBinary),
        env: baseEnv,
      };
    }

    const sidecarDir = Path.join(this.repoRoot, "apps", "voice-sidecar");
    const manifestPath = Path.join(sidecarDir, "Cargo.toml");
    if (!FS.existsSync(manifestPath)) {
      throw new Error(`Voice sidecar manifest not found at ${manifestPath}.`);
    }
    return {
      command: "cargo",
      args: ["run", "--quiet", "--"],
      cwd: sidecarDir,
      env: baseEnv,
    };
  }

  private flushStdoutBuffer(): void {
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      this.consumeSidecarLine(line);
    }
  }

  private consumeSidecarLine(line: string): void {
    let message: SidecarMessage;
    try {
      message = JSON.parse(line) as SidecarMessage;
    } catch {
      this.log("warn", `dropping invalid voice sidecar message: ${line}`);
      return;
    }

    if (message.kind === "ready") {
      if (isVoiceState(message.state)) {
        this.setState(message.state);
      }
      this.resolveReady?.();
      return;
    }

    if (message.kind === "event") {
      if (message.event === "voice.stateChanged" && isVoiceState(message.payload)) {
        this.setState(message.payload);
        return;
      }
      if (message.event === "voice.transcriptFinal" && isVoiceTranscriptEvent(message.payload)) {
        this.onTranscript(message.payload);
        return;
      }
      if (message.event === "voice.error") {
        const errorMessage =
          typeof message.payload === "string"
            ? message.payload
            : "Voice sidecar reported an unknown error.";
        this.setState(createUnsupportedState(errorMessage));
        return;
      }
      this.log("warn", `dropping unknown voice sidecar event: ${line}`);
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      this.log("warn", `dropping unmatched voice sidecar response for request ${message.id}`);
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result ?? null);
      return;
    }
    pending.reject(new Error(message.error ?? "Voice sidecar request failed."));
  }

  private async request<TCommand extends VoiceRuntimeCommand>(
    method: TCommand,
    params: unknown,
    timeoutMs = SIDECAR_COMMAND_TIMEOUT_MS,
  ): Promise<VoiceRuntimeCommandResultMap[TCommand]> {
    await this.ensureReady();
    const child = this.child;
    if (!child || !child.stdin) {
      throw new Error("Voice sidecar is not running.");
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message = JSON.stringify({ id, method, params: params ?? null });

    return new Promise<VoiceRuntimeCommandResultMap[TCommand]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Voice sidecar request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as VoiceRuntimeCommandResultMap[TCommand]),
        reject,
        timeout,
      });

      child.stdin!.write(`${message}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  private failPendingRequests(message: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingRequests.delete(id);
    }
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer || this.isRestarting) {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped || this.child) {
        return;
      }
      this.spawnSidecar();
    }, SIDECAR_RESTART_DELAY_MS);
    this.restartTimer.unref();
  }

  private setState(nextState: VoiceState): void {
    if (
      this.state.status === nextState.status &&
      this.state.modelId === nextState.modelId &&
      this.state.message === nextState.message
    ) {
      return;
    }
    this.state = nextState;
    this.onState(nextState);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.onLog?.(level, message);
  }
}
