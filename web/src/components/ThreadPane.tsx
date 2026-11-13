/** One thread: header, system prompt, the conversation and the composer. Also used as a column in a view. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowUp, ChevronDown, Link2, Minus, MoreHorizontal, Plus, Square } from "lucide-react";
import { BACKEND_LABELS, MAX_SAMPLES, MODEL_LABEL } from "../../../shared/types";
import { deleteNode, duplicate, inheritedJudgeCount, removeFromView, sendMessage, stopThread } from "../actions";
import { post } from "../api";
import type { NodeRec } from "../db";
import { useRunningThreadIds, useThreadData, type ThreadData, type Tree } from "../hooks";
import { update } from "../repo";
import { shareUrl } from "../routing";
import { backendStore, toast, useStore } from "../stores";
import { MessageList } from "./Messages";
import { openSettings } from "./Settings";
import { ShareDialog } from "./ShareDialog";
import { AutoTextarea, IconButton, InlineEdit, copyText, openDialog, openMenu } from "./ui";

const STICK_TO_BOTTOM_PX = 80;
const COMPOSER_MAX_HEIGHT = 240;

/** Keeps the conversation scrolled to the newest text, unless the user scrolled up. */
function useStickToBottom() {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (!element || !content.current) return;
    const onScroll = () => {
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX;
    };
    const observer = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content.current);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, []);
  return { scroller, content };
}

export function SampleStepper({ id, count, onChange }: { id: string; count: number; onChange: (count: number) => void }) {
  return (
    <span className="stepper" role="group" aria-label="Number of samples">
      <button aria-label="Fewer samples" disabled={count <= 1} onClick={() => onChange(count - 1)}><Minus size={12} /></button>
      <output id={id}>{count} {count === 1 ? "sample" : "samples"}</output>
      <button aria-label="More samples" disabled={count >= MAX_SAMPLES} onClick={() => onChange(count + 1)}><Plus size={12} /></button>
    </span>
  );
}

