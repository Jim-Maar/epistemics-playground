/**
 * The API server. GitHub Pages serves the web app; everything the app needs from the devbox
 * (sign-in, model calls, the devbox copy of each browser, share links) goes through here.
 * Caddy forwards https://159-195-131-30.sslip.io/playground/* to this port with the prefix removed.
 * All state lives in Supabase (see server/db.ts).
 */
import { randomBytes } from "node:crypto";
import { MODEL_LABEL, type RunEvent, type RunRequest } from "../shared/types";
import { authenticate, clientIp, login, logout, logoutEverywhere, type LoginInput } from "./auth";
import { config } from "./config";
import { markInterruptedRuns, sql } from "./db";
import { HttpError, corsHeaders, json, readJson } from "./http";
import {
  browserForRunnerToken,
  runnerSocketHandlers,
  runnerStatus,
  runnerToken,
  type RunnerSocketData,
} from "./runnerHub";
import { createRun, drain, latestDevboxUsage, stopRun, subscribe } from "./runs";

const SSE_KEEPALIVE_MS = 15_000;
const SYNC_KINDS = new Set(["nodes", "messages", "samples", "judges", "attachments", "scores"]);

type SyncChange = { kind: string; id: string; data: Record<string, unknown> & { updatedAt?: number; deleted?: number } };

function threadIdOf(kind: string, data: SyncChange["data"]): string | null {
  if (kind === "nodes") return data.kind === "thread" ? String(data.id) : null;
  return typeof data.threadId === "string" ? data.threadId : null;
}

/** Bulk upsert in one statement. A later write of the same record wins by updated_at. */
async function applySync(browserId: string, changes: SyncChange[]) {
  const rows = changes
    .filter((c) => SYNC_KINDS.has(c.kind) && typeof c.id === "string")
    .map((c) => ({
      browser_id: browserId,
      kind: c.kind,
      id: c.id,
      thread_id: threadIdOf(c.kind, c.data),
      data: c.data,
      deleted: Boolean(c.data.deleted),
      updated_at: new Date(c.data.updatedAt ?? Date.now()),
    }));
  if (rows.length > 0) {
    await sql`
      insert into entities ${sql(rows)}
      on conflict (browser_id, kind, id) do update set thread_id = excluded.thread_id, data = excluded.data,
        deleted = excluded.deleted, updated_at = excluded.updated_at
      where entities.updated_at <= excluded.updated_at`;
  }
  await sql`update browsers set last_sync_at = now() where id = ${browserId}`;
}

type Entity = { kind: string; data: unknown };

async function entitiesOf(browserId: string): Promise<Entity[]> {
  return sql`select kind, data from entities where browser_id = ${browserId} and not deleted`;
}

async function threadEntities(browserId: string, threadId: string): Promise<Entity[]> {
  return sql`select kind, data from entities
             where browser_id = ${browserId} and not deleted and (thread_id = ${threadId} or kind = 'judges')`;
}

async function browserList() {
  const rows = await sql`
    select b.id, b.name, b.last_sync_at,
      (select count(*) from entities e where e.browser_id = b.id and e.kind = 'nodes' and not e.deleted
        and e.data->>'kind' = 'thread')::int as threads
    from browsers b order by b.last_sync_at desc nulls last`;
  return rows.map((b: { id: string; name: string; last_sync_at: Date | null; threads: number }) => ({
    id: b.id, name: b.name, lastSyncAt: b.last_sync_at ? new Date(b.last_sync_at).getTime() : null, threadCount: b.threads,
  }));
}

async function me(browserId: string) {
  const [browser] = await sql`select name from browsers where id = ${browserId}`;
  const runner = runnerStatus(browserId);
  return {
    browserId,
    browserName: browser?.name ?? "This browser",
    model: MODEL_LABEL,
    apiAvailable: Boolean(config.anthropicApiKey),
    runner: { connected: runner.connected, name: runner.name },
    usage: { devbox: latestDevboxUsage(), own: runner.usage },
    maxConcurrentRuns: config.maxConcurrentRuns,
  };
}

async function runStream(browserId: string, runId: string, after: number): Promise<Response> {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  let push: ((seq: number, event: RunEvent) => void) | null = null;
  const pending: [number, RunEvent][] = [];
  const subscription = await subscribe(browserId, runId, after, (seq, event) => {
    if (push) push(seq, event);
    else pending.push([seq, event]);
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (seq: number, event: unknown) => {
        controller.enqueue(encoder.encode(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      const keepalive = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), SSE_KEEPALIVE_MS);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        subscription.unsubscribe();
        controller.close();
      };
      push = (seq, event) => {
        write(seq, event);
        if (event.type === "done" || event.type === "error") queueMicrotask(close);
      };
      subscription.replay.forEach((event, index) => write(subscription.startSeq + index + 1, event));
      for (const [seq, event] of pending) push(seq, event);
      const replayedFinal = subscription.replay.some((e) => e.type === "done" || e.type === "error");
      if (!subscription.live || replayedFinal) close();
      cleanup = close;
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
  });
}

