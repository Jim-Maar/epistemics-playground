/** Settings: where model calls run, this browser's name, other browsers' copies, export and sign-out. */
import { useEffect, useState } from "react";
import { BACKEND_LABELS, type Backend } from "../../../shared/types";
import { api, post, resetBrowserId, setToken } from "../api";
import { SYNCED_TABLES, db, type AttachmentRec, type JudgeRec, type MessageRec, type NodeRec, type SampleRec, type ScoreRec } from "../db";
import { createNode, insertCopy, tx } from "../repo";
import { backendStore, meStore, refreshMe, setBackend, toast, useStore } from "../stores";
import { closeDialog, copyText, openDialog } from "./ui";

type BrowserInfo = { id: string; name: string; lastSyncAt: number | null; threadCount: number };
type Entity = { kind: string; data: unknown };

const CONNECTOR_URL = `${location.origin}${import.meta.env.BASE_URL}connect.mjs`;

function ago(time: number | null): string {
  if (!time) return "never synced";
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `synced ${hours} h ago` : `synced ${Math.round(hours / 24)} days ago`;
}

function ofKind<T>(entities: Entity[], kind: string): T[] {
  return entities.filter((e) => e.kind === kind).map((e) => e.data as T);
}

/** Copies every thread, folder and view of another browser into a new folder here. */
export async function copyFromBrowser(browser: BrowserInfo) {
  const entities = await api<Entity[]>(`/browsers/${browser.id}/entities`);
  const nodes = ofKind<NodeRec>(entities, "nodes");
  const ids = new Set(nodes.map((n) => n.id));
  const reachable = nodes.filter((n) => {
    for (let current: NodeRec | undefined = n; current; current = nodes.find((p) => p.id === current!.parentId)) {
      if (current.parentId === null) return true;
      if (!ids.has(current.parentId)) return false;
    }
    return false;
  });
  const folder = await createNode("folder", null, `Copied from ${browser.name}`);
  await tx(() =>
    insertCopy(
      {
        nodes: reachable,
        messages: ofKind<MessageRec>(entities, "messages"),
        samples: ofKind<SampleRec>(entities, "samples"),
        attachments: ofKind<AttachmentRec>(entities, "attachments"),
        scores: ofKind<ScoreRec>(entities, "scores"),
        judges: ofKind<JudgeRec>(entities, "judges"),
      },
      reachable.filter((n) => n.parentId === null).map((n) => n.id),
      folder.id,
      "a0",
      false,
    ),
  );
  toast(`Copied ${browser.threadCount} threads from ${browser.name}.`);
}

