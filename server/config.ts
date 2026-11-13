import { homedir } from "node:os";
import { join } from "node:path";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Put it in ~/dev/env/epistemics-playground/env.`);
  return value;
}

const DATA_DIR = process.env.PLAYGROUND_DATA_DIR ?? join(homedir(), ".local/share/epistemics-playground");

export const config = {
  port: Number(process.env.PLAYGROUND_PORT ?? 8095),
  passwordHash: Buffer.from(requireEnv("PLAYGROUND_PASSWORD_HASH_B64"), "base64").toString("utf8"),
  databaseUrl: requireEnv("DATABASE_URL"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  sandboxDir: join(DATA_DIR, "sandbox"),
  /** Runs at once per backend. One devbox run uses about 200 MB of memory. */
  maxConcurrentRuns: Number(process.env.PLAYGROUND_MAX_RUNS ?? 6),
  allowedOrigins: (
    process.env.PLAYGROUND_ALLOWED_ORIGINS ??
    "https://jim-maar.github.io,http://localhost:5173,http://localhost:4173"
  ).split(","),
};

export const SESSION_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
export const LOGIN_ATTEMPTS_PER_WINDOW = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const DRAIN_TIMEOUT_MS = 2 * 60 * 1000;
/** Finished runs stay in memory this long, so a reconnecting browser can replay their events. */
export const FINISHED_RUN_MEMORY_MS = 10 * 60 * 1000;
