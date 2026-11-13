/**
 * Runs one model call through a headless Claude Code (`claude -p`).
 * The API server uses this for the devbox, and the connector uses it on a friend's machine.
 * It only depends on Node built-ins, so it works under both Bun and Node.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SCORE_SCHEMA,
  parseJudgement,
  type ChatTurn,
  type Judgement,
  type RunEvent,
  type RunRequest,
  type UsageInfo,
} from "./types";

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_CHARS = 2000;

export type ClaudeRunOptions = {
  /** An empty folder. Claude Code would load a CLAUDE.md from here, so nothing may live in it. */
  sandboxDir: string;
  claudeBin?: string;
};

export function mergeConsecutiveTurns(turns: ChatTurn[]): ChatTurn[] {
  const merged: ChatTurn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last && last.role === turn.role) last.text = `${last.text}\n\n${turn.text}`;
    else merged.push({ ...turn });
  }
  return merged;
}

/** Claude Code keeps each folder's conversations in a project folder named after the path. */
function projectDirFor(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * Writes the earlier turns as a Claude Code session transcript, so `--resume` makes the model
 * see them as a real conversation, including AI turns that were written by hand.
 * Returns the session id and the transcript path.
 */
export function writeTranscript(cwd: string, history: ChatTurn[]): { sessionId: string; path: string } {
  const sessionId = randomUUID();
  const dir = projectDirFor(cwd);
  mkdirSync(dir, { recursive: true });
  let parentUuid: string | null = null;
  const lines = history.map((turn) => {
    const uuid = randomUUID();
    const message =
      turn.role === "user"
        ? { role: "user", content: turn.text }
        : {
            role: "assistant",
            type: "message",
            id: `msg_${uuid.replaceAll("-", "")}`,
            model: "claude-opus-5-5",
            content: [{ type: "text", text: turn.text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
    const line = {
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd,
      sessionId,
      type: turn.role,
      message,
      uuid,
      timestamp: new Date().toISOString(),
    };
    parentUuid = uuid;
    return JSON.stringify(line);
  });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { sessionId, path };
}

type PreparedCall = { prompt: string; args: string[]; transcriptPath?: string };

const BASE_ARGS = [
  "--model", "opus",
  "--effort", "high",
  "--setting-sources", "",
  "--strict-mcp-config",
  "--tools", "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
];

function prepareCall(request: RunRequest, sandboxDir: string): PreparedCall {
  if (request.kind === "judge") {
    return {
      prompt: request.prompt,
      args: [...BASE_ARGS, "--system-prompt", "", "--json-schema", JSON.stringify(SCORE_SCHEMA)],
    };
  }
  const turns = mergeConsecutiveTurns(request.turns);
  const last = turns.at(-1);
  if (!last || last.role !== "user") throw new Error("An answer needs a user message right before it.");
  const history = turns.slice(0, -1);
  const args = [...BASE_ARGS, "--system-prompt", request.systemPrompt];
  if (history.length === 0) return { prompt: last.text, args };
  const transcript = writeTranscript(sandboxDir, history);
  return { prompt: last.text, args: [...args, "--resume", transcript.sessionId], transcriptPath: transcript.path };
}

export function parseRateLimitEvent(info: Record<string, any>): UsageInfo {
  const windows = Object.entries((info.unifiedWindows ?? {}) as Record<string, any>).map(([name, w]) => ({
    name,
    utilization: typeof w.utilization === "number" ? w.utilization : 0,
    resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null,
  }));
  return { status: String(info.status ?? "unknown"), windows, updatedAt: Date.now() };
}

function rejectionMessage(usage: UsageInfo): string {
  const resets = usage.windows.map((w) => w.resetsAt).filter((t): t is number => t !== null);
  if (resets.length === 0) return "Usage limit reached.";
  const when = new Date(Math.max(...resets)).toLocaleString("en-GB", {
    weekday: "short", hour: "2-digit", minute: "2-digit",
  });
  return `Usage limit reached. Resets ${when}.`;
}

/** Turns stream-json lines into RunEvents. Holds the state of one run. */
class StreamParser {
  text = "";
  thinking = "";
  model = "";
  judgement: Judgement | null = null;
  final: RunEvent | null = null;
  constructor(private readonly request: RunRequest, private readonly emit: (event: RunEvent) => void) {}

  handleLine(line: string) {
    if (!line.trim()) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    switch (event.type) {
      case "system":
        if (event.subtype === "init" && typeof event.model === "string") {
          this.model = event.model;
          this.emit({ type: "started", model: event.model });
        }
        break;
      case "stream_event":
        this.handleStreamEvent(event.event ?? {});
        break;
      case "assistant":
        this.handleAssistantMessage(event.message ?? {});
        break;
      case "rate_limit_event":
        this.handleRateLimit(event.rate_limit_info ?? {});
        break;
      case "result":
        this.handleResult(event);
        break;
    }
  }

  private handleStreamEvent(streamEvent: Record<string, any>) {
    if (streamEvent.type !== "content_block_delta") return;
    const delta = streamEvent.delta ?? {};
    if (delta.type === "text_delta" && delta.text) {
      this.text += delta.text;
      this.emit({ type: "text", text: delta.text });
    } else if (delta.type === "thinking_delta" && delta.thinking) {
      this.thinking += delta.thinking;
      this.emit({ type: "thinking", text: delta.thinking });
    }
  }

  private handleAssistantMessage(message: Record<string, any>) {
    for (const block of message.content ?? []) {
      if (block.type === "tool_use" && block.name === "StructuredOutput") {
        this.judgement = parseJudgement(block.input);
      }
    }
  }

  private handleRateLimit(info: Record<string, any>) {
    const usage = parseRateLimitEvent(info);
    this.emit({ type: "usage", usage });
    if (usage.status === "rejected") this.final = { type: "error", message: rejectionMessage(usage) };
  }

  private handleResult(event: Record<string, any>) {
    if (this.final) return;
    if (event.is_error || event.subtype !== "success") {
      const detail = typeof event.result === "string" && event.result ? event.result : event.terminal_reason;
      this.final = { type: "error", message: `Claude Code failed: ${detail ?? "unknown error"}` };
      return;
    }
    if (this.request.kind === "judge") {
      const judgement = this.judgement ?? parseJudgement(event.structured_output);
      this.final = judgement
        ? { type: "done", text: "", thinking: this.thinking, model: this.model, judgement }
        : { type: "error", message: "The judge did not return a score from 0 to 1." };
      return;
    }
    const text = this.text || (typeof event.result === "string" ? event.result : "");
    this.final = { type: "done", text, thinking: this.thinking, model: this.model };
  }
}

/**
 * Runs the request and calls `emit` for every event. The last event is always "done" or "error".
 * Aborting the signal stops the process and keeps the text so far.
 */
export async function runClaude(
  request: RunRequest,
  emit: (event: RunEvent) => void,
  signal: AbortSignal,
  options: ClaudeRunOptions,
): Promise<void> {
  mkdirSync(options.sandboxDir, { recursive: true });
  let call: PreparedCall;
  try {
    call = prepareCall(request, options.sandboxDir);
  } catch (err) {
    emit({ type: "error", message: (err as Error).message });
    return;
  }
  const parser = new StreamParser(request, emit);
  let stderr = "";
  try {
    await new Promise<void>((resolve) => {
      const child = spawn(options.claudeBin ?? "claude", ["-p", call.prompt, ...call.args], {
        cwd: options.sandboxDir,
        env: { ...process.env, CLAUDE_NOTIFY_SILENT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const kill = () => child.kill("SIGTERM");
      const timeout = setTimeout(kill, RUN_TIMEOUT_MS);
      signal.addEventListener("abort", kill, { once: true });
      let buffered = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) parser.handleLine(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      });
      child.on("error", (err) => {
        parser.final ??= { type: "error", message: `Could not start Claude Code: ${err.message}` };
      });
      child.on("close", () => {
        parser.handleLine(buffered);
        clearTimeout(timeout);
        signal.removeEventListener("abort", kill);
        resolve();
      });
    });
  } finally {
    if (call.transcriptPath) rmSync(call.transcriptPath, { force: true });
  }
  if (signal.aborted) {
    emit({ type: "done", text: parser.text, thinking: parser.thinking, model: parser.model });
    return;
  }
  emit(parser.final ?? { type: "error", message: `Claude Code stopped without an answer. ${stderr.trim()}`.trim() });
}
