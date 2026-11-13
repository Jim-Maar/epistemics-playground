/**
 * Every write to the browser database goes through here. Each write also adds an outbox entry
 * in the same transaction, which the sync loop later sends to the devbox.
 */
import { generateKeyBetween } from "fractional-indexing";
import type { Role } from "../../shared/types";
import {
  SYNCED_TABLES,
  db,
  live,
  type AttachmentRec,
  type JudgeRec,
  type MessageRec,
  type NodeKind,
  type NodeRec,
  type SampleRec,
  type ScoreRec,
  type SyncedRecord,
  type SyncedTable,
} from "./db";

export const DEFAULT_THREAD_TITLE = "New thread";
const THREAD_TITLE_WORDS = 7;

export const uid = () => crypto.randomUUID();

export function tx<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction("rw", [...SYNCED_TABLES.map((t) => db.table(t)), db.outbox], fn);
}

/** Writes a record and queues it for the devbox. Call it inside `tx`. */
export async function save<T extends SyncedRecord>(table: SyncedTable, record: T): Promise<T> {
  const saved = { ...record, updatedAt: Math.max(Date.now(), record.updatedAt + 1) };
  await db.table(table).put(saved);
  await db.outbox.put({ key: `${table}:${saved.id}`, table, id: saved.id, updatedAt: saved.updatedAt });
  return saved;
}

async function patch<T extends SyncedRecord>(table: SyncedTable, id: string, changes: Partial<T>): Promise<T | undefined> {
  const current = (await db.table(table).get(id)) as T | undefined;
  if (!current) return undefined;
  return save(table, { ...current, ...changes });
}

export const update = <T extends SyncedRecord>(table: SyncedTable, id: string, changes: Partial<T>) =>
  tx(() => patch<T>(table, id, changes));

function stamp(): { createdAt: number; updatedAt: number } {
  const now = Date.now();
  return { createdAt: now, updatedAt: now };
}

// ---------- Sidebar tree ----------

export async function childrenOf(parentId: string | null): Promise<NodeRec[]> {
  const rows =
    parentId === null
      ? await db.nodes.filter((n) => n.parentId === null).toArray()
      : await db.nodes.where("parentId").equals(parentId).toArray();
  return live(rows).sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
}

async function firstOrder(parentId: string | null): Promise<string> {
  const siblings = await childrenOf(parentId);
  return generateKeyBetween(null, siblings[0]?.order ?? null);
}

async function orderAfter(node: NodeRec): Promise<string> {
  const siblings = await childrenOf(node.parentId);
  const index = siblings.findIndex((s) => s.id === node.id);
  return generateKeyBetween(node.order, siblings[index + 1]?.order ?? null);
}

export function createNode(kind: NodeKind, parentId: string | null, title: string): Promise<NodeRec> {
  return tx(async () =>
    save<NodeRec>("nodes", { id: uid(), kind, parentId, title, order: await firstOrder(parentId), ...stamp() }),
  );
}

export async function isInside(nodeId: string, ancestorId: string): Promise<boolean> {
  let current = await db.nodes.get(nodeId);
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = await db.nodes.get(current.parentId);
  }
  return false;
}

/** A view with fewer than two threads turns back into a plain thread. */
async function dissolveViewIfSmall(viewId: string | null) {
  if (!viewId) return;
  const view = await db.nodes.get(viewId);
  if (!view || view.kind !== "view" || view.deleted) return;
  const threads = await childrenOf(view.id);
  if (threads.length >= 2) return;
  for (const thread of threads) await save("nodes", { ...thread, parentId: view.parentId, order: view.order });
  await save("nodes", { ...view, deleted: 1 });
}

export type DropPlace = { parentId: string | null; beforeId?: string; afterId?: string };

async function orderForPlace(place: DropPlace, movingId: string): Promise<string> {
  const siblings = (await childrenOf(place.parentId)).filter((s) => s.id !== movingId);
  const anchorId = place.beforeId ?? place.afterId;
  const index = siblings.findIndex((s) => s.id === anchorId);
  if (index < 0) return generateKeyBetween(siblings.at(-1)?.order ?? null, null);
  if (place.beforeId) return generateKeyBetween(siblings[index - 1]?.order ?? null, siblings[index]!.order);
  return generateKeyBetween(siblings[index]!.order, siblings[index + 1]?.order ?? null);
}

