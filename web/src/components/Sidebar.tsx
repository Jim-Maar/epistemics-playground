/** The sidebar: Threads and Judges tabs, search, and the sync and usage footer. */
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, CloudOff, FolderPlus, Plus, Scale, Search, Settings as SettingsIcon, SquarePen } from "lucide-react";
import { BACKEND_LABELS, type UsageInfo } from "../../../shared/types";
import { newFolder, newThread } from "../actions";
import { db, live } from "../db";
import { useJudges, useOutboxCount, useRunningThreadIds, type Tree } from "../hooks";
import { createJudge } from "../repo";
import { navigate, type Route } from "../routing";
import { formatScore } from "../scores";
import { backendStore, meStore, syncErrorStore, useStore } from "../stores";
import { openSettings } from "./Settings";
import { TreeView } from "./Tree";
import { IconButton } from "./ui";

const USAGE_WARN = 0.75;
const USAGE_DANGER = 0.9;
const SEARCH_RESULT_LIMIT = 50;
const WINDOW_LABELS: Record<string, string> = { seven_day: "Weekly usage", five_hour: "5-hour usage" };

export type SidebarTab = "threads" | "judges";

/** New items go next to the open thread: into its folder, or next to its view. */
function parentForNew(tree: Tree | undefined, route: Route): string | null {
  if (!tree || (route.page !== "thread" && route.page !== "view")) return null;
  const node = tree.byId.get(route.id);
  const parent = node?.parentId ? tree.byId.get(node.parentId) : undefined;
  return parent?.kind === "view" ? parent.parentId : (node?.parentId ?? null);
}

function useSearchResults(tree: Tree | undefined, query: string) {
  return useLiveQuery(async () => {
    const needle = query.trim().toLowerCase();
    if (!needle || !tree) return null;
    const ids = new Set<string>();
    for (const node of tree.byId.values()) {
      if (node.kind === "thread" && node.title.toLowerCase().includes(needle)) ids.add(node.id);
    }
    const inText = (text: string) => text.toLowerCase().includes(needle);
    await db.messages.filter((m) => !m.deleted && inText(m.text)).each((m) => void ids.add(m.threadId));
    await db.samples.filter((s) => !s.deleted && inText(s.text)).each((s) => void ids.add(s.threadId));
    return [...ids].map((id) => tree.byId.get(id)).filter((n) => n !== undefined).slice(0, SEARCH_RESULT_LIMIT);
  }, [query, tree]);
}

