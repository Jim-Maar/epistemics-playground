/**
 * Starts model calls on the API server and follows their event streams. Streaming text lives in
 * memory while a run is going; the finished answer or score is then written to the database.
 */
import { useSyncExternalStore } from "react";
import type { JudgeRunRequest, Judgement, RunEvent, RunRequest, SampleRunRequest } from "../../shared/types";
import { ApiError, apiFetch, post } from "./api";
import { contextHash, judgePrompt, turnsBefore, usableText } from "./context";
import { db, live, type MessageRec, type SampleRec, type ScoreRec } from "./db";
import { messageSamples, save, threadMessages, touchThreadActivity, tx, uid, update } from "./repo";
import { backendStore, meStore } from "./stores";

const RECONNECT_DELAY_MS = 2000;
const RESTART_RETRY_DELAY_MS = 3000;
const RESTART_RETRIES = 40;
const INTERRUPTED_MESSAGE = "Interrupted by a server restart.";

export type Target = { table: "samples"; id: string } | { table: "scores"; id: string };

// ---------- Live streaming state ----------

export type LiveRun = { text: string; thinking: string; started: boolean; position?: number };

const liveRuns = new Map<string, LiveRun>();
const liveListeners = new Set<() => void>();
let liveVersion = 0;

function setLive(runId: string, change: (run: LiveRun) => LiveRun) {
  const current = liveRuns.get(runId) ?? { text: "", thinking: "", started: false };
  liveRuns.set(runId, change(current));
  liveVersion += 1;
  for (const listener of liveListeners) listener();
}

function clearLive(runId: string) {
  liveRuns.delete(runId);
  liveVersion += 1;
  for (const listener of liveListeners) listener();
}

export function useLiveRun(runId: string | undefined): LiveRun | undefined {
  useSyncExternalStore(
    (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    () => liveVersion,
  );
  return runId ? liveRuns.get(runId) : undefined;
}

// ---------- Building requests ----------

async function threadContext(threadId: string) {
  const messages = await threadMessages(threadId);
  const samplesByMessage = new Map<string, SampleRec[]>();
  for (const message of messages) {
    if (message.role === "assistant") samplesByMessage.set(message.id, await messageSamples(message.id));
  }
  const thread = await db.nodes.get(threadId);
  return { messages, samplesByMessage, systemPrompt: thread?.systemPrompt ?? "" };
}

type RunBody = Omit<SampleRunRequest, "id" | "backend"> | Omit<JudgeRunRequest, "id" | "backend">;
type Prepared = { request: RunBody; contextHash?: string } | { error: string };

async function prepareSample(sample: SampleRec): Promise<Prepared> {
  const { messages, samplesByMessage, systemPrompt } = await threadContext(sample.threadId);
  const turns = turnsBefore(messages, samplesByMessage, sample.messageId);
  if (turns.at(-1)?.role !== "user") return { error: "An answer needs a user message right before it." };
  return { request: { kind: "sample", systemPrompt, turns }, contextHash: contextHash(systemPrompt, turns) };
}

async function prepareScore(score: ScoreRec): Promise<Prepared> {
  const judge = await db.judges.get(score.judgeId);
  const attachment = await db.attachments.get(score.attachmentId);
  if (!judge || !attachment) return { error: "The judge was deleted." };
  const { messages, samplesByMessage } = await threadContext(score.threadId);
  const message = messages.find((m) => m.id === attachment.messageId);
  if (!message) return { error: "The message was deleted." };
  const text =
    message.role === "user" ? message.text : usableText((samplesByMessage.get(message.id) ?? []).find((s) => s.id === score.targetId));
  if (!text) return { error: "There is no text to score." };
  const before = turnsBefore(messages, samplesByMessage, message.id);
  return { request: { kind: "judge", prompt: judgePrompt(judge, message.role, text, before) } };
}

// ---------- Starting and following runs ----------

const following = new Set<string>();
const stopRequested = new Set<string>();

async function patchTarget(target: Target, changes: Partial<SampleRec & ScoreRec>) {
  await update(target.table, target.id, changes);
}

async function postWithRestartRetry(request: RunRequest) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await post("/runs", request);
      return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 503) || attempt >= RESTART_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RESTART_RETRY_DELAY_MS));
    }
  }
}

