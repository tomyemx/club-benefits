import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from '../db/client.js';
import { foldName, type AliasTable } from '../merchants/normalize.js';
import type { ClubId, ExtractedTerms } from '../types.js';
import { rank, score, type Baseline, type Score } from './score.js';

export type Baselines = Record<string, Baseline>;

export function loadBaselines(path = join(import.meta.dirname, '..', '..', 'data', 'category-baselines.json')): Baselines {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const out: Baselines = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith('_')) out[k] = v as Baseline;
  return out;
}

export interface RankedOffer {
  club: ClubId;
  merchant: string;
  name: string;
  category: string | null;
  url: string;
  pointsCost: number | null;
  pointsRequired: boolean;
  requiresBonus: boolean;
  minSpend: number | null;
  /** The basket assumption the estimate used, in ₪. */
  basket: number;
  /** The baseline assumption behind the estimate, in words, when there is one. */
  assumption: string | null;
  lastSeen: Date;
  score: Score;
}

interface OfferRow {
  club_id: ClubId;
  display_name: string;
  name: string;
  category: string | null;
  source_url: string;
  type: ExtractedTerms['type'];
  percent: string | null;
  amount_off: string | null;
  price: string | null;
  regular_price: string | null;
  face_value: string | null;
  min_spend: string | null;
  points_cost: number | null;
  points_required: boolean;
  requires_bonus: boolean;
  up_to: boolean;
  from_price: boolean;
  multi: boolean;
  tier_restricted: boolean;
  last_seen: Date;
}

const n = (v: string | null) => (v == null ? null : Number(v));

/** Say which editable baseline (data/category-baselines.json) an estimate leans on. */
export function assumptionFor(type: ExtractedTerms['type'], minSpend: number | null, b: Baseline, s: Score): string | null {
  if (s.basis !== 'baseline') return null;
  if (type === 'bogo' || type === 'free_item') return `assumes a ₪${b.unitPrice} item, wanted ${Math.round(b.wantSecond * 100)}% of the time`;
  if (minSpend != null && b.basket < minSpend) return `for a ₪${b.basket} basket; minimum spend ₪${minSpend.toLocaleString('en-US')}`;
  return `assumes a ₪${b.basket} basket`;
}

/**
 * Live offers for a merchant, scored and ranked. The query is matched on the
 * canonical key first; when nothing matches exactly, on keys that contain it.
 */
export async function bestFor(
  sql: Sql,
  query: string,
  aliases: AliasTable,
  baselines: Baselines,
  opts: { clubs?: ClubId[]; pointValue?: number; now?: Date } = {},
): Promise<RankedOffer[]> {
  const key = aliases.key(query);
  const clubs = opts.clubs ?? ['amex', 'isracard'];
  // A parent listing with live, readable tier variants is an umbrella: its
  // name often omits conditions the variants state (a minimum spend, the
  // points price), so the variants stand in for it.
  const select = (where: ReturnType<Sql>) => sql<OfferRow[]>`
    SELECT o.*, m.display_name FROM offers o JOIN merchants m ON m.id = o.merchant_id
    WHERE o.gone_at IS NULL AND o.status = 'parsed' AND NOT o.out_of_stock
      AND o.club_id IN ${sql(clubs)} AND ${where}
      AND NOT EXISTS (
        SELECT 1 FROM offers c
        WHERE c.club_id = o.club_id AND c.parent_key = o.source_offer_key AND c.gone_at IS NULL AND c.status = 'parsed'
      )`;
  let rows = await select(sql`m.key = ${key}`);
  if (rows.length === 0) rows = await select(sql`m.key LIKE ${'%' + foldName(query) + '%'}`);

  const now = opts.now ?? new Date();
  const items: RankedOffer[] = rows.map((r) => {
    const baseline = baselines[r.category ?? ''] ?? baselines.default!;
    const s = score({
      terms: {
        type: r.type,
        percent: n(r.percent),
        amountOff: n(r.amount_off),
        price: n(r.price),
        regularPrice: n(r.regular_price),
        faceValue: n(r.face_value),
        minSpend: n(r.min_spend),
        pointsCost: r.points_cost,
        upTo: r.up_to,
        fromPrice: r.from_price,
        multi: r.multi,
        tierRestricted: r.tier_restricted,
      },
      baseline,
      source: 'scraped',
      ageDays: (now.getTime() - r.last_seen.getTime()) / 86_400_000,
      pointValue: opts.pointValue ?? 0,
    });
    return {
      club: r.club_id,
      merchant: r.display_name,
      name: r.name,
      category: r.category,
      url: r.source_url,
      pointsCost: r.points_cost,
      pointsRequired: r.points_required,
      requiresBonus: r.requires_bonus,
      minSpend: n(r.min_spend),
      basket: baseline.basket,
      assumption: assumptionFor(r.type, n(r.min_spend), baseline, s),
      lastSeen: r.last_seen,
      score: s,
    };
  });
  // Among equal savings, fewer points first.
  items.sort((a, b) => (a.pointsCost ?? 0) - (b.pointsCost ?? 0));
  return rank(items);
}
