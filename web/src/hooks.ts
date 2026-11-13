/** Live views of the browser database for React components. */
import { useLiveQuery } from "dexie-react-hooks";
import { db, live, type AttachmentRec, type JudgeRec, type MessageRec, type NodeRec, type SampleRec, type ScoreRec } from "./db";

const byOrder = <T extends { order: string }>(a: T, b: T) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);

export type Tree = {
  byId: Map<string, NodeRec>;
  children: Map<string | null, NodeRec[]>;
};

export function buildTree(nodes: NodeRec[]): Tree {
  const byId = new Map<string, NodeRec>();
  const children = new Map<string | null, NodeRec[]>();
  const all = new Map(live(nodes).map((n) => [n.id, n]));
  const visit = (parentId: string | null) => {
    const kids = [...all.values()].filter((n) => n.parentId === parentId).sort(byOrder);
    children.set(parentId, kids);
    for (const kid of kids) {
      byId.set(kid.id, kid);
      visit(kid.id);
    }
  };
  visit(null);
  return { byId, children };
}

export function useTree(): Tree | undefined {
  return useLiveQuery(async () => buildTree(await db.nodes.toArray()), []);
}

export function threadIdsUnder(tree: Tree, nodeId: string): string[] {
  const node = tree.byId.get(nodeId);
  if (!node) return [];
  if (node.kind === "thread") return [node.id];
  return (tree.children.get(nodeId) ?? []).flatMap((child) => threadIdsUnder(tree, child.id));
}

export type ThreadData = {
  thread: NodeRec;
  messages: MessageRec[];
  samples: Map<string, SampleRec[]>;
  attachments: AttachmentRec[];
  scores: ScoreRec[];
  judges: Map<string, JudgeRec>;
};

export function assembleThread(
  thread: NodeRec, messages: MessageRec[], samples: SampleRec[], attachments: AttachmentRec[], scores: ScoreRec[], judges: JudgeRec[],
): ThreadData {
  const samplesByMessage = new Map<string, SampleRec[]>();
  for (const sample of live(samples).sort((a, b) => a.index - b.index)) {
    samplesByMessage.set(sample.messageId, [...(samplesByMessage.get(sample.messageId) ?? []), sample]);
  }
  return {
    thread,
    messages: live(messages).sort(byOrder),
    samples: samplesByMessage,
    attachments: live(attachments),
    scores: live(scores),
    judges: new Map(live(judges).map((j) => [j.id, j])),
  };
}

export function useThreadData(threadId: string): ThreadData | null | undefined {
  return useLiveQuery(async () => {
    const thread = await db.nodes.get(threadId);
    if (!thread || thread.deleted || thread.kind !== "thread") return null;
    const inThread = <T,>(table: "messages" | "samples" | "attachments" | "scores") =>
      db.table(table).where("threadId").equals(threadId).toArray() as Promise<T[]>;
    return assembleThread(
      thread,
      await inThread<MessageRec>("messages"),
      await inThread<SampleRec>("samples"),
      await inThread<AttachmentRec>("attachments"),
      await inThread<ScoreRec>("scores"),
      await db.judges.toArray(),
    );
  }, [threadId]);
}

export function useJudges(): JudgeRec[] {
  return useLiveQuery(async () => live(await db.judges.toArray()).sort(byOrder), []) ?? [];
}

/** Threads in which an answer or a score is still being produced. */
export function useRunningThreadIds(): Set<string> {
  return (
    useLiveQuery(async () => {
      const busy = ["queued", "running"];
      const samples = await db.samples.where("status").anyOf(busy).toArray();
      const scores = await db.scores.where("status").anyOf(busy).toArray();
      return new Set([...live(samples), ...live(scores)].map((r) => r.threadId));
    }, []) ?? new Set()
  );
}

export function useOutboxCount(): number {
  return useLiveQuery(() => db.outbox.count(), []) ?? 0;
}
