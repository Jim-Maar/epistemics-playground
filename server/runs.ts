/**
 * The run queue. Every model call is a run: it waits in its lane's queue, runs on one of the
 * three backends, and records every event so a browser can reconnect and replay it.
 */
import { runClaude } from "../shared/claudeCli";
import type { FinalRunEvent, RunEvent, RunRequest, UsageInfo } from "../shared/types";
import { runApi } from "./apiExecutor";
import { DRAIN_TIMEOUT_MS, FINISHED_RUN_MEMORY_MS, config } from "./config";
import { sql } from "./db";
import { HttpError } from "./http";
import { runOnRunner } from "./runnerHub";

type RunStatus = "queued" | "running" | "done" | "error" | "stopped";
type Listener = (seq: number, event: RunEvent) => void;

type RunState = {
  id: string;
  browserId: string;
  request: RunRequest;
  laneKey: string;
  status: RunStatus;
  events: RunEvent[];
  listeners: Set<Listener>;
  abort: AbortController;
  /** Database writes of this run, in order. */
  persisted: Promise<unknown>;
};

type Lane = { active: number; samples: RunState[]; judges: RunState[] };

const runs = new Map<string, RunState>();
const lanes = new Map<string, Lane>();
let devboxUsage: UsageInfo | null = null;
let draining = false;

export function latestDevboxUsage(): UsageInfo | null {
  return devboxUsage;
}

function laneKeyFor(browserId: string, request: RunRequest): string {
  return request.backend === "own" ? `own:${browserId}` : request.backend;
}

function laneFor(key: string): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { active: 0, samples: [], judges: [] };
    lanes.set(key, lane);
  }
  return lane;
}

function execute(run: RunState, emit: (event: RunEvent) => void): Promise<void> {
  const { request, abort } = run;
  switch (request.backend) {
    case "devbox":
      return runClaude(request, emit, abort.signal, { sandboxDir: config.sandboxDir });
    case "api":
      return runApi(request, emit, abort.signal);
    case "own":
      return runOnRunner(run.browserId, request, emit, abort.signal);
  }
}

function persist(run: RunState, write: () => Promise<unknown>) {
  run.persisted = run.persisted.then(write).catch((err) => console.error(`Saving run ${run.id} failed:`, err));
}

function isFinal(event: RunEvent): event is FinalRunEvent {
  return event.type === "done" || event.type === "error";
}

function record(run: RunState, event: RunEvent) {
  if (run.status !== "queued" && run.status !== "running") return;
  run.events.push(event);
  const seq = run.events.length;
  for (const listener of run.listeners) listener(seq, event);
  if (event.type === "usage" && run.request.backend === "devbox") devboxUsage = event.usage;
  if (isFinal(event)) finish(run, event);
}

function finish(run: RunState, event: FinalRunEvent) {
  const wasRunning = run.status === "running";
  run.status = event.type === "error" ? "error" : run.abort.signal.aborted ? "stopped" : "done";
  const done = event.type === "done" ? event : null;
  const status = run.status;
  persist(run, () => sql`
    update runs set status = ${status}, text = ${done?.text ?? ""}, thinking = ${done?.thinking ?? ""},
      model = ${done?.model ?? ""}, judgement = ${done?.judgement ? JSON.stringify(done.judgement) : null}::jsonb,
      error = ${event.type === "error" ? event.message : null}, finished_at = now()
    where id = ${run.id}`);
  setTimeout(() => runs.delete(run.id), FINISHED_RUN_MEMORY_MS);
  if (wasRunning) {
    const lane = laneFor(run.laneKey);
    lane.active -= 1;
    pump(run.laneKey);
  }
}

function start(run: RunState) {
  run.status = "running";
  laneFor(run.laneKey).active += 1;
  persist(run, () => sql`update runs set status = 'running' where id = ${run.id}`);
  execute(run, (event) => record(run, event))
    .catch((err: Error) => record(run, { type: "error", message: err.message }))
    .finally(() => record(run, { type: "error", message: "The run ended without an answer." }));
}

