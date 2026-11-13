/** The browser's own database (IndexedDB through Dexie). Every record here is also copied to the devbox. */
import Dexie, { type EntityTable } from "dexie";
import type { Role } from "../../shared/types";

type Base = { id: string; createdAt: number; updatedAt: number; deleted?: 0 | 1 };

export type NodeKind = "folder" | "thread" | "view";

/** A sidebar item: a folder, a thread or a side-by-side view. */
export type NodeRec = Base & {
  kind: NodeKind;
  parentId: string | null;
  order: string;
  title: string;
  collapsed?: boolean;
  systemPrompt?: string;
  sampleCount?: number;
  lastActivityAt?: number;
  lastSeenAt?: number;
};

export type MessageRec = Base & {
  threadId: string;
  order: string;
  role: Role;
  /** The text of a user message. AI messages keep their text in samples. */
  text: string;
  activeSampleId?: string;
};

export type RunStatus = "queued" | "running" | "done" | "error" | "stopped";

export type SampleRec = Base & {
  messageId: string;
  threadId: string;
  index: number;
  runId?: string;
  text: string;
  thinking?: string;
  status: RunStatus;
  error?: string;
  edited?: boolean;
  contextHash?: string;
  model?: string;
  retried?: boolean;
};

export type JudgeRec = Base & {
  name: string;
  prompt: string;
  seesContext: boolean;
  lowerIsBetter: boolean;
  revision: number;
  order: string;
};

export type AttachmentRec = Base & { judgeId: string; messageId: string; threadId: string };

export type ScoreRec = Base & {
  attachmentId: string;
  judgeId: string;
  threadId: string;
  /** The sample this score is for, or the message id for a user message. */
  targetId: string;
  runId?: string;
  value?: number;
  reason?: string;
  status: RunStatus;
  error?: string;
  judgeRevision: number;
  retried?: boolean;
  /** Set when the score was removed because its sample was replaced. Undo brings exactly these back. */
  removedWithSample?: boolean;
};

export type OutboxRec = { key: string; table: SyncedTable; id: string; updatedAt: number };

export type SyncedTable = "nodes" | "messages" | "samples" | "judges" | "attachments" | "scores";

export const SYNCED_TABLES: SyncedTable[] = ["nodes", "messages", "samples", "judges", "attachments", "scores"];

export type SyncedRecord = NodeRec | MessageRec | SampleRec | JudgeRec | AttachmentRec | ScoreRec;

class PlaygroundDb extends Dexie {
  nodes!: EntityTable<NodeRec, "id">;
  messages!: EntityTable<MessageRec, "id">;
  samples!: EntityTable<SampleRec, "id">;
  judges!: EntityTable<JudgeRec, "id">;
  attachments!: EntityTable<AttachmentRec, "id">;
  scores!: EntityTable<ScoreRec, "id">;
  outbox!: EntityTable<OutboxRec, "key">;

  constructor() {
    super("epistemics-playground");
    this.version(1).stores({
      nodes: "id, parentId, kind",
      messages: "id, threadId",
      samples: "id, messageId, threadId, status",
      judges: "id",
      attachments: "id, messageId, judgeId, threadId",
      scores: "id, attachmentId, targetId, threadId, status, judgeId",
      outbox: "key",
    });
  }
}

export const db = new PlaygroundDb();

export const live = <T extends { deleted?: 0 | 1 }>(rows: T[]): T[] => rows.filter((r) => !r.deleted);
