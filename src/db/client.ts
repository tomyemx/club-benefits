import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

export type Sql = postgres.Sql;

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

export function connect(url = process.env.DATABASE_URL ?? 'postgres://clubs:clubs@localhost:5432/clubs'): Sql {
  return postgres(url, { onnotice: () => {}, max: 4 });
}

/** Apply migrations/*.sql in name order, each once. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    applied.push(file);
  }
  return applied;
}

/** Drop and recreate everything. Refuses anything but a local database. */
export async function reset(sql: Sql, url: string): Promise<void> {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`refusing to reset non-local database at ${host}`);
  }
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql);
}
