import { create } from "zustand";

import { type AIModel, getAIModels, getAIRouting, type RouteInfo } from "@/lib/ai";

/** Model catalogue and per-employee routing, for pickers and panels. */
export const useAIStore = create<{
  models: AIModel[];
  routing: RouteInfo[];
  refresh: () => Promise<void>;
}>((set) => ({
  models: [],
  routing: [],
  refresh: async () => {
    try {
      const [models, routing] = await Promise.all([getAIModels(), getAIRouting()]);
      if (Array.isArray(models) && Array.isArray(routing)) set({ models, routing });
    } catch {
      /* AI settings unavailable: pickers simply show the inherit option */
    }
  },
}));
