/** The row of judge scores under a message, with the popovers to attach a judge and to see details. */
import { useState, type MouseEvent } from "react";
import { Plus, Scale } from "lucide-react";
import { attach, detach, rerunJudge } from "../actions";
import type { AttachmentRec, JudgeRec, MessageRec } from "../db";
import { useJudges, useThreadData, type ThreadData } from "../hooks";
import { createJudge } from "../repo";
import { navigate } from "../routing";
import { formatScore, scoreColor, summarize, type ScoreSummary } from "../scores";
import { closePopover, openPopover } from "./ui";

function ScoreBar({ value, lowerIsBetter }: { value: number; lowerIsBetter: boolean }) {
  return (
    <span className="score-bar" aria-hidden="true">
      <i style={{ width: `${Math.round(value * 100)}%`, background: scoreColor(value, lowerIsBetter) }} />
    </span>
  );
}

function chipValue(summary: ScoreSummary): string {
  if (summary.average === null) return summary.pending ? "…" : summary.failed ? "failed" : "no score";
  const progress = summary.doneCount < summary.targetCount ? ` · ${summary.doneCount}/${summary.targetCount}` : "";
  return `${formatScore(summary.average)}${progress}`;
}

function ScoreDetails({ threadId, attachmentId }: { threadId: string; attachmentId: string }) {
  const data = useThreadData(threadId);
  const attachment = data?.attachments.find((a) => a.id === attachmentId);
  const judge = attachment && data?.judges.get(attachment.judgeId);
  const message = attachment && data?.messages.find((m) => m.id === attachment.messageId);
  if (!data || !attachment || !judge || !message) return null;
  const summary = summarize(attachment, judge, message, data.samples.get(message.id) ?? [], data.scores);
  const running = summary.targets.filter((t) => t.score?.status === "queued" || t.score?.status === "running").length;
  return (
    <div className="score-details">
      <h3>{judge.name}</h3>
      <p className="muted">
        {summary.average === null ? "No score yet" : `Average ${formatScore(summary.average)} over ${summary.doneCount} of ${summary.targetCount}`}
        {running > 0 && ` · ${running} still running`}
        {summary.outOfDate && " · out of date"}
      </p>
      {summary.targets.map((target) => (
        <div key={target.targetId} className="score-row">
          <span className="score-row-label">{target.label}</span>
          <span className="score-row-reason">
            {target.score?.status === "error"
              ? target.score.error
              : target.score?.status === "done"
                ? target.score.reason
                : target.score
                  ? "Scoring…"
                  : "Not scored yet"}
          </span>
          <span className="score-row-value">{target.score?.value !== undefined ? formatScore(target.score.value) : ""}</span>
        </div>
      ))}
      <div className="row-actions">
        <button className="btn" onClick={() => void rerunJudge(attachment)}>Rerun</button>
        <button
          className="btn ghost"
          onClick={() => {
            closePopover();
            navigate({ page: "judge", id: judge.id });
          }}
        >
          Open judge
        </button>
        <button
          className="btn ghost danger"
          onClick={() => {
            closePopover();
            void detach(attachment);
          }}
        >
          Detach
        </button>
      </div>
    </div>
  );
}

function JudgePicker({ message, attachedJudgeIds }: { message: MessageRec; attachedJudgeIds: string[] }) {
  const judges = useJudges();
  const [query, setQuery] = useState("");
  const matches = judges.filter((j) => !attachedJudgeIds.includes(j.id) && j.name.toLowerCase().includes(query.toLowerCase()));
  const pick = (judge: JudgeRec) => {
    closePopover();
    void attach(judge, message);
  };
  const createNew = async () => {
    closePopover();
    const judge = await createJudge(query.trim() || "New judge");
    navigate({ page: "judge", id: judge.id });
  };
  return (
    <div className="picker">
      <input
        id="judge-picker-search"
        className="input"
        placeholder="Find a judge"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && matches[0] && pick(matches[0])}
      />
      <div className="menu">
        {matches.map((judge) => (
          <button key={judge.id} className="menu-item" onClick={() => pick(judge)}>
            <Scale size={14} />
            <span>{judge.name}</span>
          </button>
        ))}
        {matches.length === 0 && <p className="muted picker-empty">{judges.length === 0 ? "You have no judges yet." : "No judge matches."}</p>}
        <hr />
        <button className="menu-item" onClick={() => void createNew()}>
          <Plus size={14} />
          <span>New judge…</span>
        </button>
      </div>
    </div>
  );
}

function attachmentsOf(data: ThreadData, message: MessageRec): AttachmentRec[] {
  return data.attachments.filter((a) => a.messageId === message.id && data.judges.has(a.judgeId));
}

export function openJudgePicker(event: MouseEvent, data: ThreadData, message: MessageRec) {
  openPopover(event.currentTarget, <JudgePicker message={message} attachedJudgeIds={attachmentsOf(data, message).map((a) => a.judgeId)} />);
}

/** The scores under a message. A message without judges shows no row; its "Judge" button is in the action row. */
export function JudgeChips({ data, message, readOnly }: { data: ThreadData; message: MessageRec; readOnly?: boolean }) {
  const attachments = attachmentsOf(data, message);
  if (attachments.length === 0) return null;
  const openDetails = (event: MouseEvent, attachment: AttachmentRec) => {
    if (readOnly) return;
    openPopover(event.currentTarget, <ScoreDetails threadId={data.thread.id} attachmentId={attachment.id} />);
  };
  return (
    <div className="chips">
      {attachments.map((attachment) => {
        const judge = data.judges.get(attachment.judgeId)!;
        const summary = summarize(attachment, judge, message, data.samples.get(message.id) ?? [], data.scores);
        return (
          <button
            key={attachment.id}
            className={summary.outOfDate ? "chip stale" : "chip"}
            title={summary.outOfDate ? "Out of date. The judge's prompt changed since this score." : judge.name}
            onClick={(event) => openDetails(event, attachment)}
          >
            <Scale size={13} />
            <span className="chip-name">{judge.name}</span>
            <b>{chipValue(summary)}</b>
            {summary.average !== null && <ScoreBar value={summary.average} lowerIsBetter={judge.lowerIsBetter} />}
            {summary.pending && <span className="spinner" />}
          </button>
        );
      })}
      {!readOnly && (
        <button className="chip add" onClick={(event) => openJudgePicker(event, data, message)}>
          <Plus size={13} />
          Judge
        </button>
      )}
    </div>
  );
}
