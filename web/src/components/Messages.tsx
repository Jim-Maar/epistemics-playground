/** The conversation: user and AI messages, their samples, editing, and the insert gaps between them. */
import { Fragment, memo, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Columns2, Copy, Pencil, Plus, RotateCw, Sparkles, Trash2 } from "lucide-react";
import { MAX_SAMPLES } from "../../../shared/types";
import {
  addSample,
  cancelEdit,
  deleteMessage,
  editingStore,
  generateAnswer,
  insertManualMessage,
  resampleAll,
  resampleOne,
  saveSampleEdit,
  saveUserEdit,
} from "../actions";
import { activeSampleOf, contextHash, turnsBefore } from "../context";
import type { MessageRec, SampleRec } from "../db";
import type { ThreadData } from "../hooks";
import { update } from "../repo";
import { startRun, useLiveRun } from "../runs";
import { scoreColor, summarize } from "../scores";
import { toast, useStore } from "../stores";
import { JudgeChips } from "./JudgeChips";
import { AutoTextarea, copyText, openMenu } from "./ui";

const EDIT_BOX_MAX_HEIGHT = 420;

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

async function copyWithToast(text: string) {
  toast((await copyText(text)) ? "Copied." : "Copying is blocked in this browser.");
}

// ---------- Edit box ----------

function EditBox(props: {
  id: string; initial: string; onCancel: () => void; onSave: (text: string) => void; secondary?: { label: string; run: (text: string) => void };
}) {
  const [text, setText] = useState(props.initial);
  return (
    <div className="edit-box">
      <AutoTextarea
        id={props.id}
        className="input edit-area"
        value={text}
        autoFocus
        maxHeight={EDIT_BOX_MAX_HEIGHT}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onCancel();
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) props.onSave(text);
        }}
      />
      <div className="row-actions end">
        <button className="btn ghost" onClick={props.onCancel}>Cancel</button>
        <button className={props.secondary ? "btn" : "btn primary"} onClick={() => props.onSave(text)}>Save</button>
        {props.secondary && (
          <button className="btn primary" onClick={() => props.secondary!.run(text)}>{props.secondary.label}</button>
        )}
      </div>
    </div>
  );
}

// ---------- User message ----------

function UserMessage({ data, message, next, readOnly }: { data: ThreadData; message: MessageRec; next?: MessageRec; readOnly?: boolean }) {
  const editing = useStore(editingStore) === message.id;
  const nextAnswer = next?.role === "assistant" ? next : null;
  if (editing) {
    return (
      <div className="msg user editing">
        <EditBox
          id={`edit-${message.id}`}
          initial={message.text}
          onCancel={() => void cancelEdit(message)}
          onSave={(text) => void saveUserEdit(message, text, null)}
          secondary={nextAnswer ? { label: "Save and resample the answer", run: (text) => void saveUserEdit(message, text, nextAnswer) } : undefined}
        />
      </div>
    );
  }
  const sampleCount = data.thread.sampleCount ?? 1;
  return (
    <div className="msg user">
      <div className="bubble">{message.text || <span className="muted">Empty message</span>}</div>
      <JudgeChips data={data} message={message} readOnly={readOnly} />
      {!readOnly && (
        <div className="msg-actions">
          {!nextAnswer && message.text.trim() && (
            <button className="act" onClick={() => void generateAnswer(message.threadId, message.id, sampleCount)}>
              <Sparkles size={13} />
              Generate answer
            </button>
          )}
          <button className="act" onClick={() => editingStore.set(message.id)}><Pencil size={13} />Edit</button>
          <button className="act" onClick={() => void copyWithToast(message.text)}><Copy size={13} />Copy</button>
          <button className="act" onClick={() => void deleteMessage(message)}><Trash2 size={13} />Delete</button>
        </div>
      )}
    </div>
  );
}

// ---------- AI message ----------

function Thinking({ text, live }: { text: string; live: boolean }) {
  if (!text) return null;
  return (
    <details className="thinking">
      <summary>{live ? "Thinking…" : "Thinking"}</summary>
      <div>{text}</div>
    </details>
  );
}

