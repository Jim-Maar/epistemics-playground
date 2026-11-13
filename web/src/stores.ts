/** Small in-memory stores that React components subscribe to. */
import { useSyncExternalStore } from "react";
import type { Backend, UsageInfo } from "../../shared/types";
import { api } from "./api";

export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T | ((prev: T) => T)) {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: ReturnType<typeof createStore<T>>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

// ---------- What the server knows about this browser ----------

export type Me = {
  browserId: string;
  browserName: string;
  model: string;
  apiAvailable: boolean;
  runner: { connected: boolean; name: string | null };
  usage: { devbox: UsageInfo | null; own: UsageInfo | null };
  maxConcurrentRuns: number;
};

export const meStore = createStore<Me | null>(null);
const ME_POLL_MS = 20_000;
let mePoller: ReturnType<typeof setInterval> | null = null;

export async function refreshMe() {
  meStore.set(await api<Me>("/me"));
}

export function startMePolling() {
  if (mePoller) return;
  void refreshMe().catch(() => {});
  mePoller = setInterval(() => void refreshMe().catch(() => {}), ME_POLL_MS);
}

// ---------- Which backend runs this browser's model calls ----------

const BACKEND_KEY = "playground.backend";

function readBackend(): Backend {
  try {
    const value = localStorage.getItem(BACKEND_KEY);
    return value === "own" || value === "api" ? value : "devbox";
  } catch {
    return "devbox";
  }
}

export const backendStore = createStore<Backend>(readBackend());

export function setBackend(backend: Backend) {
  try {
    localStorage.setItem(BACKEND_KEY, backend);
  } catch {
    // The choice then lasts until the tab closes.
  }
  backendStore.set(backend);
}

// ---------- Toasts ----------

export type Toast = { id: number; text: string; action?: { label: string; run: () => void } };
export const toastStore = createStore<Toast[]>([]);
const TOAST_MS = 8000;
let toastId = 0;

export function toast(text: string, action?: Toast["action"]) {
  const id = ++toastId;
  toastStore.set((list) => [...list, { id, text, action }]);
  setTimeout(() => toastStore.set((list) => list.filter((t) => t.id !== id)), TOAST_MS);
}

export function dismissToast(id: number) {
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

// ---------- Sync state ----------

export const syncErrorStore = createStore<string | null>(null);
