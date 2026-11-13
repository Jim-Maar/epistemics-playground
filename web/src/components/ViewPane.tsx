/** A side-by-side view: its threads as columns, with one composer that can send to all of them. */
import { useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Columns2, MoreHorizontal, Plus } from "lucide-react";
import { deleteNode, inheritedJudgeCount, sendMessage, stopThread } from "../actions";
import type { NodeRec } from "../db";
import { useRunningThreadIds, useThreadData, type Tree } from "../hooks";
import { mergeIntoView, update } from "../repo";
import { ComposerBox, ThreadView } from "./ThreadPane";
import { IconButton, InlineEdit, Toggle, closeDialog, openDialog, openMenu } from "./ui";

function Column({ threadId, tree, ownComposer }: { threadId: string; tree: Tree; ownComposer: boolean }) {
  const data = useThreadData(threadId);
  if (!data) return <div className="view-col" />;
  return (
    <div className="view-col">
      <ThreadView data={data} tree={tree} inView hideComposer={!ownComposer} />
    </div>
  );
}

function AddThreadPicker({ tree, view }: { tree: Tree; view: NodeRec }) {
  const [query, setQuery] = useState("");
  const candidates = [...tree.byId.values()].filter(
    (n) => n.kind === "thread" && n.parentId !== view.id && n.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="picker in-dialog">
      <input id="view-add-search" className="input" placeholder="Search threads" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="menu scroll">
        {candidates.map((thread) => (
          <button
            key={thread.id}
            className="menu-item"
            onClick={() => {
              closeDialog();
              void mergeIntoView(thread.id, view.id);
            }}
          >
            <span>{thread.title}</span>
          </button>
        ))}
        {candidates.length === 0 && <p className="muted picker-empty">No other thread matches.</p>}
      </div>
    </div>
  );
}

function SharedComposer({ view, threads, sendToAll, onSendToAll }: { view: NodeRec; threads: NodeRec[]; sendToAll: boolean; onSendToAll: (on: boolean) => void }) {
  const running = useRunningThreadIds();
  const sampleCount = view.sampleCount ?? 1;
  const judgeCount = useLiveQuery(
    async () => (await Promise.all(threads.map((t) => inheritedJudgeCount(t.id)))).reduce((a, b) => a + b, 0),
    [threads.map((t) => `${t.id}:${t.lastActivityAt}`).join()],
  ) ?? 0;
  const toggle = <Toggle id={`send-all-${view.id}`} checked={sendToAll} onChange={onSendToAll} label="Send to all threads" />;
  if (!sendToAll) return <div className="composer slim"><div className="composer-bar">{toggle}</div></div>;
  return (
    <ComposerBox
      id={`composer-${view.id}`}
      placeholder={`Message all ${threads.length} threads`}
      busy={threads.some((t) => running.has(t.id))}
      runCost={sampleCount * (threads.length + judgeCount)}
      sampleCount={sampleCount}
      onSampleCount={(count) => void update<NodeRec>("nodes", view.id, { sampleCount: count })}
      onSend={(text, generate) => threads.forEach((t) => void sendMessage(t.id, text, sampleCount, generate))}
      onStop={() => threads.forEach((t) => void stopThread(t.id))}
      extra={toggle}
    />
  );
}

export function ViewPane({ viewId, tree, leading }: { viewId: string; tree: Tree | undefined; leading?: ReactNode }) {
  const [renaming, setRenaming] = useState(false);
  const [sendToAll, setSendToAll] = useState(true);
  const view = tree?.byId.get(viewId);
  if (!tree) return <section className="pane" />;
  if (!view || view.kind !== "view") {
    return <section className="pane"><header className="pane-head">{leading}</header><div className="empty"><h2>This view is gone</h2><p>A view with fewer than two threads turns back into a plain thread.</p></div></section>;
  }
  const threads = tree.children.get(view.id) ?? [];
  return (
    <section className="pane">
      <header className="pane-head">
        {leading}
        <Columns2 size={16} className="view-icon" />
        {renaming ? (
          <InlineEdit
            className="inline-edit title-edit" value={view.title}
            onSave={(title) => {
              setRenaming(false);
              void update<NodeRec>("nodes", view.id, { title });
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button className="pane-title" title="Rename" onClick={() => setRenaming(true)}>{view.title}</button>
        )}
        <span className="tag static">{threads.length} threads</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => openDialog("Add a thread to this view", <AddThreadPicker tree={tree} view={view} />)}><Plus size={14} />Add thread</button>
        <IconButton
          label="View menu"
          onClick={(event) =>
            openMenu(event, [
              { label: "Rename", onSelect: () => setRenaming(true) },
              "separator",
              { label: "Delete view, keep threads", danger: true, onSelect: () => void deleteNode(view, tree) },
            ])
          }
        >
          <MoreHorizontal size={16} />
        </IconButton>
      </header>
      <div className="view-cols">
        {threads.map((thread) => <Column key={thread.id} threadId={thread.id} tree={tree} ownComposer={!sendToAll} />)}
      </div>
      <SharedComposer view={view} threads={threads} sendToAll={sendToAll} onSendToAll={setSendToAll} />
    </section>
  );
}
