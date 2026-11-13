/** Applies the SQL files in migrations/ that the database has not seen yet, in name order. */
import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
const sql = new SQL(process.env.DATABASE_URL!);

await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
await sql`alter table schema_migrations enable row level security`;
const applied = new Set((await sql`select name from schema_migrations`).map((r: { name: string }) => r.name));
for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(name)) continue;
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
    await tx`insert into schema_migrations (name) values (${name})`;
  });
  console.log(`Applied ${name}`);
}
await sql.close();