/** Starts a fresh run for a sample or score and follows it. */
export async function startRun(target: Target): Promise<void> {
  const record = await db.table(target.table).get(target.id);
  if (!record) return;
  const prepared = target.table === "samples" ? await prepareSample(record) : await prepareScore(record);
  if ("error" in prepared) {
    await patchTarget(target, { status: "error", error: prepared.error });
    return;
  }
  const runId = uid();
  await patchTarget(target, {
    runId, status: "queued", error: undefined, text: target.table === "samples" ? "" : undefined,
    ...(prepared.contextHash ? { contextHash: prepared.contextHash } : {}),
  } as Partial<SampleRec & ScoreRec>);
  try {
    await postWithRestartRetry({ ...prepared.request, id: runId, backend: backendStore.get() } as RunRequest);
  } catch (err) {
    await patchTarget(target, { status: "error", error: (err as Error).message });
    return;
  }
  void follow(runId, target);
}

async function* readEvents(response: Response): AsyncGenerator<{ seq: number; event: RunEvent }> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      let seq = 0;
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) seq = Number(line.slice(4));
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { seq, event: JSON.parse(data) as RunEvent };
    }
  }
}

async function follow(runId: string, target: Target) {
  if (following.has(runId)) return;
  following.add(runId);
  let after = 0;
  try {
    for (;;) {
      let response: Response;
      try {
        response = await apiFetch(`/runs/${runId}/stream?after=${after}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          await handleFailure(runId, target, INTERRUPTED_MESSAGE);
          return;
        }
        if (err instanceof ApiError && err.status === 401) return;
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
        continue;
      }
      try {
        for await (const { seq, event } of readEvents(response)) {
          after = Math.max(after, seq);
          if (await applyEvent(runId, target, event)) return;
        }
      } catch {
        // The connection dropped. Reconnect and replay from the last event.
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  } finally {
    following.delete(runId);
    clearLive(runId);
  }
}

/** Returns true when the run is over. */
async function applyEvent(runId: string, target: Target, event: RunEvent): Promise<boolean> {
  const current = await db.table(target.table).get(target.id);
  if (!current || current.runId !== runId) return true;
  switch (event.type) {
    case "queued":
      setLive(runId, (r) => ({ ...r, position: event.position }));
      return false;
    case "started":
      setLive(runId, (r) => ({ ...r, started: true, position: undefined }));
      if (current.status === "queued") await patchTarget(target, { status: "running", model: event.model });
      return false;
    case "text":
      setLive(runId, (r) => ({ ...r, text: r.text + event.text }));
      return false;
    case "thinking":
      setLive(runId, (r) => ({ ...r, thinking: r.thinking + event.text }));
      return false;
    case "usage": {
      const me = meStore.get();
      const key = backendStore.get() === "own" ? "own" : "devbox";
      if (me) meStore.set({ ...me, usage: { ...me.usage, [key]: event.usage } });
      return false;
    }
    case "done":
      await finishTarget(runId, target, event);
      return true;
    case "error":
      await handleFailure(runId, target, event.message);
      return true;
  }
}

async function finishTarget(runId: string, target: Target, event: Extract<RunEvent, { type: "done" }>) {
  const stopped = stopRequested.delete(runId);
  if (target.table === "samples") {
    await patchTarget(target, {
      status: stopped ? "stopped" : "done", text: event.text, thinking: event.thinking || undefined,
      model: event.model || undefined, error: undefined,
    });
    const sample = await db.samples.get(target.id);
    if (!sample) return;
    await touchThreadActivity(sample.threadId);
    if (event.text.trim()) await ensureScores(sample.messageId);
    return;
  }
  if (stopped || !event.judgement) {
    await patchTarget(target, { status: stopped ? "stopped" : "error", error: stopped ? undefined : "No score came back." });
    return;
  }
  await patchTarget(target, { status: "done", value: event.judgement.score, reason: event.judgement.reason, error: undefined });
}

async function handleFailure(runId: string, target: Target, message: string) {
  stopRequested.delete(runId);
  const record = await db.table(target.table).get(target.id);
  if (!record) return;
  const interrupted = message === INTERRUPTED_MESSAGE || message.includes("server restart");
  if (interrupted && !record.retried) {
    await patchTarget(target, { retried: true });
    await startRun(target);
    return;
  }
  await patchTarget(target, { status: "error", error: message });
}

export async function stopRun(runId: string | undefined) {
  if (!runId) return;
  stopRequested.add(runId);
  await post(`/runs/${runId}/stop`, {}).catch(() => {});
}

/** After a reload, keeps following runs that were still going and starts runs that never began. */
export async function resumePendingRuns() {
  const pending = async (table: "samples" | "scores") =>
    live(await db.table(table).where("status").anyOf(["queued", "running"]).toArray()) as (SampleRec | ScoreRec)[];
  for (const table of ["samples", "scores"] as const) {
    for (const record of await pending(table)) {
      const target = { table, id: record.id } as Target;
      if (record.runId) void follow(record.runId, target);
      else void startRun(target);
    }
  }
}

// ---------- Judges ----------

/**
 * Makes sure every judge attached to the message has a current score for every finished sample
 * (or for the text of a user message). Creates and starts the missing ones.
 */
export async function ensureScores(messageId: string) {
  const created = await tx(async () => {
    const message = await db.messages.get(messageId);
    if (!message || message.deleted) return [];
    const attachments = live(await db.attachments.where("messageId").equals(messageId).toArray());
    const targets = await scoreTargets(message);
    const scores = live(await db.scores.where("threadId").equals(message.threadId).toArray());
    const newScores: ScoreRec[] = [];
    for (const attachment of attachments) {
      const judge = await db.judges.get(attachment.judgeId);
      if (!judge || judge.deleted) continue;
      for (const targetId of targets) {
        const exists = scores.some(
          (s) => s.attachmentId === attachment.id && s.targetId === targetId && s.judgeRevision === judge.revision,
        );
        if (exists) continue;
        const now = Date.now();
        newScores.push(
          await save<ScoreRec>("scores", {
            id: uid(), attachmentId: attachment.id, judgeId: judge.id, threadId: message.threadId, targetId,
            status: "queued", judgeRevision: judge.revision, createdAt: now, updatedAt: now,
          }),
        );
      }
    }
    return newScores;
  });
  for (const score of created) void startRun({ table: "scores", id: score.id });
}

async function scoreTargets(message: MessageRec): Promise<string[]> {
  if (message.role === "user") return message.text.trim() ? [message.id] : [];
  return (await messageSamples(message.id)).filter((s) => usableText(s)).map((s) => s.id);
}

/** Removes the scores of a changed text, so the judges score the new version. */
export async function rescoreTarget(messageId: string, targetId: string) {
  await tx(async () => {
    const scores = live(await db.scores.where("targetId").equals(targetId).toArray());
    for (const score of scores) await save("scores", { ...score, deleted: 1 });
  });
  await ensureScores(messageId);
}

/** Starts fresh samples for an AI message. */
export function startSamples(samples: SampleRec[]) {
  for (const sample of samples) void startRun({ table: "samples", id: sample.id });
}

/** Runs a judge prompt once without saving anything. The judge editor's "Try it" uses this. */
export async function runJudgeOnce(prompt: string): Promise<Judgement> {
  const id = uid();
  await postWithRestartRetry({ id, kind: "judge", backend: backendStore.get(), prompt });
  const response = await apiFetch(`/runs/${id}/stream?after=0`);
  for await (const { event } of readEvents(response)) {
    if (event.type === "done" && event.judgement) return event.judgement;
    if (event.type === "error") throw new Error(event.message);
  }
  throw new Error("The run ended without a score.");
}