async function route(request: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/health") return json({ ok: true });

  if (pathname === "/auth/login" && method === "POST") {
    const input = await readJson<LoginInput>(request);
    return json(await login({ ...input, userAgent: request.headers.get("user-agent") ?? "" }, clientIp(request)));
  }

  if (pathname.startsWith("/shares/") && pathname.endsWith("/view") && method === "GET") {
    await authenticate(request);
    const shareId = pathname.split("/")[2] ?? "";
    const [share] = await sql`select s.browser_id, s.thread_id, s.revoked, b.name from shares s
                              join browsers b on b.id = s.browser_id where s.id = ${shareId}`;
    if (!share) throw new HttpError(404, "This link does not exist.");
    if (share.revoked) throw new HttpError(410, "This link was turned off.");
    return json({
      browserName: share.name,
      threadId: share.thread_id,
      entities: await threadEntities(share.browser_id, share.thread_id),
    });
  }

  const browserId = await authenticate(request);

  if (pathname === "/me" && method === "GET") return json(await me(browserId));
  if (pathname === "/auth/logout" && method === "POST") {
    await logout(request);
    return json({ ok: true });
  }
  if (pathname === "/auth/logout-all" && method === "POST") {
    await logoutEverywhere();
    return json({ ok: true });
  }
  if (pathname === "/browser" && method === "PATCH") {
    const { name } = await readJson<{ name: string }>(request);
    if (!name?.trim()) throw new HttpError(400, "Give the browser a name.");
    await sql`update browsers set name = ${name.trim()} where id = ${browserId}`;
    return json(await me(browserId));
  }
  if (pathname === "/sync" && method === "POST") {
    const { changes } = await readJson<{ changes: SyncChange[] }>(request);
    await applySync(browserId, changes ?? []);
    return json({ ok: true });
  }
  if (pathname === "/browsers" && method === "GET") return json(await browserList());
  if (pathname.startsWith("/browsers/") && pathname.endsWith("/entities") && method === "GET") {
    return json(await entitiesOf(pathname.split("/")[2] ?? ""));
  }

  if (pathname === "/runs" && method === "POST") {
    createRun(browserId, await readJson<RunRequest>(request));
    return json({ ok: true });
  }
  const runMatch = pathname.match(/^\/runs\/([\w-]+)\/(stream|stop)$/);
  if (runMatch) {
    const [, runId, action] = runMatch;
    if (action === "stream" && method === "GET") {
      return await runStream(browserId, runId!, Number(url.searchParams.get("after") ?? 0));
    }
    if (action === "stop" && method === "POST") {
      stopRun(browserId, runId!);
      return json({ ok: true });
    }
  }

  if (pathname === "/shares" && method === "POST") {
    const { threadId } = await readJson<{ threadId: string }>(request);
    const id = randomBytes(16).toString("base64url");
    await sql`insert into shares (id, browser_id, thread_id) values (${id}, ${browserId}, ${threadId})`;
    return json({ id });
  }
  if (pathname === "/shares" && method === "GET") {
    const threadId = url.searchParams.get("threadId") ?? "";
    const shares = await sql`select id, created_at from shares
                             where browser_id = ${browserId} and thread_id = ${threadId} and not revoked order by created_at`;
    return json(shares.map((s: { id: string; created_at: Date }) => ({ id: s.id, createdAt: new Date(s.created_at).getTime() })));
  }
  const shareMatch = pathname.match(/^\/shares\/([\w-]+)$/);
  if (shareMatch && method === "DELETE") {
    await sql`update shares set revoked = true where id = ${shareMatch[1]!} and browser_id = ${browserId}`;
    return json({ ok: true });
  }

  if (pathname === "/runner/token" && method === "GET") return json({ token: await runnerToken(browserId) });

  throw new HttpError(404, "Not found.");
}

await markInterruptedRuns();

const server = Bun.serve<RunnerSocketData>({
  port: config.port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/runner/connect") {
      const browserId = await browserForRunnerToken(url.searchParams.get("token") ?? "");
      if (!browserId) return new Response("Unknown connector token.", { status: 401 });
      if (server.upgrade(request, { data: { browserId } })) return undefined as unknown as Response;
      return new Response("Expected a WebSocket.", { status: 400 });
    }

    let response: Response;
    try {
      response = await route(request, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      response = json({ error: (err as Error).message }, status);
    }
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  },
  websocket: runnerSocketHandlers,
});

console.log(`Epistemics Playground API listening on http://127.0.0.1:${server.port}`);

process.on("SIGTERM", async () => {
  console.log("Stopping: waiting for running model calls to finish.");
  await drain();
  process.exit(0);
});
