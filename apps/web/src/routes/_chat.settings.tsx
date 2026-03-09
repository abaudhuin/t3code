import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { type ProviderKind, type VoiceModel, type VoiceSetupState } from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import { ZapIcon } from "lucide-react";

import {
  APP_SERVICE_TIER_OPTIONS,
  MAX_CUSTOM_MODEL_LENGTH,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { preferredTerminalEditor } from "../terminal-links";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SidebarInset } from "~/components/ui/sidebar";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
] as const;

function createInitialVoiceSetupState(): VoiceSetupState {
  return {
    status: "missing",
    modelId: "parakeet-tdt-0.6b-v3",
    modelPath: "",
    defaultModelPath: "",
    downloadUrl: null,
    downloadPercent: null,
    message: null,
  };
}

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
    default:
      return settings.customCodexModels;
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
    default:
      return { customCodexModels: models };
  }
}

function getVoiceStatusMessage(state: VoiceSetupState, isLoading: boolean, error: string | null): string {
  if (error) {
    return error;
  }
  if (isLoading) {
    return "Checking voice setup...";
  }
  if (state.status === "ready") {
    return "Voice is ready.";
  }
  if (state.status === "downloading") {
    return state.downloadPercent === null
      ? "Downloading voice model..."
      : `Downloading voice model... ${state.downloadPercent}%`;
  }
  if (state.message) {
    return state.message;
  }
  return "Voice is not configured yet.";
}