function SampleBody({ sample, raw }: { sample: SampleRec; raw: boolean }) {
  const liveRun = useLiveRun(sample.runId);
  const busy = sample.status === "queued" || sample.status === "running";
  if (busy) {
    const text = liveRun?.text ?? "";
    const waiting = liveRun?.position ? `Queued, ${liveRun.position - 1} ahead` : text ? "" : liveRun?.thinking ? "" : "Starting…";
    return (
      <div className="sample">
        <Thinking text={liveRun?.thinking ?? ""} live />
        {text ? <Markdown text={text} /> : waiting && <p className="muted waiting"><span className="spinner" />{waiting}</p>}
        {text && <span className="caret" aria-hidden="true" />}
      </div>
    );
  }
  return (
    <div className="sample">
      <Thinking text={sample.thinking ?? ""} live={false} />
      {raw ? <pre className="raw">{sample.text}</pre> : sample.text ? <Markdown text={sample.text} /> : null}
      {sample.status === "stopped" && <p className="muted note">Stopped.</p>}
      {sample.status === "error" && (
        <p className="error-note">
          {sample.error ?? "This answer failed."}{" "}
          <button className="link" onClick={() => void startRun({ table: "samples", id: sample.id })}>Retry</button>
        </p>
      )}
      {sample.status === "done" && !sample.text && !sample.edited && <p className="muted note">The model returned an empty answer.</p>}
    </div>
  );
}

function sampleDotColor(data: ThreadData, message: MessageRec, sample: SampleRec): string | null {
  const attachment = data.attachments.find((a) => a.messageId === message.id && data.judges.has(a.judgeId));
  if (!attachment) return null;
  const judge = data.judges.get(attachment.judgeId)!;
  const target = summarize(attachment, judge, message, [sample], data.scores).targets[0];
  return target?.score?.value !== undefined ? scoreColor(target.score.value, judge.lowerIsBetter) : null;
}

function SampleStrip(props: {
  data: ThreadData; message: MessageRec; samples: SampleRec[]; active?: SampleRec; compare: boolean; onCompare: () => void; readOnly?: boolean; hasLater: boolean;
}) {
  const { data, message, samples, active } = props;
  return (
    <div className="strip" role="tablist" aria-label="Samples">
      <span className="strip-label">Samples</span>
      {samples.map((sample) => {
        const busy = sample.status === "queued" || sample.status === "running";
        const dot = sampleDotColor(data, message, sample);
        const isActive = sample.id === active?.id && !props.compare;
        return (
          <button
            key={sample.id}
            role="tab"
            aria-selected={isActive}
            className={`pill${isActive ? " active" : ""}${sample.status === "error" ? " failed" : ""}`}
            title={isActive && props.hasLater ? "This sample is the context for the later messages." : `Sample ${sample.index + 1}`}
            onClick={() => !props.readOnly && void update<MessageRec>("messages", message.id, { activeSampleId: sample.id })}
          >
            {sample.index + 1}
            {busy ? <span className="spinner" /> : dot && <span className="pill-dot" style={{ background: dot }} />}
          </button>
        );
      })}
      <button className={props.compare ? "act on" : "act"} onClick={props.onCompare}>
        <Columns2 size={13} />
        Compare
      </button>
    </div>
  );
}