export function moveNode(id: string, place: DropPlace): Promise<void> {
  return tx(async () => {
    const node = await db.nodes.get(id);
    if (!node) return;
    if (place.parentId === id || (place.parentId && (await isInside(place.parentId, id)))) return;
    const target = place.parentId ? await db.nodes.get(place.parentId) : null;
    if (target?.kind === "view" && node.kind !== "thread") return;
    const oldParent = node.parentId;
    await save("nodes", { ...node, parentId: place.parentId, order: await orderForPlace(place, id) });
    if (oldParent !== place.parentId) await dissolveViewIfSmall(oldParent);
  });
}

/** Dropping a thread on a thread puts both in a side-by-side view. Returns the view id. */
export function mergeIntoView(draggedId: string, targetId: string): Promise<string | null> {
  return tx(async () => {
    const dragged = await db.nodes.get(draggedId);
    const target = await db.nodes.get(targetId);
    if (!dragged || !target || dragged.id === target.id || dragged.kind !== "thread") return null;
    const oldParent = dragged.parentId;
    if (target.kind === "view") {
      await save("nodes", { ...dragged, parentId: target.id, order: await orderForPlace({ parentId: target.id }, dragged.id) });
      await dissolveViewIfSmall(oldParent);
      return target.id;
    }
    const targetParent = target.parentId ? await db.nodes.get(target.parentId) : null;
    if (targetParent?.kind === "view") {
      await save("nodes", {
        ...dragged, parentId: targetParent.id, order: await orderForPlace({ parentId: targetParent.id, afterId: target.id }, dragged.id),
      });
      if (oldParent !== targetParent.id) await dissolveViewIfSmall(oldParent);
      return targetParent.id;
    }
    const view = await save<NodeRec>("nodes", {
      id: uid(), kind: "view", parentId: target.parentId, order: target.order,
      title: `${target.title} + ${dragged.title}`, ...stamp(),
    });
    const first = generateKeyBetween(null, null);
    await save("nodes", { ...target, parentId: view.id, order: first });
    await save("nodes", { ...dragged, parentId: view.id, order: generateKeyBetween(first, null) });
    if (oldParent !== target.parentId) await dissolveViewIfSmall(oldParent);
    return view.id;
  });
}

export async function subtreeIds(rootId: string): Promise<string[]> {
  const ids = [rootId];
  for (const child of await childrenOf(rootId)) ids.push(...(await subtreeIds(child.id)));
  return ids;
}

export function setNodeDeleted(id: string, deleted: boolean): Promise<void> {
  return tx(async () => {
    const node = await db.nodes.get(id);
    if (!node) return;
    await save("nodes", { ...node, deleted: deleted ? 1 : 0 });
    if (deleted) await dissolveViewIfSmall(node.parentId);
  });
}

/** Deleting a view keeps its threads: they move to where the view was. */
export function deleteViewKeepThreads(viewId: string): Promise<string[]> {
  return tx(async () => {
    const view = await db.nodes.get(viewId);
    if (!view) return [];
    const threads = await childrenOf(viewId);
    let order = view.order;
    for (const thread of threads) {
      await save("nodes", { ...thread, parentId: view.parentId, order });
      order = generateKeyBetween(order, null);
    }
    await save("nodes", { ...view, deleted: 1 });
    return threads.map((t) => t.id);
  });
}

// ---------- Copying threads (duplicate, share import, browser import) ----------

export type Graph = {
  nodes: NodeRec[];
  messages: MessageRec[];
  samples: SampleRec[];
  attachments: AttachmentRec[];
  scores: ScoreRec[];
  judges: JudgeRec[];
};

export async function graphOf(rootId: string): Promise<Graph> {
  const ids = await subtreeIds(rootId);
  const nodes = live(await db.nodes.bulkGet(ids).then((r) => r.filter((n): n is NodeRec => Boolean(n))));
  const threadIds = nodes.filter((n) => n.kind === "thread").map((n) => n.id);
  const byThread = async <T extends { deleted?: 0 | 1 }>(table: SyncedTable) =>
    live((await db.table(table).where("threadId").anyOf(threadIds).toArray()) as T[]);
  return {
    nodes,
    messages: await byThread<MessageRec>("messages"),
    samples: await byThread<SampleRec>("samples"),
    attachments: await byThread<AttachmentRec>("attachments"),
    scores: await byThread<ScoreRec>("scores"),
    judges: [],
  };
}

