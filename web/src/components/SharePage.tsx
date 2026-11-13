/** A shared thread, opened through its link: read-only, kept up to date, and not in the sidebar. */
import { useEffect, useState } from "react";
import { Copy, Eye } from "lucide-react";
import { MODEL_LABEL } from "../../../shared/types";
import { ApiError, api } from "../api";
import type { AttachmentRec, JudgeRec, MessageRec, NodeRec, SampleRec, ScoreRec } from "../db";
import { assembleThread, type ThreadData } from "../hooks";
import { childrenOf, insertCopy, tx } from "../repo";
import { navigate } from "../routing";
import { toast } from "../stores";
import { generateKeyBetween } from "fractional-indexing";
import { MessageList } from "./Messages";
import { SystemPrompt } from "./ThreadPane";

const REFRESH_MS = 4000;

type Entity = { kind: string; data: unknown };
type SharedThread = { browserName: string; threadId: string; entities: Entity[] };

function ofKind<T>(entities: Entity[], kind: string): T[] {
  return entities.filter((e) => e.kind === kind).map((e) => e.data as T);
}

function toThreadData(shared: SharedThread): ThreadData | null {
  const thread = ofKind<NodeRec>(shared.entities, "nodes").find((n) => n.id === shared.threadId);
  if (!thread) return null;
  return assembleThread(
    thread,
    ofKind<MessageRec>(shared.entities, "messages"),
    ofKind<SampleRec>(shared.entities, "samples"),
    ofKind<AttachmentRec>(shared.entities, "attachments"),
    ofKind<ScoreRec>(shared.entities, "scores"),
    ofKind<JudgeRec>(shared.entities, "judges"),
  );
}

async function duplicateToMyThreads(data: ThreadData) {
  const usedJudgeIds = new Set(data.attachments.map((a) => a.judgeId));
  const [copyId] = await tx(async () =>
    insertCopy(
      {
        nodes: [data.thread],
        messages: data.messages,
        samples: [...data.samples.values()].flat(),
        attachments: data.attachments,
        scores: data.scores,
        judges: [...data.judges.values()].filter((j) => usedJudgeIds.has(j.id)),
      },
      [data.thread.id],
      null,
      generateKeyBetween(null, (await childrenOf(null))[0]?.order ?? null),
      false,
    ),
  );
  toast("Copied to your threads.");
  if (copyId) navigate({ page: "thread", id: copyId });
}

export function SharePage({ shareId }: { shareId: string }) {
  const [shared, setShared] = useState<SharedThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      api<SharedThread>(`/shares/${shareId}/view`)
        .then((result) => !stopped && (setShared(result), setError(null)))
        .catch((err: Error) => {
          if (stopped) return;
          const gone = err instanceof ApiError && (err.status === 404 || err.status === 410);
          if (gone || !shared) setError(err.message);
          if (gone) clearInterval(timer);
        });
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [shareId]);

  const data = shared && toThreadData(shared);
  if (error && !data) {
    return (
      <section className="pane">
        <div className="empty"><h2>{error}</h2><p><a href="#/">Go to your threads</a></p></div>
      </section>
    );
  }
  if (!shared || !data) return <section className="pane" />;
  return (
    <section className="pane">
      <div className="share-banner">
        <Eye size={15} />
        <span>Shared from <b>{shared.browserName}</b>. Read only.</span>
        <span className="spacer" />
        <a className="btn ghost" href="#/">My threads</a>
        <button className="btn primary" onClick={() => void duplicateToMyThreads(data)}><Copy size={14} />Duplicate to my threads</button>
      </div>
      <header className="pane-head">
        <span className="pane-title static">{data.thread.title}</span>
        <span className="tag static">{MODEL_LABEL}</span>
      </header>
      <div className="conv">
        <div className="conv-col">
          <SystemPrompt thread={data.thread} readOnly forceOpen={false} />
          <MessageList data={data} readOnly />
        </div>
      </div>
    </section>
  );
}
