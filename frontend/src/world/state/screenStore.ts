import { create } from "zustand";

import { liveEvents } from "@/lib/events";
import { fetchScreens, type Screen } from "@/lib/screens";

interface ScreenState {
  screens: Record<string, Screen>;
  apply: (employeeId: string, screen: Screen | null) => void;
  load: () => Promise<void>;
}

export const useScreenStore = create<ScreenState>((set, get) => ({
  screens: {},
  apply: (employeeId, screen) => {
    const screens = { ...get().screens };
    if (screen) screens[employeeId] = screen;
    else delete screens[employeeId];
    set({ screens });
  },
  load: async () => {
    try {
      set({ screens: await fetchScreens() });
    } catch {
      /* offline: monitors show their idle state */
    }
  },
}));

/** Keeps desk-monitor content live; returns a stop function. */
export function startScreenSync(): () => void {
  const release = liveEvents.retain();
  const off = [
    liveEvents.on("employee.screen", (d) => {
      const { employee_id, screen } = d as { employee_id: string; screen: Screen | null };
      useScreenStore.getState().apply(employee_id, screen);
    }),
    liveEvents.onStatus((_s, reconnected) => reconnected && void useScreenStore.getState().load()),
  ];
  void useScreenStore.getState().load();
  return () => {
    off.forEach((f) => f());
    release();
  };
}