function BackendChoice() {
  const backend = useStore(backendStore);
  const me = useStore(meStore);
  const [token, setRunnerToken] = useState<string | null>(null);
  useEffect(() => {
    if (backend === "own" && !token) void api<{ token: string }>("/runner/token").then((r) => setRunnerToken(r.token));
  }, [backend, token]);
  useEffect(() => {
    if (backend !== "own") return;
    const timer = setInterval(() => void refreshMe().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [backend]);
  const command = `curl -fsSL ${CONNECTOR_URL} -o connect.mjs && node connect.mjs ${token ?? "…"}`;
  const options: { value: Backend; hint: string; disabled?: boolean }[] = [
    { value: "devbox", hint: "The default. Runs on Jim's devbox with his Claude subscription." },
    { value: "own", hint: "Runs on your computer with your own Claude Code login. Your threads are still saved in the shared database." },
    {
      value: "api",
      hint: me?.apiAvailable ? "Uses the API key on the devbox. Billed per use. Sends only your system prompt and messages." : "Off. Put ANTHROPIC_API_KEY in the env file on the devbox to turn it on.",
      disabled: !me?.apiAvailable,
    },
  ];
  return (
    <fieldset className="stack">
      <legend>Where model calls run</legend>
      {options.map((option) => (
        <label key={option.value} className={option.disabled ? "radio-row disabled" : "radio-row"} htmlFor={`backend-${option.value}`}>
          <input
            id={`backend-${option.value}`} type="radio" name="backend" checked={backend === option.value} disabled={option.disabled}
            onChange={() => setBackend(option.value)}
          />
          <span><b>{BACKEND_LABELS[option.value]}</b><span className="muted">{option.hint}</span></span>
        </label>
      ))}
      {backend === "own" && (
        <div className="connect-box">
          <p>
            {me?.runner.connected
              ? <><span className="status-dot ok" />Connected: {me.runner.name}</>
              : <><span className="status-dot" />Not connected. Run this in a terminal on your computer (needs Node 22 and a logged-in Claude Code), and leave it running:</>}
          </p>
          <code className="command">{command}</code>
          <button className="btn" onClick={async () => toast((await copyText(command)) ? "Command copied." : "Copying is blocked in this browser.")}>Copy command</button>
        </div>
      )}
    </fieldset>
  );
}

function BrowserName() {
  const me = useStore(meStore);
  const [name, setName] = useState(me?.browserName ?? "");
  useEffect(() => setName(me?.browserName ?? ""), [me?.browserName]);
  const save = async () => {
    if (!name.trim() || name === me?.browserName) return;
    meStore.set(await api("/browser", { method: "PATCH", body: JSON.stringify({ name }) }));
    toast("Browser renamed.");
  };
  return (
    <div className="field">
      <label htmlFor="settings-browser-name">Name of this browser</label>
      <input id="settings-browser-name" className="input" value={name} onChange={(event) => setName(event.target.value)} onBlur={() => void save()} />
    </div>
  );
}

export function OtherBrowsers() {
  const me = useStore(meStore);
  const [browsers, setBrowsers] = useState<BrowserInfo[] | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  useEffect(() => void api<BrowserInfo[]>("/browsers").then(setBrowsers).catch(() => setBrowsers([])), []);
  const others = (browsers ?? []).filter((b) => b.id !== me?.browserId && b.threadCount > 0);
  if (others.length === 0) return <p className="muted">No other browser has saved threads yet.</p>;
  const copy = async (browser: BrowserInfo) => {
    setCopying(browser.id);
    await copyFromBrowser(browser).catch((err: Error) => toast(err.message));
    setCopying(null);
  };
  return (
    <>
      {others.map((browser) => (
        <div key={browser.id} className="list-row">
          <span className="grow"><b>{browser.name}</b><span className="muted"> · {browser.threadCount} threads · {ago(browser.lastSyncAt)}</span></span>
          <button className="btn" disabled={copying !== null} onClick={() => void copy(browser)}>
            {copying === browser.id ? "Copying…" : "Copy threads into this browser"}
          </button>
        </div>
      ))}
    </>
  );
}

async function exportAll() {
  const dump: Record<string, unknown[]> = {};
  for (const table of SYNCED_TABLES) dump[table] = await db.table(table).toArray();
  const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `epistemics-playground-${new Date().toISOString().slice(0, 10)}.json` });
  link.click();
  URL.revokeObjectURL(url);
}

async function signOut(erase: boolean) {
  await post("/auth/logout", {}).catch(() => {});
  if (erase) {
    await db.delete();
    resetBrowserId();
  }
  setToken(null);
  closeDialog();
  if (erase) location.reload();
}

async function signOutEverywhere() {
  await post("/auth/logout-all", {});
  setToken(null);
  closeDialog();
}

function SettingsBody() {
  const me = useStore(meStore);
  return (
    <div className="settings">
      <BackendChoice />
      <BrowserName />
      <section className="stack">
        <h3>Other browsers</h3>
        <p className="muted">Every browser has its own sidebar. All of them are saved in the shared database, so you can copy threads from one into another.</p>
        <OtherBrowsers />
      </section>
      <section className="stack">
        <h3>Data and sign-in</h3>
        <p className="muted">At most {me?.maxConcurrentRuns ?? 6} model calls run at once. More wait in a queue.</p>
        <div className="row-actions wrap">
          <button className="btn" onClick={() => void exportAll()}>Export all as JSON</button>
          <button className="btn" onClick={() => void signOut(false)}>Sign out</button>
          <button className="btn" onClick={() => void signOutEverywhere()}>Sign out everywhere</button>
          <button className="btn ghost danger" onClick={() => void signOut(true)}>Sign out and erase this browser's data</button>
        </div>
      </section>
    </div>
  );
}

export function openSettings() {
  openDialog("Settings", <SettingsBody />, true);
}