function AssistantMessage(props: { data: ThreadData; message: MessageRec; readOnly?: boolean; stale: boolean; hasLater: boolean }) {
  const { data, message, readOnly } = props;
  const samples = data.samples.get(message.id) ?? [];
  const active = activeSampleOf(message, samples);
  const editing = useStore(editingStore) === message.id;
  const [compare, setCompare] = useState(false);
  const [raw, setRaw] = useState(false);
  if (!active) return null;

  if (editing) {
    return (
      <div className="msg assistant editing">
        <EditBox id={`edit-${message.id}`} initial={active.text} onCancel={() => void cancelEdit(message)} onSave={(text) => void saveSampleEdit(active, text)} />
      </div>
    );
  }

  const resampleMenu = (event: React.MouseEvent) =>
    openMenu(event, [
      { label: samples.length > 1 ? `Resample all ${samples.length}` : "Resample", icon: <RotateCw size={14} />, onSelect: () => void resampleAll(message) },
      { label: "Resample this sample only", icon: <RotateCw size={14} />, disabled: samples.length < 2, onSelect: () => void resampleOne(message, active.id) },
      { label: "Add a sample", icon: <Plus size={14} />, disabled: samples.length >= MAX_SAMPLES, onSelect: () => void addSample(message) },
      "separator",
      { label: raw ? "Show formatted text" : "Show raw text", onSelect: () => setRaw(!raw) },
    ]);

  return (
    <div className="msg assistant">
      {samples.length > 1 && (
        <SampleStrip
          data={data} message={message} samples={samples} active={active} compare={compare}
          onCompare={() => setCompare(!compare)} readOnly={readOnly} hasLater={props.hasLater}
        />
      )}
      {active.edited && !compare && <span className="badge edited" title="This text was written or changed by hand.">Edited</span>}
      {compare && samples.length > 1 ? (
        <div className="compare">
          {samples.map((sample) => (
            <div key={sample.id} className="compare-col">
              <div className="compare-head">
                Sample {sample.index + 1}
                {sample.edited && <span className="badge edited">Edited</span>}
              </div>
              <SampleBody sample={sample} raw={raw} />
            </div>
          ))}
        </div>
      ) : (
        <SampleBody sample={active} raw={raw} />
      )}
      {props.stale && !readOnly && (
        <p className="stale-note">
          Context changed since this was generated.{" "}
          <button className="link" onClick={() => void resampleAll(message)}>Resample</button>
        </p>
      )}
      <JudgeChips data={data} message={message} readOnly={readOnly} />
      {!readOnly && (
        <div className="msg-actions">
          <span className="split">
            <button className="act" onClick={() => void resampleAll(message)}><RotateCw size={13} />Resample</button>
            <button className="act narrow" aria-label="More resample options" onClick={resampleMenu}><ChevronDown size={13} /></button>
          </span>
          <button className="act" onClick={() => editingStore.set(message.id)}><Pencil size={13} />Edit</button>
          <button className="act" onClick={() => void copyWithToast(active.text)}><Copy size={13} />Copy</button>
          <button className="act" onClick={() => void deleteMessage(message)}><Trash2 size={13} />Delete</button>
        </div>
      )}
    </div>
  );
}

// ---------- The gaps between messages ----------

function Inserter({ threadId, afterId }: { threadId: string; afterId: string | null }) {
  return (
    <div className="inserter">
      <button
        className="inserter-btn"
        onClick={(event) =>
          openMenu(event, [
            { label: "User message", onSelect: () => void insertManualMessage(threadId, afterId, "user") },
            { label: "AI message (written by you)", onSelect: () => void insertManualMessage(threadId, afterId, "assistant") },
          ])
        }
      >
        <Plus size={12} />
        Insert
      </button>
    </div>
  );
}

/** AI messages whose earlier messages changed after the answer was generated. */
function staleMessageIds(data: ThreadData): Set<string> {
  const stale = new Set<string>();
  for (const message of data.messages) {
    if (message.role !== "assistant") continue;
    const active = activeSampleOf(message, data.samples.get(message.id) ?? []);
    if (!active?.contextHash || active.edited || active.status !== "done") continue;
    const current = contextHash(data.thread.systemPrompt ?? "", turnsBefore(data.messages, data.samples, message.id));
    if (current !== active.contextHash) stale.add(message.id);
  }
  return stale;
}

export function MessageList({ data, readOnly }: { data: ThreadData; readOnly?: boolean }) {
  const stale = useMemo(() => staleMessageIds(data), [data]);
  return (
    <>
      {!readOnly && data.messages.length > 0 && <Inserter threadId={data.thread.id} afterId={null} />}
      {data.messages.map((message, index) => (
        <Fragment key={message.id}>
          {message.role === "user" ? (
            <UserMessage data={data} message={message} next={data.messages[index + 1]} readOnly={readOnly} />
          ) : (
            <AssistantMessage
              data={data} message={message} readOnly={readOnly} stale={stale.has(message.id)}
              hasLater={index < data.messages.length - 1}
            />
          )}
          {!readOnly && <Inserter threadId={data.thread.id} afterId={message.id} />}
        </Fragment>
      ))}
    </>
  );
}
