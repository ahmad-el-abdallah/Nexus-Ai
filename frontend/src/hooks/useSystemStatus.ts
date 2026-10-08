"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchReadiness, fetchSystemInfo, type Readiness, type SystemInfo } from "@/lib/api";

export const POLL_INTERVAL_MS = 10_000;

export type SystemStatusState =
  | { kind: "loading" }
  | { kind: "online"; readiness: Readiness; info: SystemInfo | null; checkedAt: Date }
  | { kind: "offline"; reason: string; checkedAt: Date };

/** Fetches the current status; resolves to null if the request was superseded. */
async function loadStatus(signal: AbortSignal): Promise<SystemStatusState | null> {
  try {
    const [readiness, info] = await Promise.all([
      fetchReadiness(signal),
      fetchSystemInfo(signal).catch(() => null),
    ]);
    return { kind: "online", readiness, info, checkedAt: new Date() };
  } catch (error) {
    if ((error as Error).name === "AbortError") return null;
    return { kind: "offline", reason: (error as Error).message, checkedAt: new Date() };
  }
}

/** Polls the backend health endpoints and reports exactly what they return. */
export function useSystemStatus(intervalMs: number = POLL_INTERVAL_MS) {
  const [state, setState] = useState<SystemStatusState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const poll = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return loadStatus(controller.signal).then((next) => {
      if (next) setState(next);
    });
  }, []);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), intervalMs);
    return () => {
      window.clearInterval(timer);
      controllerRef.current?.abort();
    };
  }, [poll, intervalMs]);

  /** Manual re-check (from a button press). */
  const refresh = useCallback(() => {
    setRefreshing(true);
    return poll().finally(() => setRefreshing(false));
  }, [poll]);

  return { state, refreshing, refresh };
}