/**
 * Saves a copy of the graph with new ids under `parentId`. Running answers become "stopped",
 * because their runs belong to the original. Judges are added only if this browser lacks them.
 */
export async function insertCopy(graph: Graph, rootIds: string[], parentId: string | null, order: string, retitle: boolean) {
  const idMap = new Map<string, string>();
  const newId = (old: string) => {
    let id = idMap.get(old);
    if (!id) {
      id = uid();
      idMap.set(old, id);
    }
    return id;
  };
  const mapped = (old: string | undefined) => (old ? newId(old) : undefined);
  const now = stamp();
  for (const judge of graph.judges) {
    if (!(await db.judges.get(judge.id))) await save("judges", { ...judge, ...now });
  }
  let nextOrder = order;
  for (const node of graph.nodes) {
    const isRoot = rootIds.includes(node.id);
    await save<NodeRec>("nodes", {
      ...node,
      ...now,
      id: newId(node.id),
      parentId: isRoot ? parentId : (mapped(node.parentId ?? undefined) ?? null),
      order: isRoot ? nextOrder : node.order,
      title: isRoot && retitle ? `Copy of ${node.title}` : node.title,
    });
    if (isRoot) nextOrder = generateKeyBetween(nextOrder, null);
  }
  for (const m of graph.messages) {
    await save<MessageRec>("messages", { ...m, ...now, id: newId(m.id), threadId: newId(m.threadId), activeSampleId: mapped(m.activeSampleId) });
  }
  for (const s of graph.samples) {
    const unfinished = s.status === "queued" || s.status === "running";
    await save<SampleRec>("samples", {
      ...s, ...now, id: newId(s.id), messageId: newId(s.messageId), threadId: newId(s.threadId),
      runId: undefined, status: unfinished ? "stopped" : s.status,
    });
  }
  for (const a of graph.attachments) {
    await save<AttachmentRec>("attachments", { ...a, ...now, id: newId(a.id), messageId: newId(a.messageId), threadId: newId(a.threadId) });
  }
  for (const s of graph.scores) {
    if (s.status !== "done") continue;
    await save<ScoreRec>("scores", {
      ...s, ...now, id: newId(s.id), attachmentId: newId(s.attachmentId), threadId: newId(s.threadId),
      targetId: newId(s.targetId), runId: undefined,
    });
  }
  return rootIds.map((id) => idMap.get(id)!);
}

export function duplicateNode(id: string): Promise<string | undefined> {
  return tx(async () => {
    const node = await db.nodes.get(id);
    if (!node) return undefined;
    const graph = await graphOf(id);
    const [copyId] = await insertCopy(graph, [id], node.parentId, await orderAfter(node), true);
    return copyId;
  });
}

// ---------- Messages ----------

export async function threadMessages(threadId: string): Promise<MessageRec[]> {
  return live(await db.messages.where("threadId").equals(threadId).toArray()).sort((a, b) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
  );
}

export async function messageSamples(messageId: string): Promise<SampleRec[]> {
  return live(await db.samples.where("messageId").equals(messageId).toArray()).sort((a, b) => a.index - b.index);
}

async function orderBetweenMessages(threadId: string, afterId: string | null): Promise<string> {
  const messages = await threadMessages(threadId);
  if (afterId === null) return generateKeyBetween(null, messages[0]?.order ?? null);
  const index = messages.findIndex((m) => m.id === afterId);
  if (index < 0) return generateKeyBetween(messages.at(-1)?.order ?? null, null);
  return generateKeyBetween(messages[index]!.order, messages[index + 1]?.order ?? null);
}

function titleFrom(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, THREAD_TITLE_WORDS).join(" ");
  return words.length > 0 ? words : DEFAULT_THREAD_TITLE;
}

async function nameThreadIfNew(threadId: string, text: string) {
  const thread = await db.nodes.get(threadId);
  if (thread && thread.title === DEFAULT_THREAD_TITLE && text.trim()) {
    await save("nodes", { ...thread, title: titleFrom(text) });
  }
}

