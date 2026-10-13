import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { connect } from '../db/client.js';
import { AliasTable } from '../merchants/normalize.js';
import { bestFor, loadBaselines } from '../rank/best.js';
import type { ClubId } from '../types.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    clubs: { type: 'string' },
    'point-value': { type: 'string', default: '0' },
  },
});

const query = positionals.join(' ').trim();
if (!query) {
  console.error('usage: npm run best -- "<merchant>" [--clubs amex,isracard] [--point-value 0.05]');
  process.exit(2);
}

const aliases = AliasTable.fromFile(join(import.meta.dirname, '..', '..', 'data', 'merchant-aliases.csv'));
const sql = connect();
try {
  const ranked = await bestFor(sql, query, aliases, loadBaselines(), {
    clubs: values.clubs ? (values.clubs.split(',') as ClubId[]) : undefined,
    pointValue: Number(values['point-value']),
  });
  if (ranked.length === 0) {
    console.log(`No live, parsed offers for "${query}".`);
  } else {
    console.log(`${ranked.length} offer(s) for "${query}". Estimates only; the club's own terms bind.\n`);
    for (const [i, r] of ranked.entries()) {
      const s = r.score;
      const value = s.expected == null ? 'not valued' : `~₪${s.expected.toFixed(1)}`;
      const pts = r.pointsCost ? ` · ${r.pointsCost} points` : r.pointsRequired ? ' · points required' : '';
      const bonus = r.requiresBonus ? ' · uses a bonus benefit' : '';
      const basis = r.assumption && s.expected != null ? ` (${r.assumption})` : '';
      console.log(`${i + 1}. [${r.club}] ${value}${basis} · ${s.badge}${pts}${bonus}`);
      console.log(`   ${r.name}`);
      console.log(`   ${r.url}  (last seen ${r.lastSeen.toISOString().slice(0, 10)})`);
    }
  }
} finally {
  await sql.end();
}
