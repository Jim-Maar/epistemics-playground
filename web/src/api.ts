/** Talks to the API server on the devbox. */
import { useSyncExternalStore } from "react";

const PUBLIC_API_URL = "https://159-195-131-30.sslip.io/playground";
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

/** Opened from localhost, the app reaches the API through the dev server's /api path. */
export const API_URL: string = import.meta.env.VITE_API_URL ?? (isLocal ? "/api" : PUBLIC_API_URL);

const TOKEN_KEY = "playground.token";
const BROWSER_ID_KEY = "playground.browserId";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked in private windows. The app then works until the tab closes.
  }
}

let token = readStorage(TOKEN_KEY);
const tokenListeners = new Set<() => void>();

export function setToken(value: string | null) {
  token = value;
  writeStorage(TOKEN_KEY, value);
  for (const listener of tokenListeners) listener();
}

export function useToken(): string | null {
  return useSyncExternalStore(
    (listener) => {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    },
    () => token,
  );
}

export function browserId(): string {
  let id = readStorage(BROWSER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    writeStorage(BROWSER_ID_KEY, id);
  }
  return id;
}

export function resetBrowserId() {
  writeStorage(BROWSER_ID_KEY, null);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "Can't reach the devbox. Check that it is running, then try again.");
  }
  if (response.status === 401 && token && path !== "/auth/login") setToken(null);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? `The devbox answered with status ${response.status}.`);
  }
  return response;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await (await apiFetch(path, init)).json()) as T;
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