/** Adds a message after `afterId` (or at the start for null). AI messages get one sample. */
export function insertMessage(
  threadId: string, afterId: string | null, role: Role, text: string, samples: Partial<SampleRec>[] = [],
): Promise<{ message: MessageRec; samples: SampleRec[] }> {
  return tx(async () => {
    const messageId = uid();
    const created: SampleRec[] = [];
    for (const [index, sample] of samples.entries()) {
      created.push(
        await save<SampleRec>("samples", {
          id: uid(), messageId, threadId, index, text: "", status: "queued", ...stamp(), ...sample,
        }),
      );
    }
    const message = await save<MessageRec>("messages", {
      id: messageId, threadId, role, text: role === "user" ? text : "", activeSampleId: created[0]?.id,
      order: await orderBetweenMessages(threadId, afterId), ...stamp(),
    });
    if (role === "user") await nameThreadIfNew(threadId, text);
    return { message, samples: created };
  });
}

export function setMessageDeleted(id: string, deleted: boolean) {
  return update<MessageRec>("messages", id, { deleted: deleted ? 1 : 0 });
}

async function removeScoresOf(sampleIds: string[]) {
  for (const score of live(await db.scores.where("targetId").anyOf(sampleIds).toArray())) {
    await save<ScoreRec>("scores", { ...score, deleted: 1, removedWithSample: true });
  }
}

async function bringBackScoresOf(sampleIds: string[]) {
  const scores = await db.scores.where("targetId").anyOf(sampleIds).toArray();
  for (const score of scores.filter((s) => s.removedWithSample)) {
    await save<ScoreRec>("scores", { ...score, deleted: 0, removedWithSample: false });
  }
}

/** Replaces the given samples of a message with fresh queued ones. Returns the new samples. */
export function replaceSamples(messageId: string, oldIds: string[], count: number): Promise<SampleRec[]> {
  return tx(async () => {
    const message = await db.messages.get(messageId);
    if (!message) return [];
    const existing = await messageSamples(messageId);
    const replaced = existing.filter((s) => oldIds.includes(s.id));
    for (const sample of replaced) await save("samples", { ...sample, deleted: 1 });
    await removeScoresOf(replaced.map((s) => s.id));
    const kept = existing.filter((s) => !oldIds.includes(s.id));
    const usedIndexes = new Set(kept.map((s) => s.index));
    const freeIndexes = replaced.map((s) => s.index);
    let next = Math.max(-1, ...existing.map((s) => s.index)) + 1;
    const created: SampleRec[] = [];
    for (let i = 0; i < count; i += 1) {
      let index = freeIndexes.shift();
      while (index === undefined || usedIndexes.has(index)) index = next++;
      usedIndexes.add(index);
      created.push(
        await save<SampleRec>("samples", {
          id: uid(), messageId, threadId: message.threadId, index, text: "", status: "queued", ...stamp(),
        }),
      );
    }
    const activeStillThere = kept.some((s) => s.id === message.activeSampleId);
    if (!activeStillThere && created[0]) await save("messages", { ...message, activeSampleId: created[0].id });
    return created;
  });
}

export function restoreSamples(restoreIds: string[], removeIds: string[]) {
  return tx(async () => {
    for (const id of restoreIds) await patch<SampleRec>("samples", id, { deleted: 0 });
    for (const id of removeIds) await patch<SampleRec>("samples", id, { deleted: 1 });
    await bringBackScoresOf(restoreIds);
    await removeScoresOf(removeIds);
  });
}

export function touchThreadActivity(threadId: string) {
  return update<NodeRec>("nodes", threadId, { lastActivityAt: Date.now() });
}

// ---------- Judges ----------

export function createJudge(name: string): Promise<JudgeRec> {
  return tx(async () => {
    const judges = live(await db.judges.toArray()).sort((a, b) => (a.order < b.order ? -1 : 1));
    return save<JudgeRec>("judges", {
      id: uid(), name, prompt: "", seesContext: false, lowerIsBetter: false, revision: 1,
      order: generateKeyBetween(judges.at(-1)?.order ?? null, null), ...stamp(),
    });
  });
}

export function attachJudge(judgeId: string, message: MessageRec): Promise<AttachmentRec> {
  return tx(async () => {
    const existing = live(await db.attachments.where("messageId").equals(message.id).toArray()).find((a) => a.judgeId === judgeId);
    if (existing) return existing;
    return save<AttachmentRec>("attachments", { id: uid(), judgeId, messageId: message.id, threadId: message.threadId, ...stamp() });
  });
}

export function deleteScoresFor(filter: (s: ScoreRec) => boolean, scores: ScoreRec[]) {
  return tx(async () => {
    for (const score of scores.filter(filter)) await save("scores", { ...score, deleted: 1 });
  });
}
