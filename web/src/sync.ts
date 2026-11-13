/**
 * Copies this browser's changes to the devbox. Only one tab runs the loop, chosen with a Web Lock.
 */
import { ApiError, post } from "./api";
import { db, type OutboxRec } from "./db";
import { syncErrorStore } from "./stores";

const SYNC_INTERVAL_MS = 700;
const SYNC_BATCH = 200;
const RETRY_DELAY_MS = 5000;

async function syncOnce(): Promise<boolean> {
  const entries = await db.outbox.limit(SYNC_BATCH).toArray();
  if (entries.length === 0) return false;
  const changes = [];
  for (const entry of entries) {
    const data = await db.table(entry.table).get(entry.id);
    if (data) changes.push({ kind: entry.table, id: entry.id, data });
  }
  await post("/sync", { changes });
  await db.transaction("rw", db.outbox, async () => {
    for (const entry of entries) {
      const current: OutboxRec | undefined = await db.outbox.get(entry.key);
      if (current && current.updatedAt === entry.updatedAt) await db.outbox.delete(entry.key);
    }
  });
  return entries.length === SYNC_BATCH;
}

async function loop(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const more = await syncOnce();
      syncErrorStore.set(null);
      if (!more) await new Promise((r) => setTimeout(r, SYNC_INTERVAL_MS));
    } catch (err) {
      syncErrorStore.set(err instanceof ApiError ? err.message : "Sync failed.");
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

let started = false;

export function startSync() {
  if (started) return;
  started = true;
  const controller = new AbortController();
  if (navigator.locks) void navigator.locks.request("playground-sync", () => loop(controller.signal));
  else void loop(controller.signal);
}