function announceQueuePositions(lane: Lane) {
  [...lane.samples, ...lane.judges].forEach((run, index) => record(run, { type: "queued", position: index + 1 }));
}

function pump(laneKey: string) {
  const lane = laneFor(laneKey);
  while (lane.active < config.maxConcurrentRuns) {
    const next = lane.samples.shift() ?? lane.judges.shift();
    if (!next) break;
    start(next);
  }
  announceQueuePositions(lane);
}

export function createRun(browserId: string, request: RunRequest): void {
  if (runs.has(request.id)) return;
  if (draining) throw new HttpError(503, "The server is restarting. Try again in a moment.");
  if (request.backend === "api" && !config.anthropicApiKey) {
    throw new HttpError(400, "API mode is off. Put ANTHROPIC_API_KEY in the env file on the devbox.");
  }
  const run: RunState = {
    id: request.id,
    browserId,
    request,
    laneKey: laneKeyFor(browserId, request),
    status: "queued",
    events: [],
    listeners: new Set(),
    abort: new AbortController(),
    persisted: Promise.resolve(),
  };
  runs.set(run.id, run);
  persist(run, () => sql`
    insert into runs (id, browser_id, kind, backend, status) values (${run.id}, ${browserId}, ${request.kind}, ${request.backend}, 'queued')`);
  const lane = laneFor(run.laneKey);
  (request.kind === "sample" ? lane.samples : lane.judges).push(run);
  pump(run.laneKey);
}

export function stopRun(browserId: string, id: string) {
  const run = runs.get(id);
  if (!run || run.browserId !== browserId) return;
  if (run.status === "queued") {
    const lane = laneFor(run.laneKey);
    lane.samples = lane.samples.filter((r) => r !== run);
    lane.judges = lane.judges.filter((r) => r !== run);
    run.abort.abort();
    record(run, { type: "done", text: "", thinking: "", model: "" });
    return;
  }
  run.abort.abort();
}

type StoredRun = {
  browser_id: string;
  status: RunStatus;
  text: string;
  thinking: string;
  model: string;
  judgement: { score: number; reason: string } | null;
  error: string | null;
};

function storedFinalEvent(row: StoredRun): FinalRunEvent | null {
  if (row.status === "error") return { type: "error", message: row.error ?? "The run failed." };
  if (row.status === "done" || row.status === "stopped") {
    return {
      type: "done",
      text: row.text,
      thinking: row.thinking,
      model: row.model,
      ...(row.judgement ? { judgement: row.judgement } : {}),
    };
  }
  return null;
}

export type RunSubscription = { replay: RunEvent[]; startSeq: number; live: boolean; unsubscribe: () => void };

/** Replays the events after `after` and, while the run is live, delivers new ones. */
export async function subscribe(browserId: string, id: string, after: number, listener: Listener): Promise<RunSubscription> {
  const run = runs.get(id);
  if (run && run.browserId === browserId) {
    const live = run.status === "queued" || run.status === "running";
    if (live) run.listeners.add(listener);
    return {
      replay: run.events.slice(after),
      startSeq: after,
      live,
      unsubscribe: () => run.listeners.delete(listener),
    };
  }
  const [row] = (await sql`select * from runs where id = ${id}`) as StoredRun[];
  const final = row && row.browser_id === browserId ? storedFinalEvent(row) : null;
  if (!final) throw new HttpError(404, "This run is unknown. It was probably cut off by a server restart.");
  return { replay: [final], startSeq: 0, live: false, unsubscribe: () => {} };
}

function liveRunCount(): number {
  return [...runs.values()].filter((r) => r.status === "queued" || r.status === "running").length;
}

/** Stops taking new runs and waits for the running ones, for at most two minutes. */
export async function drain(): Promise<void> {
  draining = true;
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (liveRunCount() > 0 && Date.now() < deadline) await Bun.sleep(500);
}
