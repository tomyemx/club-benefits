import { join } from 'node:path';
import { connect, type Sql } from '../src/db/client.js';
import { AliasTable } from '../src/merchants/normalize.js';
import { loadBaselines, type Baselines } from '../src/rank/best.js';

/**
 * Server-side singletons for the page. One connection pool per process; in
 * dev, Next reloads modules, so the pool lives on globalThis.
 */
const g = globalThis as unknown as { __clubsSql?: Sql };

export function db(): Sql {
  g.__clubsSql ??= connect(process.env.DATABASE_URL);
  return g.__clubsSql;
}

const DATA = join(process.cwd(), 'data');

export function aliases(): AliasTable {
  return AliasTable.fromFile(join(DATA, 'merchant-aliases.csv'));
}

export function baselines(): Baselines {
  return loadBaselines(join(DATA, 'category-baselines.json'));
}
