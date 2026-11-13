import { createHash, randomBytes } from "node:crypto";
import { LOGIN_ATTEMPTS_PER_WINDOW, LOGIN_WINDOW_MS, SESSION_LIFETIME_MS, config } from "./config";
import { sql } from "./db";
import { HttpError } from "./http";

/** A checked session is trusted this long before the database is asked again. */
const SESSION_CACHE_MS = 60_000;
/** last_seen_at is written at most this often per session. */
const LAST_SEEN_WRITE_MS = 60 * 60 * 1000;

const failedLogins = new Map<string, number[]>();
const sessionCache = new Map<string, { browserId: string; checkedAt: number; lastSeenAt: number }>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

export function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

function recentFailures(ip: string): number[] {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const attempts = (failedLogins.get(ip) ?? []).filter((t) => t > cutoff);
  failedLogins.set(ip, attempts);
  return attempts;
}

export type LoginInput = { password: string; browserId: string; browserName: string; userAgent: string };

export async function login(input: LoginInput, ip: string): Promise<{ token: string; browserId: string; browserName: string }> {
  if (recentFailures(ip).length >= LOGIN_ATTEMPTS_PER_WINDOW) {
    throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  }
  if (!(await Bun.password.verify(input.password ?? "", config.passwordHash))) {
    recentFailures(ip).push(Date.now());
    throw new HttpError(401, "That password is not right.");
  }
  if (!input.browserId) throw new HttpError(400, "The browser sent no id.");
  const [browser] = await sql`
    insert into browsers (id, name, user_agent) values (${input.browserId}, ${input.browserName || "Browser"}, ${input.userAgent})
    on conflict (id) do update set user_agent = excluded.user_agent
    returning name`;
  const token = randomBytes(32).toString("hex");
  await sql`insert into sessions (token_hash, browser_id) values (${hashToken(token)}, ${input.browserId})`;
  return { token, browserId: input.browserId, browserName: browser.name };
}

/** Returns the browser id of a valid session, and keeps the session alive. */
export async function authenticate(request: Request): Promise<string> {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "Sign in first.");
  const tokenHash = hashToken(token);
  const now = Date.now();
  const cached = sessionCache.get(tokenHash);
  if (cached && now - cached.checkedAt < SESSION_CACHE_MS) return cached.browserId;
  const [session] = await sql`select browser_id, last_seen_at from sessions where token_hash = ${tokenHash}`;
  const lastSeenAt = session ? new Date(session.last_seen_at).getTime() : 0;
  if (!session || now - lastSeenAt > SESSION_LIFETIME_MS) {
    sessionCache.delete(tokenHash);
    throw new HttpError(401, "Sign in first.");
  }
  if (now - lastSeenAt > LAST_SEEN_WRITE_MS) await sql`update sessions set last_seen_at = now() where token_hash = ${tokenHash}`;
  sessionCache.set(tokenHash, { browserId: session.browser_id, checkedAt: now, lastSeenAt: now });
  return session.browser_id;
}

export async function logout(request: Request) {
  const tokenHash = hashToken(bearerToken(request));
  sessionCache.delete(tokenHash);
  await sql`delete from sessions where token_hash = ${tokenHash}`;
}

export async function logoutEverywhere() {
  sessionCache.clear();
  await sql`delete from sessions`;
}
