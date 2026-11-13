/** The judge editor: name, prompt, options, a box to try the judge, and where it is attached. */
import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Copy, MoreHorizontal, Scale } from "lucide-react";
import { deleteJudge, duplicateJudge, rerunJudgeEverywhere, saveJudge } from "../actions";
import { judgePrompt } from "../context";
import { db, live, type JudgeRec } from "../db";
import { navigate } from "../routing";
import { runJudgeOnce } from "../runs";
import { formatScore, scoreColor } from "../scores";
import type { Judgement } from "../../../shared/types";
import { AutoTextarea, IconButton, Toggle, openMenu } from "./ui";
import type { ReactNode } from "react";

const PROMPT_MAX_HEIGHT = 420;

type Usage = { attachmentId: string; threadId: string; threadTitle: string; average: number | null; outOfDate: boolean };

function useJudgeUsage(judge: JudgeRec | undefined): Usage[] {
  return (
    useLiveQuery(async () => {
      if (!judge) return [];
      const attachments = live(await db.attachments.where("judgeId").equals(judge.id).toArray());
      const usage: Usage[] = [];
      for (const attachment of attachments) {
        const message = await db.messages.get(attachment.messageId);
        const thread = await db.nodes.get(attachment.threadId);
        if (!message || message.deleted || !thread || thread.deleted) continue;
        const scores = live(await db.scores.where("attachmentId").equals(attachment.id).toArray()).filter((s) => s.status === "done");
        const current = scores.filter((s) => s.judgeRevision === judge.revision && s.value !== undefined);
        usage.push({
          attachmentId: attachment.id,
          threadId: thread.id,
          threadTitle: thread.title,
          average: current.length ? current.reduce((sum, s) => sum + s.value!, 0) / current.length : null,
          outOfDate: current.length === 0 && scores.length > 0,
        });
      }
      return usage;
    }, [judge?.id, judge?.revision]) ?? []
  );
}

function TryIt({ judge }: { judge: JudgeRec }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ status: "idle" | "running" } | { status: "done"; judgement: Judgement } | { status: "error"; message: string }>({ status: "idle" });
  const run = async () => {
    setState({ status: "running" });
    try {
      setState({ status: "done", judgement: await runJudgeOnce(judgePrompt(judge, "assistant", text, [])) });
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  };
  return (
    <div className="field">
      <label htmlFor="judge-try">Try it</label>
      <AutoTextarea id="judge-try" className="input" placeholder="Paste any text to score it with the saved prompt." value={text} maxHeight={200} onChange={(event) => setText(event.target.value)} />
      <div className="row-actions">
        <button className="btn" disabled={!text.trim() || state.status === "running"} onClick={() => void run()}>
          {state.status === "running" ? "Scoring…" : "Run"}
        </button>
        {state.status === "done" && (
          <span className="chip static">
            Score <b>{formatScore(state.judgement.score)}</b>
            <span className="score-bar"><i style={{ width: `${state.judgement.score * 100}%`, background: scoreColor(state.judgement.score, judge.lowerIsBetter) }} /></span>
          </span>
        )}
      </div>
      {state.status === "done" && <p className="muted">{state.judgement.reason}</p>}
      {state.status === "error" && <p className="error-note">{state.message}</p>}
    </div>
  );
}

function AttachedTo({ judge, usage }: { judge: JudgeRec; usage: Usage[] }) {
  const outOfDate = usage.filter((u) => u.outOfDate).length;
  return (
    <div className="field">
      <label>Attached to</label>
      {usage.length === 0 && <p className="muted">Nothing yet. Attach this judge with the "Judge" chip under any message.</p>}
      {outOfDate > 0 && (
        <p className="notice">
          {outOfDate} {outOfDate === 1 ? "message has" : "messages have"} scores from an older prompt.{" "}
          <button className="link" onClick={() => void rerunJudgeEverywhere(judge.id)}>Rerun on {outOfDate === 1 ? "it" : `all ${outOfDate}`}</button>
        </p>
      )}
      {usage.map((item) => (
        <button key={item.attachmentId} className="list-row link-row" onClick={() => navigate({ page: "thread", id: item.threadId })}>
          <span className="grow row-name">{item.threadTitle}</span>
          <b className={item.outOfDate ? "muted" : ""}>{item.average !== null ? formatScore(item.average) : item.outOfDate ? "out of date" : "…"}</b>
        </button>
      ))}
    </div>
  );
}

