/**
 * Connected Claude Codes: a friend runs connect.mjs on their machine, it opens a WebSocket here,
 * and the runs of their browser go to it instead of the devbox.
 */
import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { RunEvent, RunRequest, RunnerToServer, ServerToRunner, UsageInfo } from "../shared/types";
import { sql } from "./db";

export type RunnerSocketData = { browserId: string };

type Runner = {
  socket: ServerWebSocket<RunnerSocketData>;
  name: string;
  connectedAt: number;
  usage: UsageInfo | null;
  activeRuns: Map<string, (event: RunEvent) => void>;
};

const runners = new Map<string, Runner>();

export async function runnerToken(browserId: string): Promise<string> {
  const [row] = await sql`
    insert into runners (browser_id, token) values (${browserId}, ${randomBytes(24).toString("hex")})
    on conflict (browser_id) do update set browser_id = excluded.browser_id
    returning token`;
  return row.token;
}

export async function browserForRunnerToken(token: string): Promise<string | null> {
  if (!token) return null;
  const [row] = await sql`select browser_id from runners where token = ${token}`;
  return row?.browser_id ?? null;
}

export function runnerStatus(browserId: string): { connected: boolean; name: string | null; usage: UsageInfo | null } {
  const runner = runners.get(browserId);
  return { connected: Boolean(runner), name: runner?.name ?? null, usage: runner?.usage ?? null };
}

function send(socket: ServerWebSocket<RunnerSocketData>, message: ServerToRunner) {
  socket.send(JSON.stringify(message));
}

export const runnerSocketHandlers = {
  open(socket: ServerWebSocket<RunnerSocketData>) {
    const previous = runners.get(socket.data.browserId);
    previous?.socket.close(4000, "Replaced by a newer connection.");
    runners.set(socket.data.browserId, {
      socket, name: "Claude Code", connectedAt: Date.now(), usage: null, activeRuns: new Map(),
    });
  },
  message(socket: ServerWebSocket<RunnerSocketData>, raw: string | Buffer) {
    const runner = runners.get(socket.data.browserId);
    if (!runner || runner.socket !== socket) return;
    let message: RunnerToServer;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.type === "hello") {
      runner.name = message.name;
      return;
    }
    const emit = runner.activeRuns.get(message.id);
    if (!emit) return;
    if (message.event.type === "usage") runner.usage = message.event.usage;
    emit(message.event);
  },
  close(socket: ServerWebSocket<RunnerSocketData>) {
    const runner = runners.get(socket.data.browserId);
    if (!runner || runner.socket !== socket) return;
    runners.delete(socket.data.browserId);
    for (const emit of runner.activeRuns.values()) {
      emit({ type: "error", message: "Your Claude Code disconnected during this run." });
    }
  },
};

/** Sends a run to the browser's connected Claude Code and resolves when it finishes. */
export function runOnRunner(
  browserId: string,
  request: RunRequest,
  emit: (event: RunEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const runner = runners.get(browserId);
  if (!runner) {
    emit({ type: "error", message: "Your Claude Code is not connected. Open Settings to connect it." });
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      runner.activeRuns.delete(request.id);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => send(runner.socket, { type: "stop", id: request.id });
    runner.activeRuns.set(request.id, (event) => {
      emit(event);
      if (event.type === "done" || event.type === "error") finish();
    });
    signal.addEventListener("abort", stop, { once: true });
    send(runner.socket, { type: "run", id: request.id, request });
  });
}
