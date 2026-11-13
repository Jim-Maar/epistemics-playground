/** Types shared by the web app, the API server and the connector. */

export type Role = "user" | "assistant";

export type ChatTurn = { role: Role; text: string };

/** Where a browser's model calls run. */
export type Backend = "devbox" | "own" | "api";

export const BACKEND_LABELS: Record<Backend, string> = {
  devbox: "Devbox Claude Code",
  own: "My own Claude Code",
  api: "Anthropic API",
};

export type SampleRunRequest = {
  id: string;
  kind: "sample";
  backend: Backend;
  systemPrompt: string;
  turns: ChatTurn[];
};

export type JudgeRunRequest = {
  id: string;
  kind: "judge";
  backend: Backend;
  prompt: string;
};

export type RunRequest = SampleRunRequest | JudgeRunRequest;

export type Judgement = { score: number; reason: string };

export type UsageWindow = { name: string; utilization: number; resetsAt: number | null };

export type UsageInfo = { status: string; windows: UsageWindow[]; updatedAt: number };

export type RunEvent =
  | { type: "queued"; position: number }
  | { type: "started"; model: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "usage"; usage: UsageInfo }
  | { type: "done"; text: string; thinking: string; model: string; judgement?: Judgement }
  | { type: "error"; message: string };

export type FinalRunEvent = Extract<RunEvent, { type: "done" | "error" }>;

export const MODEL_LABEL = "Opus 5.5 · High";

export const MAX_SAMPLES = 5;

export const SCORE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["score", "reason"],
  additionalProperties: false,
} as const;

/** Messages sent over the WebSocket between the API server and a connected Claude Code. */
export type ServerToRunner =
  | { type: "run"; id: string; request: RunRequest }
  | { type: "stop"; id: string };

export type RunnerToServer =
  | { type: "hello"; name: string; version: number }
  | { type: "event"; id: string; event: RunEvent };

export const CONNECTOR_VERSION = 1;

export function parseJudgement(value: unknown): Judgement | null {
  if (typeof value !== "object" || value === null) return null;
  const { score, reason } = value as Record<string, unknown>;
  if (typeof score !== "number" || score < 0 || score > 1) return null;
  return { score, reason: typeof reason === "string" ? reason : "" };
}
