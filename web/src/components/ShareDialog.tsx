/** Lists the share links of a thread, with a button to turn each one off. */
import { useEffect, useState } from "react";
import { api, post } from "../api";
import { shareUrl } from "../routing";
import { toast } from "../stores";
import { copyText } from "./ui";

type Share = { id: string; createdAt: number };

export function ShareDialog({ threadId }: { threadId: string }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const load = () => api<Share[]>(`/shares?threadId=${threadId}`).then(setShares).catch((err: Error) => toast(err.message));
  useEffect(() => void load(), [threadId]);
  const create = async () => {
    const { id } = await post<{ id: string }>("/shares", { threadId });
    toast((await copyText(shareUrl(id))) ? "Link copied." : "Link created.");
    void load();
  };
  const stop = async (id: string) => {
    await api(`/shares/${id}`, { method: "DELETE" });
    void load();
  };
  return (
    <div className="stack">
      <p className="muted">A link shows this thread read-only on any device where you are signed in. It stays up to date while you keep working.</p>
      {shares?.length === 0 && <p>This thread has no links yet.</p>}
      {shares?.map((share) => (
        <div key={share.id} className="list-row">
          <code className="grow">{shareUrl(share.id)}</code>
          <button className="btn" onClick={async () => toast((await copyText(shareUrl(share.id))) ? "Link copied." : "Copying is blocked in this browser.")}>Copy</button>
          <button className="btn ghost danger" onClick={() => void stop(share.id)}>Stop sharing</button>
        </div>
      ))}
      <div><button className="btn primary" onClick={() => void create()}>Create a link</button></div>
    </div>
  );
}
