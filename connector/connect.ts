/**
 * Connects your own Claude Code to the Epistemics Playground.
 * Run it with Node 22 or newer:  node connect.mjs <token>
 * While it runs, every model call from your browser runs on this machine with your Claude Code login.
 * Your threads are still saved on the playground's server.
 */
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { runClaude } from "../shared/claudeCli";
import { CONNECTOR_VERSION, type RunnerToServer, type ServerToRunner } from "../shared/types";

const DEFAULT_SERVER = "wss://159-195-131-30.sslip.io/playground";
const RECONNECT_DELAY_MS = 3000;
const SANDBOX_DIR = join(homedir(), ".epistemics-playground", "sandbox");

const token = process.argv[2];
const serverUrl = process.argv[3] ?? DEFAULT_SERVER;
if (!token) {
  console.error("Usage: node connect.mjs <token> [server url]\nCopy the command from Settings in the playground.");
  process.exit(1);
}

const activeRuns = new Map<string, AbortController>();

function connect() {
  const socket = new WebSocket(`${serverUrl}/runner/connect?token=${encodeURIComponent(token!)}`);
  const send = (message: RunnerToServer) => socket.send(JSON.stringify(message));

  socket.addEventListener("open", () => {
    console.log(`Connected. Model calls from your browser now run here, in ${SANDBOX_DIR}.`);
    send({ type: "hello", name: `Claude Code on ${hostname()}`, version: CONNECTOR_VERSION });
  });

  socket.addEventListener("message", (raw) => {
    const message = JSON.parse(String(raw.data)) as ServerToRunner;
    if (message.type === "stop") {
      activeRuns.get(message.id)?.abort();
      return;
    }
    const abort = new AbortController();
    activeRuns.set(message.id, abort);
    console.log(`Running a ${message.request.kind} (${activeRuns.size} running).`);
    void runClaude(
      message.request,
      (event) => {
        if (socket.readyState === WebSocket.OPEN) send({ type: "event", id: message.id, event });
      },
      abort.signal,
      { sandboxDir: SANDBOX_DIR },
    ).finally(() => activeRuns.delete(message.id));
  });

  socket.addEventListener("close", (event) => {
    for (const abort of activeRuns.values()) abort.abort();
    activeRuns.clear();
    if (event.code === 4000) {
      console.log("Another connector took over for this browser. Stopping here.");
      process.exit(0);
    }
    console.log(`Disconnected (${event.code}). Reconnecting in ${RECONNECT_DELAY_MS / 1000} s.`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  socket.addEventListener("error", () => {
    // The close event that follows handles the reconnect.
  });
}

connect();
