import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const VOICE_STATE_CHANNEL = "desktop:voice-state";
const VOICE_SETUP_STATE_CHANNEL = "desktop:voice-setup-state";
const VOICE_TRANSCRIPT_CHANNEL = "desktop:voice-transcript";
const VOICE_GET_STATE_CHANNEL = "desktop:voice-get-state";
const VOICE_GET_SETUP_STATE_CHANNEL = "desktop:voice-get-setup-state";
const VOICE_LIST_MODELS_CHANNEL = "desktop:voice-list-models";
const VOICE_INSTALL_MODEL_CHANNEL = "desktop:voice-install-model";
const VOICE_SET_MODEL_PATH_CHANNEL = "desktop:voice-set-model-path";
const VOICE_SET_DEFAULT_MODEL_CHANNEL = "desktop:voice-set-default-model";
const VOICE_START_RECORDING_CHANNEL = "desktop:voice-start-recording";
const VOICE_STOP_RECORDING_CHANNEL = "desktop:voice-stop-recording";
const VOICE_CANCEL_RECORDING_CHANNEL = "desktop:voice-cancel-recording";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  voice: {
    getState: () => ipcRenderer.invoke(VOICE_GET_STATE_CHANNEL),
    getSetupState: () => ipcRenderer.invoke(VOICE_GET_SETUP_STATE_CHANNEL),
    listModels: () => ipcRenderer.invoke(VOICE_LIST_MODELS_CHANNEL),
    installModel: (input) => ipcRenderer.invoke(VOICE_INSTALL_MODEL_CHANNEL, input),
    setModelPath: (input) => ipcRenderer.invoke(VOICE_SET_MODEL_PATH_CHANNEL, input),
    setDefaultModel: (input) => ipcRenderer.invoke(VOICE_SET_DEFAULT_MODEL_CHANNEL, input),
    startRecording: () => ipcRenderer.invoke(VOICE_START_RECORDING_CHANNEL),
    stopRecording: () => ipcRenderer.invoke(VOICE_STOP_RECORDING_CHANNEL),
    cancelRecording: () => ipcRenderer.invoke(VOICE_CANCEL_RECORDING_CHANNEL),
    onState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(VOICE_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(VOICE_STATE_CHANNEL, wrappedListener);
      };
    },
    onSetupState: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(VOICE_SETUP_STATE_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(VOICE_SETUP_STATE_CHANNEL, wrappedListener);
      };
    },
    onTranscript: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
        if (typeof event !== "object" || event === null) return;
        listener(event as Parameters<typeof listener>[0]);
      };

      ipcRenderer.on(VOICE_TRANSCRIPT_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(VOICE_TRANSCRIPT_CHANNEL, wrappedListener);
      };
    },
  },
} satisfies DesktopBridge);
