import { useEffect, useState } from "react";
import { Menu as MenuIcon, SquarePen } from "lucide-react";
import { newThread } from "./actions";
import { useToken } from "./api";
import { JudgeEditor } from "./components/JudgeEditor";
import { Login } from "./components/Login";
import { OtherBrowsers } from "./components/Settings";
import { SharePage } from "./components/SharePage";
import { Sidebar, type SidebarTab } from "./components/Sidebar";
import { ThreadPane } from "./components/ThreadPane";
import { ViewPane } from "./components/ViewPane";
import { DialogHost, IconButton, PopoverHost, ToastHost } from "./components/ui";
import { useTree, type Tree } from "./hooks";
import { useRoute } from "./routing";
import { resumePendingRuns } from "./runs";
import { startMePolling } from "./stores";
import { startSync } from "./sync";

function Home({ tree, leading }: { tree: Tree | undefined; leading: React.ReactNode }) {
  const empty = tree !== undefined && tree.byId.size === 0;
  return (
    <section className="pane">
      <header className="pane-head bare">{leading}</header>
      <div className="empty">
        <h2>{empty ? "Welcome to the playground" : "Pick a thread"}</h2>
        <p>Probe how Opus 5.5 handles evidence, uncertainty and pressure. Edit any message, sample up to five answers at once, and let judges score them.</p>
        <p><button className="btn primary" onClick={() => void newThread(null)}><SquarePen size={14} />New thread</button></p>
        {empty && (
          <div className="stack offer">
            <h3>Or start from another browser's threads</h3>
            <OtherBrowsers />
          </div>
        )}
      </div>
    </section>
  );
}

function Workspace() {
  const route = useRoute();
  const tree = useTree();
  const [tab, setTab] = useState<SidebarTab>(route.page === "judge" ? "judges" : "threads");
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    startSync();
    startMePolling();
    void resumePendingRuns();
    void navigator.storage?.persist?.();
  }, []);
  useEffect(() => {
    if (route.page === "judge") setTab("judges");
    if (route.page === "thread" || route.page === "view") setTab("threads");
  }, [route.page]);

  const leading = (
    <span className="mobile-only">
      <IconButton label="Open sidebar" onClick={() => setDrawerOpen(true)}><MenuIcon size={18} /></IconButton>
    </span>
  );
  return (
    <div className={drawerOpen ? "app drawer-open" : "app"}>
      <Sidebar tree={tree} route={route} tab={tab} onTab={setTab} onNavigate={() => setDrawerOpen(false)} />
      <div className="scrim" onClick={() => setDrawerOpen(false)} />
      <main className="main">
        {route.page === "thread" && <ThreadPane key={route.id} threadId={route.id} tree={tree} leading={leading} />}
        {route.page === "view" && <ViewPane key={route.id} viewId={route.id} tree={tree} leading={leading} />}
        {route.page === "judge" && <JudgeEditor judgeId={route.id} leading={leading} />}
        {route.page === "share" && <SharePage key={route.id} shareId={route.id} />}
        {route.page === "home" && <Home tree={tree} leading={leading} />}
      </main>
    </div>
  );
}

export function App() {
  const token = useToken();
  return (
    <>
      {token ? <Workspace /> : <Login />}
      <PopoverHost />
      <DialogHost />
      <ToastHost />
    </>
  );
}
