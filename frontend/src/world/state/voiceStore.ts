import { create } from "zustand";

import { liveEvents } from "@/lib/events";
import { fetchVoice, installVoiceModel, removeVoiceModel, updateVoiceSettings, type VoiceModel, type VoiceOverview, type VoiceSettings } from "@/lib/voice";

export interface VoiceState {
  overview: VoiceOverview | null;
  load: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refresh: () => Promise<void>;
  configure: (changes: Partial<VoiceSettings>) => Promise<void>;
  install: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  overview: null,
  load: "idle",
  error: null,
  refresh: async () => {
    if (get().load === "idle") set({ load: "loading" });
    try {
      set({ overview: await fetchVoice(), load: "ready", error: null });
    } catch (error) {
      set({ load: "error", error: (error as Error).message });
    }
  },
  configure: async (changes) => set({ overview: await updateVoiceSettings(changes) }),
  install: async (id) => set({ overview: await installVoiceModel(id) }),
  remove: async (id) => set({ overview: await removeVoiceModel(id) }),
}));

/** Loads voice status and follows live updates (download progress, settings). */
export function startVoiceSync(): () => void {
  const store = useVoiceStore;
  const release = liveEvents.retain();
  const off = [
    liveEvents.on("voice.updated", (d) => {
      const current = store.getState().overview;
      const status = d as { engine: string; models: VoiceModel[] };
      if (current) store.setState({ overview: { ...current, ...status } });
      else void store.getState().refresh();
    }),
    liveEvents.on("voice.settings", (d) => {
      const current = store.getState().overview;
      if (current) store.setState({ overview: { ...current, settings: d as VoiceSettings } });
    }),
    liveEvents.onStatus((_s, reconnected) => reconnected && void store.getState().refresh()),
  ];
  void store.getState().refresh();
  return () => {
    off.forEach((f) => f());
    release();
  };
}
