/** What the buttons do. Each action changes the database, starts runs where needed, and offers Undo. */
import { generateKeyBetween } from "fractional-indexing";
import { MAX_SAMPLES } from "../../shared/types";
import { db, live, type AttachmentRec, type JudgeRec, type MessageRec, type NodeRec, type SampleRec } from "./db";
import { threadIdsUnder, type Tree } from "./hooks";
import {
  DEFAULT_THREAD_TITLE,
  attachJudge,
  createNode,
  deleteViewKeepThreads,
  duplicateNode,
  insertMessage,
  mergeIntoView,
  messageSamples,
  moveNode,
  replaceSamples,
  restoreSamples,
  save,
  setMessageDeleted,
  setNodeDeleted,
  threadMessages,
  tx,
  update,
} from "./repo";
import { currentRoute, navigate } from "./routing";
import { ensureScores, rescoreTarget, startSamples, stopRun } from "./runs";
import { createStore, toast } from "./stores";

/** The message whose text is open in an edit box. */
export const editingStore = createStore<string | null>(null);
/** The sidebar item whose name is open in an edit box. */
export const renamingStore = createStore<string | null>(null);

// ---------- Threads, folders, views ----------

export async function newThread(parentId: string | null): Promise<void> {
  const thread = await createNode("thread", parentId, DEFAULT_THREAD_TITLE);
  navigate({ page: "thread", id: thread.id });
}

export async function newFolder(parentId: string | null): Promise<void> {
  const folder = await createNode("folder", parentId, "New folder");
  if (parentId) await update<NodeRec>("nodes", parentId, { collapsed: false });
  renamingStore.set(folder.id);
}

export function routeFor(node: NodeRec) {
  return node.kind === "view" ? ({ page: "view", id: node.id } as const) : ({ page: "thread", id: node.id } as const);
}

function leaveIfOpen(ids: string[]) {
  const route = currentRoute();
  if ((route.page === "thread" || route.page === "view") && ids.includes(route.id)) navigate({ page: "home" });
}

export async function deleteNode(node: NodeRec, tree: Tree): Promise<void> {
  if (node.kind === "view") {
    const threadIds = await deleteViewKeepThreads(node.id);
    leaveIfOpen([node.id]);
    toast(`View deleted. Its ${threadIds.length} threads were kept.`, {
      label: "Undo",
      run: () =>
        void tx(async () => {
          await save("nodes", { ...node, deleted: 0 });
          for (const id of threadIds) {
            const thread = await db.nodes.get(id);
            if (thread) await save("nodes", { ...thread, parentId: node.id });
          }
        }),
    });
    return;
  }
  const threadCount = threadIdsUnder(tree, node.id).length;
  await setNodeDeleted(node.id, true);
  leaveIfOpen([node.id, ...threadIdsUnder(tree, node.id)]);
  const what = node.kind === "folder" ? `Folder deleted with ${threadCount} ${threadCount === 1 ? "thread" : "threads"}.` : "Thread deleted.";
  toast(what, { label: "Undo", run: () => void setNodeDeleted(node.id, false) });
}

export async function duplicate(node: NodeRec): Promise<void> {
  const copyId = await duplicateNode(node.id);
  if (!copyId) return;
  const copy = await db.nodes.get(copyId);
  toast(`${node.kind === "folder" ? "Folder" : node.kind === "view" ? "View" : "Thread"} duplicated.`, {
    label: "Open",
    run: () => copy && copy.kind !== "folder" && navigate(routeFor(copy)),
  });
}

export async function openSideBySide(draggedId: string, targetId: string): Promise<void> {
  const viewId = await mergeIntoView(draggedId, targetId);
  if (viewId) navigate({ page: "view", id: viewId });
}

/** Takes a thread out of its view and puts it right after the view. */
export async function removeFromView(thread: NodeRec): Promise<void> {
  const view = thread.parentId ? await db.nodes.get(thread.parentId) : undefined;
  if (!view || view.kind !== "view") return;
  await moveNode(thread.id, { parentId: view.parentId, afterId: view.id });
  const viewAfter = await db.nodes.get(view.id);
  if (viewAfter?.deleted) navigate({ page: "thread", id: thread.id });
}

// ---------- Sending and generating ----------

async function previousAssistant(threadId: string, beforeMessageId: string): Promise<MessageRec | undefined> {
  const messages = await threadMessages(threadId);
  const index = messages.findIndex((m) => m.id === beforeMessageId);
  return messages.slice(0, index).reverse().find((m) => m.role === "assistant");
}

async function liveAttachments(messageId: string): Promise<AttachmentRec[]> {
  return live(await db.attachments.where("messageId").equals(messageId).toArray());
}

/** A new answer gets the judges of the answer before it, so a judged thread stays judged. */
async function inheritJudges(message: MessageRec) {
  const previous = await previousAssistant(message.threadId, message.id);
  if (!previous) return;
  for (const attachment of await liveAttachments(previous.id)) await attachJudge(attachment.judgeId, message);
}

export async function inheritedJudgeCount(threadId: string): Promise<number> {
  const lastAssistant = (await threadMessages(threadId)).reverse().find((m) => m.role === "assistant");
  return lastAssistant ? (await liveAttachments(lastAssistant.id)).length : 0;
}

export async function generateAnswer(threadId: string, afterMessageId: string, count: number): Promise<void> {
  const { message, samples } = await insertMessage(
    threadId, afterMessageId, "assistant", "", Array.from({ length: count }, () => ({})),
  );
  await inheritJudges(message);
  startSamples(samples);
}