function JudgeForm({ judge, leading }: { judge: JudgeRec; leading?: ReactNode }) {
  const [draft, setDraft] = useState({ name: judge.name, prompt: judge.prompt, seesContext: judge.seesContext, lowerIsBetter: judge.lowerIsBetter });
  useEffect(() => setDraft({ name: judge.name, prompt: judge.prompt, seesContext: judge.seesContext, lowerIsBetter: judge.lowerIsBetter }), [judge.id]);
  const usage = useJudgeUsage(judge);
  const dirty = draft.name !== judge.name || draft.prompt !== judge.prompt || draft.seesContext !== judge.seesContext || draft.lowerIsBetter !== judge.lowerIsBetter;
  const save = () => void saveJudge(judge, { ...draft, name: draft.name.trim() || judge.name });
  return (
    <section className="pane">
      <header className="pane-head">
        {leading}
        <Scale size={16} />
        <span className="pane-title static">{judge.name}</span>
        <span className="tag static">Revision {judge.revision}</span>
        <span className="spacer" />
        <button className="btn primary" disabled={!dirty} onClick={save}>{dirty ? "Save" : "Saved"}</button>
        <IconButton
          label="Judge menu"
          onClick={(event) =>
            openMenu(event, [
              { label: "Duplicate", icon: <Copy size={14} />, onSelect: () => void duplicateJudge(judge) },
              "separator",
              { label: "Delete", danger: true, onSelect: () => void deleteJudge(judge) },
            ])
          }
        >
          <MoreHorizontal size={16} />
        </IconButton>
      </header>
      <div className="conv">
        <div className="judge-grid">
          <div>
            <div className="field">
              <label htmlFor="judge-name">Name</label>
              <input id="judge-name" className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="judge-prompt">Prompt</label>
              <AutoTextarea
                id="judge-prompt" className="input mono" value={draft.prompt} maxHeight={PROMPT_MAX_HEIGHT}
                placeholder={"Say what to score and what 0 and 1 mean. For example:\nScore how clearly the answer corrects the false premise in the user's message.\n1 means it says the premise is false and explains why.\n0 means it accepts the premise."}
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              />
              <p className="muted small">The judge gets this prompt and the message. It answers with a score from 0 to 1 and a short reason. Saving a changed prompt marks old scores as out of date.</p>
            </div>
            <Toggle id="judge-context" checked={draft.seesContext} onChange={(seesContext) => setDraft({ ...draft, seesContext })} label="Also show the conversation before the message" />
            <Toggle id="judge-lower" checked={draft.lowerIsBetter} onChange={(lowerIsBetter) => setDraft({ ...draft, lowerIsBetter })} label="Lower is better (colors a low score green)" />
          </div>
          <div>
            <TryIt judge={judge} />
            <AttachedTo judge={judge} usage={usage} />
          </div>
        </div>
      </div>
    </section>
  );
}

export function JudgeEditor({ judgeId, leading }: { judgeId: string; leading?: ReactNode }) {
  const judge = useLiveQuery(async () => (await db.judges.get(judgeId)) ?? null, [judgeId]);
  if (judge === undefined) return <section className="pane" />;
  if (judge === null || judge.deleted) {
    return <section className="pane"><header className="pane-head">{leading}</header><div className="empty"><h2>This judge is gone</h2></div></section>;
  }
  return <JudgeForm key={judge.id} judge={judge} leading={leading} />;
}