export function ComposerBox(props: {
  id: string; placeholder: string; busy: boolean; runCost: number; sampleCount: number;
  onSampleCount: (count: number) => void; onSend: (text: string, generate: boolean) => void; onStop: () => void; extra?: ReactNode;
}) {
  const [text, setText] = useState("");
  const send = (generate: boolean) => {
    if (!text.trim()) return;
    props.onSend(text, generate);
    setText("");
  };
  return (
    <div className="composer">
      <div className="composer-box">
        <AutoTextarea
          id={props.id}
          className="composer-input"
          placeholder={props.placeholder}
          value={text}
          maxHeight={COMPOSER_MAX_HEIGHT}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send(true);
            }
          }}
        />
        <div className="composer-bar">
          {props.extra}
          <span className="spacer" />
          <span className="muted run-cost" title="Model calls this send will start: one per sample, plus one per judge on each sample.">
            {props.runCost} {props.runCost === 1 ? "run" : "runs"}
          </span>
          <SampleStepper id={`${props.id}-samples`} count={props.sampleCount} onChange={props.onSampleCount} />
          {props.busy ? (
            <button className="send stop" aria-label="Stop" title="Stop" onClick={props.onStop}><Square size={13} /></button>
          ) : (
            <span className="split">
              <button className="send" aria-label="Send" title="Send" disabled={!text.trim()} onClick={() => send(true)}><ArrowUp size={16} /></button>
              <button
                className="send-more"
                aria-label="More ways to send"
                disabled={!text.trim()}
                onClick={(event) => openMenu(event, [{ label: "Add without generating", onSelect: () => send(false) }])}
              >
                <ChevronDown size={13} />
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadComposer({ thread, busy }: { thread: NodeRec; busy: boolean }) {
  const sampleCount = thread.sampleCount ?? 1;
  const judgeCount = useLiveQuery(() => inheritedJudgeCount(thread.id), [thread.id, thread.lastActivityAt]) ?? 0;
  return (
    <ComposerBox
      id={`composer-${thread.id}`}
      placeholder="Message Opus 5.5"
      busy={busy}
      runCost={sampleCount * (1 + judgeCount)}
      sampleCount={sampleCount}
      onSampleCount={(count) => void update<NodeRec>("nodes", thread.id, { sampleCount: count })}
      onSend={(text, generate) => void sendMessage(thread.id, text, sampleCount, generate)}
      onStop={() => void stopThread(thread.id)}
    />
  );
}

function SystemPrompt({ thread, readOnly, forceOpen }: { thread: NodeRec; readOnly?: boolean; forceOpen: boolean }) {
  const [draft, setDraft] = useState(thread.systemPrompt ?? "");
  useEffect(() => setDraft(thread.systemPrompt ?? ""), [thread.systemPrompt]);
  if (!thread.systemPrompt && !forceOpen) return null;
  if (readOnly) return <div className="system-prompt read"><b>System prompt</b>{thread.systemPrompt}</div>;
  return (
    <div className="system-prompt">
      <label htmlFor={`system-${thread.id}`}>System prompt</label>
      <AutoTextarea
        id={`system-${thread.id}`}
        className="input"
        placeholder="Empty. The model gets no system prompt."
        value={draft}
        maxHeight={COMPOSER_MAX_HEIGHT}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft !== (thread.systemPrompt ?? "") && void update<NodeRec>("nodes", thread.id, { systemPrompt: draft })}
      />
    </div>
  );
}

function ModelSeesInfo() {
  return (
    <div className="prose-block">
      <p>With the two Claude Code options, every call also carries about 650 tokens that Claude Code adds by itself and that cannot be switched off:</p>
      <ul>
        <li>One sentence saying the model is a Claude agent built on the Claude Agent SDK.</li>
        <li>A note about handling the account owner's email address, which contains that address.</li>
        <li>An environment block: working folder, platform, model name and today's date.</li>
      </ul>
      <p>Your CLAUDE.md, memory, tools, MCP servers, skills and hooks are all switched off. The Anthropic API option sends only the system prompt and the messages.</p>
    </div>
  );
}

async function copyShareLink(threadId: string) {
  const { id } = await post<{ id: string }>("/shares", { threadId });
  toast((await copyText(shareUrl(id))) ? "Link copied." : `Link: ${shareUrl(id)}`);
}

export function ThreadHeader(props: { thread: NodeRec; tree?: Tree; inView?: boolean; onSystemPrompt: () => void; leading?: ReactNode }) {
  const { thread } = props;
  const [renaming, setRenaming] = useState(false);
  const backend = useStore(backendStore);
  const menu = (event: React.MouseEvent) =>
    openMenu(event, [
      { label: "Rename", onSelect: () => setRenaming(true) },
      { label: "System prompt", onSelect: props.onSystemPrompt },
      { label: "What else the model sees", onSelect: () => openDialog("What else the model sees", <ModelSeesInfo />) },
      { label: "Manage share links", onSelect: () => openDialog("Share links", <ShareDialog threadId={thread.id} />) },
      { label: "Duplicate", onSelect: () => void duplicate(thread) },
      ...(props.inView ? [{ label: "Remove from view", onSelect: () => void removeFromView(thread) }] : []),
      "separator" as const,
      { label: "Delete", danger: true, onSelect: () => props.tree && void deleteNode(thread, props.tree) },
    ]);
  return (
    <header className={props.inView ? "pane-head compact" : "pane-head"}>
      {props.leading}
      {renaming ? (
        <InlineEdit
          className="inline-edit title-edit"
          value={thread.title}
          onSave={(title) => {
            setRenaming(false);
            void update<NodeRec>("nodes", thread.id, { title });
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <button className="pane-title" title="Rename" onClick={() => setRenaming(true)}>{thread.title}</button>
      )}
      {!props.inView && (
        <button className="tag" title="Where model calls run. Click to change." onClick={openSettings}>
          {MODEL_LABEL} · {BACKEND_LABELS[backend]}
        </button>
      )}
      <span className="spacer" />
      {!props.inView && (
        <button className="btn ghost" onClick={() => void copyShareLink(thread.id)}><Link2 size={14} />Share</button>
      )}
      <IconButton label="Thread menu" onClick={menu}><MoreHorizontal size={16} /></IconButton>
    </header>
  );
}

function EmptyThread() {
  return (
    <div className="empty">
      <h2>Start probing</h2>
      <p>Write a message below. Set the number of samples next to the send button to get up to five answers at once.</p>
      <p className="muted">You can edit every message later, also the model's, and insert messages anywhere.</p>
    </div>
  );
}

export function ThreadView(props: { data: ThreadData; tree?: Tree; inView?: boolean; hideComposer?: boolean; leading?: ReactNode }) {
  const { data } = props;
  const { scroller, content } = useStickToBottom();
  const [showSystem, setShowSystem] = useState(false);
  const busy = useRunningThreadIds().has(data.thread.id);
  useMarkSeen(data.thread);
  return (
    <section className="pane">
      <ThreadHeader thread={data.thread} tree={props.tree} inView={props.inView} leading={props.leading} onSystemPrompt={() => setShowSystem(true)} />
      <div className="conv" ref={scroller}>
        <div className="conv-col" ref={content}>
          <SystemPrompt thread={data.thread} forceOpen={showSystem} />
          {data.messages.length === 0 ? <EmptyThread /> : <MessageList data={data} />}
        </div>
      </div>
      {!props.hideComposer && <ThreadComposer thread={data.thread} busy={busy} />}
    </section>
  );
}

/** Opening a thread clears its "new answer" dot. */
function useMarkSeen(thread: NodeRec) {
  useEffect(() => {
    if ((thread.lastActivityAt ?? 0) > (thread.lastSeenAt ?? 0)) {
      void update<NodeRec>("nodes", thread.id, { lastSeenAt: Date.now() });
    }
  }, [thread.id, thread.lastActivityAt, thread.lastSeenAt]);
}

export function ThreadPane({ threadId, tree, leading }: { threadId: string; tree?: Tree; leading?: ReactNode }) {
  const data = useThreadData(threadId);
  if (data === undefined) return <section className="pane" />;
  if (data === null) {
    return (
      <section className="pane">
        <header className="pane-head">{leading}</header>
        <div className="empty"><h2>This thread is gone</h2><p>It was deleted, or it belongs to another browser.</p></div>
      </section>
    );
  }
  return <ThreadView data={data} tree={tree} leading={leading} />;
}

export { SystemPrompt };