export async function sendMessage(threadId: string, text: string, count: number, generate: boolean): Promise<void> {
  const last = (await threadMessages(threadId)).at(-1);
  const { message } = await insertMessage(threadId, last?.id ?? null, "user", text);
  if (generate) await generateAnswer(threadId, message.id, count);
}

export async function insertManualMessage(threadId: string, afterId: string | null, role: "user" | "assistant") {
  const manualSample: Partial<SampleRec>[] = role === "assistant" ? [{ status: "done", edited: true }] : [];
  const { message } = await insertMessage(threadId, afterId, role, "", manualSample);
  editingStore.set(message.id);
}

// ---------- Resampling ----------

async function stopSamples(samples: SampleRec[]) {
  for (const sample of samples) {
    if (sample.status === "queued" || sample.status === "running") await stopRun(sample.runId);
  }
}

async function swapSamples(message: MessageRec, replaceIds: string[], count: number, undoText: string) {
  const before = await messageSamples(message.id);
  await stopSamples(before.filter((s) => replaceIds.includes(s.id)));
  const created = await replaceSamples(message.id, replaceIds, count);
  startSamples(created);
  toast(undoText, {
    label: "Undo",
    run: () =>
      void (async () => {
        await stopSamples(created);
        await restoreSamples(replaceIds, created.map((s) => s.id));
        await update<MessageRec>("messages", message.id, { activeSampleId: message.activeSampleId });
      })(),
  });
}

export async function resampleAll(message: MessageRec) {
  const samples = await messageSamples(message.id);
  await swapSamples(message, samples.map((s) => s.id), Math.max(1, samples.length), "Resampled.");
}

export const resampleOne = (message: MessageRec, sampleId: string) => swapSamples(message, [sampleId], 1, "Sample resampled.");

export async function addSample(message: MessageRec) {
  if ((await messageSamples(message.id)).length >= MAX_SAMPLES) return;
  await swapSamples(message, [], 1, "Sample added.");
}

export async function stopThread(threadId: string) {
  const samples = live(await db.samples.where("threadId").equals(threadId).toArray());
  await stopSamples(samples);
}

// ---------- Editing and deleting messages ----------

export async function saveUserEdit(message: MessageRec, text: string, resampleNext: MessageRec | null) {
  await update<MessageRec>("messages", message.id, { text });
  editingStore.set(null);
  await rescoreTarget(message.id, message.id);
  if (resampleNext) await resampleAll(resampleNext);
}

export async function saveSampleEdit(sample: SampleRec, text: string) {
  await stopSamples([sample]);
  await update<SampleRec>("samples", sample.id, { text, edited: true, status: "done", error: undefined, runId: undefined });
  editingStore.set(null);
  await rescoreTarget(sample.messageId, sample.id);
}

export async function deleteMessage(message: MessageRec) {
  await stopSamples(await messageSamples(message.id));
  await setMessageDeleted(message.id, true);
  if (editingStore.get() === message.id) editingStore.set(null);
  toast("Message deleted.", { label: "Undo", run: () => void setMessageDeleted(message.id, false) });
}

/** An insert that was cancelled before any text was typed leaves no empty message behind. */
export async function cancelEdit(message: MessageRec) {
  editingStore.set(null);
  const samples = await messageSamples(message.id);
  const empty = message.role === "user" ? !message.text.trim() : samples.every((s) => !s.text.trim() && s.edited);
  if (empty) await setMessageDeleted(message.id, true);
}

// ---------- Judges ----------

export async function attach(judge: JudgeRec, message: MessageRec) {
  await attachJudge(judge.id, message);
  await ensureScores(message.id);
}

export async function detach(attachment: AttachmentRec) {
  await update<AttachmentRec>("attachments", attachment.id, { deleted: 1 });
}

async function dropScores(attachmentId: string) {
  await tx(async () => {
    for (const score of live(await db.scores.where("attachmentId").equals(attachmentId).toArray())) {
      await save("scores", { ...score, deleted: 1 });
    }
  });
}

export async function rerunJudge(attachment: AttachmentRec) {
  await dropScores(attachment.id);
  await ensureScores(attachment.messageId);
}

export async function saveJudge(judge: JudgeRec, changes: Pick<JudgeRec, "name" | "prompt" | "seesContext" | "lowerIsBetter">) {
  const changesScores = changes.prompt !== judge.prompt || changes.seesContext !== judge.seesContext;
  await update<JudgeRec>("judges", judge.id, { ...changes, revision: judge.revision + (changesScores ? 1 : 0) });
}

export async function rerunJudgeEverywhere(judgeId: string) {
  for (const attachment of live(await db.attachments.where("judgeId").equals(judgeId).toArray())) {
    const message = await db.messages.get(attachment.messageId);
    if (message && !message.deleted) await ensureScores(message.id);
  }
}

export async function deleteJudge(judge: JudgeRec) {
  await update<JudgeRec>("judges", judge.id, { deleted: 1 });
  if (currentRoute().page === "judge") navigate({ page: "home" });
  toast("Judge deleted.", { label: "Undo", run: () => void update<JudgeRec>("judges", judge.id, { deleted: 0 }) });
}

export async function duplicateJudge(judge: JudgeRec) {
  const now = Date.now();
  const copy = await tx(() =>
    save<JudgeRec>("judges", {
      ...judge, id: crypto.randomUUID(), name: `Copy of ${judge.name}`, revision: 1,
      order: generateKeyBetween(judge.order, null), createdAt: now, updatedAt: now,
    }),
  );
  navigate({ page: "judge", id: copy.id });
}
