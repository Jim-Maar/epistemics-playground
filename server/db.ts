/**
 * The Supabase Postgres database (organization "Epistemics Eval Project", project
 * epistemics-playground). The schema lives in migrations/ and is applied by scripts/migrate.ts.
 */
import { SQL } from "bun";
import { config } from "./config";

export const sql = new SQL(config.databaseUrl, { max: 10 });

/** Runs that were queued or running when the server stopped can never finish now. */
export async function markInterruptedRuns() {
  await sql`update runs set status = 'error', error = 'Interrupted by a server restart.', finished_at = now()
            where status in ('queued', 'running')`;
}
