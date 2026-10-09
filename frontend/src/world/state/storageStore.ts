import { create } from "zustand";

import { fetchStorageOverview, type StorageOverview } from "@/lib/storage";

type LoadState = "idle" | "loading" | "ready" | "error";

export interface StorageState {
  overview: StorageOverview | null;
  load: LoadState;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useStorageStore = create<StorageState>((set) => ({
  overview: null,
  load: "idle",
  error: null,
  refresh: async () => {
    set({ load: "loading", error: null });
    try {
      set({ overview: await fetchStorageOverview(), load: "ready", error: null });
    } catch (error) {
      set({ overview: null, load: "error", error: (error as Error).message });
    }
  },
}));