function getVoiceModelLabel(model: VoiceModel): string {
  return model.installed ? `${model.displayName} (installed)` : model.displayName;
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});
  const [voiceSetupState, setVoiceSetupState] = useState<VoiceSetupState>(createInitialVoiceSetupState);
  const [voiceModels, setVoiceModels] = useState<VoiceModel[]>([]);
  const [isVoiceSetupLoading, setIsVoiceSetupLoading] = useState(isElectron);
  const [isVoiceModelsLoading, setIsVoiceModelsLoading] = useState(isElectron);
  const [voiceModelPathInput, setVoiceModelPathInput] = useState("");
  const [isVoiceModelPathDirty, setIsVoiceModelPathDirty] = useState(false);
  const [voiceSetupError, setVoiceSetupError] = useState<string | null>(null);
  const [isSavingVoiceModelPath, setIsSavingVoiceModelPath] = useState(false);
  const [isInstallingVoiceModel, setIsInstallingVoiceModel] = useState(false);
  const [isChangingVoiceModel, setIsChangingVoiceModel] = useState(false);

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const codexServiceTier = settings.codexServiceTier;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const normalizedVoiceModelPathInput = voiceModelPathInput.trim();
  const selectedVoiceModel = voiceModels.find((model) => model.id === voiceSetupState.modelId) ?? null;
  const selectedVoiceModelInstalled = selectedVoiceModel?.installed ?? voiceSetupState.status === "ready";
  const voiceStatusMessage = getVoiceStatusMessage(
    voiceSetupState,
    isVoiceSetupLoading,
    voiceSetupError,
  );
  const isVoiceActionBusy =
    isVoiceSetupLoading ||
    isVoiceModelsLoading ||
    isSavingVoiceModelPath ||
    isInstallingVoiceModel ||
    isChangingVoiceModel;

  useEffect(() => {
    if (!isElectron) {
      return;
    }

    const api = ensureNativeApi();
    let cancelled = false;

    void api.voice
      .getSetupState()
      .then((state) => {
        if (cancelled) {
          return;
        }
        setVoiceSetupState(state);
        setIsVoiceSetupLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setIsVoiceSetupLoading(false);
        }
      });

    void api.voice
      .listModels()
      .then((models) => {
        if (cancelled) {
          return;
        }
        setVoiceModels(models);
        setIsVoiceModelsLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setIsVoiceModelsLoading(false);
        }
      });

    const unsubscribe = api.voice.onSetupState((state) => {
      if (cancelled) {
        return;
      }
      setVoiceSetupState(state);
      setIsVoiceSetupLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (isVoiceModelPathDirty) {
      return;
    }
    setVoiceModelPathInput(voiceSetupState.modelPath);
  }, [isVoiceModelPathDirty, voiceSetupState.modelPath]);

  const refreshVoiceModels = useCallback(async () => {
    if (!isElectron) {
      return;
    }
    setIsVoiceModelsLoading(true);
    try {
      const api = ensureNativeApi();
      setVoiceModels(await api.voice.listModels());
    } finally {
      setIsVoiceModelsLoading(false);
    }
  }, []);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void api.shell
      .openInEditor(keybindingsConfigPath, preferredTerminalEditor())
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const saveVoiceModelPath = useCallback(async () => {
    if (!isElectron) {
      return;
    }
    const nextPath = normalizedVoiceModelPathInput;
    if (nextPath.length === 0) {
      setVoiceSetupError("Enter a model directory path.");
      return;
    }
    setVoiceSetupError(null);
    setIsSavingVoiceModelPath(true);
    try {
      const api = ensureNativeApi();
      const nextState = await api.voice.setModelPath({ modelPath: nextPath });
      setVoiceSetupState(nextState);
      setVoiceModelPathInput(nextState.modelPath);
      setIsVoiceModelPathDirty(false);
      await refreshVoiceModels();
    } catch (error) {
      setVoiceSetupError(error instanceof Error ? error.message : "Unable to save voice model path.");
    } finally {
      setIsSavingVoiceModelPath(false);
    }
  }, [normalizedVoiceModelPathInput, refreshVoiceModels]);

  const chooseVoiceModelFolder = useCallback(async () => {
    if (!isElectron) {
      return;
    }
    setVoiceSetupError(null);
    try {
      const api = ensureNativeApi();
      const pickedFolder = await api.dialogs.pickFolder();
      if (!pickedFolder) {
        return;
      }
      setVoiceModelPathInput(pickedFolder);
      setIsVoiceModelPathDirty(true);
    } catch (error) {
      setVoiceSetupError(error instanceof Error ? error.message : "Unable to choose a voice model folder.");
    }
  }, []);

  const installVoiceModel = useCallback(async () => {
    if (!isElectron || selectedVoiceModelInstalled) {
      return;
    }
    setVoiceSetupError(null);
    setIsInstallingVoiceModel(true);
    try {
      const api = ensureNativeApi();
      if (
        normalizedVoiceModelPathInput.length > 0 &&
        normalizedVoiceModelPathInput !== voiceSetupState.modelPath
      ) {
        const nextState = await api.voice.setModelPath({ modelPath: normalizedVoiceModelPathInput });
        setVoiceSetupState(nextState);
        setVoiceModelPathInput(nextState.modelPath);
        setIsVoiceModelPathDirty(false);
      }
      await api.voice.installModel({ modelId: voiceSetupState.modelId });
      await refreshVoiceModels();
    } catch (error) {
      setVoiceSetupError(error instanceof Error ? error.message : "Unable to install the voice model.");
    } finally {
      setIsInstallingVoiceModel(false);
    }
  }, [
    normalizedVoiceModelPathInput,
    refreshVoiceModels,
    selectedVoiceModelInstalled,
    voiceSetupState.modelId,
    voiceSetupState.modelPath,
  ]);

  const setDefaultVoiceModel = useCallback(
    async (modelId: string) => {
      if (!isElectron || !modelId || modelId === voiceSetupState.modelId) {
        return;
      }
      setVoiceSetupError(null);
      setIsChangingVoiceModel(true);
      try {
        const api = ensureNativeApi();
        await api.voice.setDefaultModel({ modelId });
        await refreshVoiceModels();
      } catch (error) {
        setVoiceSetupError(error instanceof Error ? error.message : "Unable to change the voice model.");
      } finally {
        setIsChangingVoiceModel(false);
      }
    },
    [refreshVoiceModels, voiceSetupState.modelId],
  );

  const addCustomModel = useCallback((provider: ProviderKind) => {
    const customModelInput = customModelInputByProvider[provider];
    const customModels = getCustomModelsForProvider(settings, provider);
    const normalized = normalizeModelSlug(customModelInput, provider);
    if (!normalized) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "Enter a model slug.",
      }));
      return;
    }
    if (getModelOptions(provider).some((option) => option.slug === normalized)) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "That model is already built in.",
      }));
      return;
    }
    if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
      }));
      return;
    }
    if (customModels.includes(normalized)) {
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: "That custom model is already saved.",
      }));
      return;
    }

    updateSettings(patchCustomModels(provider, [...customModels, normalized]));
    setCustomModelInputByProvider((existing) => ({
      ...existing,
      [provider]: "",
    }));
    setCustomModelErrorByProvider((existing) => ({
      ...existing,
      [provider]: null,
    }));
  }, [customModelInputByProvider, settings, updateSettings]);

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(patchCustomModels(provider, customModels.filter((model) => model !== slug)));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Binary source:{" "}
                    <span className="font-medium text-foreground">{codexBinaryPath || "PATH"}</span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default service tier</span>
                  <Select
                    items={APP_SERVICE_TIER_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={codexServiceTier}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ codexServiceTier: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {APP_SERVICE_TIER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex min-w-0 items-center gap-2">
                            {option.value === "fast" ? (
                              <ZapIcon className="size-3.5 text-amber-500" />
                            ) : (
                              <span className="size-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{option.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {APP_SERVICE_TIER_OPTIONS.find((option) => option.value === codexServiceTier)
                      ?.description ?? "Use Codex defaults without forcing a service tier."}
                  </span>
                </label>

                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(
                                      provider,
                                      [...getDefaultCustomModelsForProvider(defaults, provider)],
                                    ),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    {provider === "codex" && shouldShowFastTierIcon(slug, codexServiceTier) ? (
                                      <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
                                    ) : null}
                                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      {slug}
                                    </code>
                                  </div>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Voice</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Configure local voice transcription for the desktop app.
                </p>
              </div>

              {!isElectron ? (
                <p className="text-xs text-muted-foreground">
                  Voice recording is only available in the desktop app.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border bg-background px-3 py-2">
                    <p className="text-xs font-medium text-foreground">Status</p>
                    <p className="mt-1 text-xs text-muted-foreground">{voiceStatusMessage}</p>
                  </div>

                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Default model</span>
                    {voiceModels.length > 0 ? (
                      <Select
                        items={voiceModels.map((model) => ({
                          label: getVoiceModelLabel(model),
                          value: model.id,
                        }))}
                        value={voiceSetupState.modelId}
                        onValueChange={(value) => {
                          if (!value) return;
                          void setDefaultVoiceModel(value);
                        }}
                        disabled={!isElectron || isVoiceModelsLoading || isChangingVoiceModel}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup alignItemWithTrigger={false}>
                          {voiceModels.map((model) => (
                            <SelectItem key={model.id} value={model.id}>
                              {getVoiceModelLabel(model)}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                        {isVoiceModelsLoading
                          ? "Loading voice models..."
                          : "No voice models available."}
                      </div>
                    )}
                  </label>

                  <label htmlFor="voice-model-path" className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">Model path</span>
                    <Input
                      id="voice-model-path"
                      value={voiceModelPathInput}
                      onChange={(event) => {
                        setVoiceModelPathInput(event.target.value);
                        setIsVoiceModelPathDirty(true);
                        if (voiceSetupError) {
                          setVoiceSetupError(null);
                        }
                      }}
                      placeholder={voiceSetupState.defaultModelPath || "/path/to/parakeet-model"}
                      spellCheck={false}
                    />
                    <span className="text-xs text-muted-foreground">
                      Path must contain <code>encoder-model.onnx</code>,{" "}
                      <code>decoder_joint-model.onnx</code>, and <code>vocab.txt</code>.
                    </span>
                  </label>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={chooseVoiceModelFolder}
                      disabled={isVoiceActionBusy}
                    >
                      Choose folder
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setVoiceModelPathInput(voiceSetupState.defaultModelPath);
                        setIsVoiceModelPathDirty(true);
                        setVoiceSetupError(null);
                      }}
                      disabled={!voiceSetupState.defaultModelPath || isVoiceActionBusy}
                    >
                      Use default path
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void saveVoiceModelPath()}
                      disabled={isVoiceActionBusy}
                    >
                      {isSavingVoiceModelPath ? "Saving..." : "Save path"}
                    </Button>
                  </div>

                  {!selectedVoiceModelInstalled ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">Install selected model</p>
                        <p className="text-xs text-muted-foreground">
                          Download the current model to the configured path.
                        </p>
                      </div>
                      <Button
                        type="button"
                        onClick={() => void installVoiceModel()}
                        disabled={isVoiceActionBusy || voiceSetupState.status === "downloading"}
                      >
                        {isInstallingVoiceModel || voiceSetupState.status === "downloading"
                          ? "Installing..."
                          : "Install model"}
                      </Button>
                    </div>
                  ) : null}

                  <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">Auto-send voice transcripts</p>
                      <p className="text-xs text-muted-foreground">
                        Send the transcribed prompt immediately after recording stops.
                      </p>
                    </div>
                    <Switch
                      checked={settings.autoSendVoiceTranscripts}
                      onCheckedChange={(checked) =>
                        updateSettings({
                          autoSendVoiceTranscripts: Boolean(checked),
                        })
                      }
                      aria-label="Auto-send voice transcripts"
                    />
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