function JudgeList({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  const judges = useJudges();
  const stats = useLiveQuery(async () => {
    const attachments = live(await db.attachments.toArray());
    const scores = live(await db.scores.where("status").equals("done").toArray());
    return new Map(
      judges.map((judge) => {
        const values = scores.filter((s) => s.judgeId === judge.id && s.judgeRevision === judge.revision && s.value !== undefined).map((s) => s.value!);
        const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        return [judge.id, { messages: attachments.filter((a) => a.judgeId === judge.id).length, average }];
      }),
    );
  }, [judges]);
  if (judges.length === 0) {
    return (
      <div className="side-empty">
        <Scale size={20} />
        <p>A judge is a prompt that scores a message from 0 to 1.</p>
        <p className="muted">Create one, then attach it to any message with the "Judge" chip.</p>
      </div>
    );
  }
  return (
    <div className="tree">
      {judges.map((judge) => {
        const stat = stats?.get(judge.id);
        return (
          <button
            key={judge.id}
            className={route.page === "judge" && route.id === judge.id ? "judge-row selected" : "judge-row"}
            onClick={() => {
              navigate({ page: "judge", id: judge.id });
              onNavigate();
            }}
          >
            <span className="row-name">{judge.name}</span>
            <span className="judge-meta">
              {stat?.messages ?? 0} {stat?.messages === 1 ? "message" : "messages"}
              {stat?.average !== null && stat?.average !== undefined && ` · avg ${formatScore(stat.average)}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function UsageMeter({ usage }: { usage: UsageInfo | null }) {
  const window = usage?.windows.reduce<UsageInfo["windows"][number] | null>((top, w) => (!top || w.utilization > top.utilization ? w : top), null);
  if (!window) return null;
  const level = window.utilization >= USAGE_DANGER ? "danger" : window.utilization >= USAGE_WARN ? "warn" : "ok";
  const resets = window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
  return (
    <div className="usage" title={resets}>
      <div className="foot-line"><span>{WINDOW_LABELS[window.name] ?? "Usage"}</span><span className="spacer" /><span>{Math.round(window.utilization * 100)}%</span></div>
      <div className={`meter ${level}`}><i style={{ width: `${Math.min(100, window.utilization * 100)}%` }} /></div>
    </div>
  );
}

function SyncStatus() {
  const pending = useOutboxCount();
  const error = useStore(syncErrorStore);
  if (error && pending > 0) {
    return <span className="sync offline" title={error}><CloudOff size={13} />Offline. {pending} {pending === 1 ? "change" : "changes"} will sync.</span>;
  }
  if (pending > 0) return <span className="sync">Saving…</span>;
  return <span className="sync saved"><Check size={13} />Saved</span>;
}

function Footer() {
  const me = useStore(meStore);
  const backend = useStore(backendStore);
  const usage = backend === "api" ? null : backend === "own" ? (me?.usage.own ?? null) : (me?.usage.devbox ?? null);
  return (
    <footer className="side-foot">
      <UsageMeter usage={usage} />
      <div className="foot-line">
        <SyncStatus />
        <span className="spacer" />
        <button className="foot-settings" onClick={openSettings} title={`Settings. Model calls run on: ${BACKEND_LABELS[backend]}`}>
          <span className="row-name">{me?.browserName ?? ""}</span>
          <SettingsIcon size={14} />
        </button>
      </div>
    </footer>
  );
}

export function Sidebar(props: { tree: Tree | undefined; route: Route; tab: SidebarTab; onTab: (tab: SidebarTab) => void; onNavigate: () => void }) {
  const { tree, route, tab } = props;
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const running = useRunningThreadIds();
  const results = useSearchResults(tree, tab === "threads" ? query : "");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        props.onTab("threads");
        searchRef.current?.focus();
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void newThread(parentForNew(tree, route));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tree, route]);

  const addJudge = async () => {
    const judge = await createJudge("New judge");
    navigate({ page: "judge", id: judge.id });
    props.onNavigate();
  };

  return (
    <aside className="sidebar">
      <div className="side-top">
        <a className="brand" href="#/"><span className="brand-mark">E</span>Playground</a>
        {tab === "threads" ? (
          <>
            <IconButton label="New folder" onClick={() => void newFolder(parentForNew(tree, route))}><FolderPlus size={16} /></IconButton>
            <IconButton label="New thread" onClick={() => void newThread(parentForNew(tree, route)).then(props.onNavigate)}><SquarePen size={16} /></IconButton>
          </>
        ) : (
          <IconButton label="New judge" onClick={() => void addJudge()}><Plus size={16} /></IconButton>
        )}
      </div>
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={tab === "threads"} className={tab === "threads" ? "on" : ""} onClick={() => props.onTab("threads")}>Threads</button>
        <button role="tab" aria-selected={tab === "judges"} className={tab === "judges" ? "on" : ""} onClick={() => props.onTab("judges")}>Judges</button>
      </div>
      {tab === "threads" && (
        <label className="search" htmlFor="sidebar-search">
          <Search size={14} />
          <input
            id="sidebar-search" ref={searchRef} placeholder="Search threads" value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && (setQuery(""), event.currentTarget.blur())}
          />
          <kbd>{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
        </label>
      )}
      <div className="side-scroll">
        {tab === "judges" ? (
          <JudgeList route={route} onNavigate={props.onNavigate} />
        ) : results ? (
          <div className="tree">
            {results.map((node) => (
              <button
                key={node.id}
                className={route.page === "thread" && route.id === node.id ? "judge-row selected" : "judge-row"}
                onClick={() => {
                  navigate({ page: "thread", id: node.id });
                  props.onNavigate();
                }}
              >
                <span className="row-name">{node.title}</span>
              </button>
            ))}
            {results.length === 0 && <p className="muted side-note">No thread matches "{query}".</p>}
          </div>
        ) : tree && tree.byId.size > 0 ? (
          <TreeView tree={tree} route={route} runningThreadIds={running} onNavigate={props.onNavigate} />
        ) : (
          tree && <p className="muted side-note">No threads yet. Start one with the pencil button above.</p>
        )}
      </div>
      <Footer />
    </aside>
  );
}
