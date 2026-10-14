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

/** The editable baseline (data/category-baselines.json) an estimate leans on. */
export type Assumption =
  | { kind: 'item'; unitPrice: number; wantSecond: number }
  | { kind: 'basket'; basket: number }
  | { kind: 'minSpend'; basket: number; minSpend: number };

export interface RankedOffer {
  club: ClubId;
  merchant: string;
  name: string;
  category: string | null;
  url: string;
  type: ExtractedTerms['type'];
  pointsCost: number | null;
  pointsRequired: boolean;
  requiresBonus: boolean;
  tierRestricted: boolean;
  minSpend: number | null;
  assumption: Assumption | null;
  lastSeen: Date;
  score: Score;
}

interface OfferRow {
  club_id: ClubId;
  merchant_id: number;
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

export function assumptionFor(type: ExtractedTerms['type'], minSpend: number | null, b: Baseline, s: Score): Assumption | null {
  if (s.basis !== 'baseline') return null;
  if (type === 'bogo' || type === 'free_item') return { kind: 'item', unitPrice: b.unitPrice, wantSecond: b.wantSecond };
  if (minSpend != null && b.basket < minSpend) return { kind: 'minSpend', basket: b.basket, minSpend };
  return { kind: 'basket', basket: b.basket };
}

export function describeAssumption(a: Assumption, lang: 'en' | 'he'): string {
  const ils = (x: number) => `₪${x.toLocaleString('en-US')}`;
  if (lang === 'en') {
    if (a.kind === 'item') return `assumes a ${ils(a.unitPrice)} item, wanted ${Math.round(a.wantSecond * 100)}% of the time`;
    if (a.kind === 'minSpend') return `for a ${ils(a.basket)} basket; minimum spend ${ils(a.minSpend)}`;
    return `assumes a ${ils(a.basket)} basket`;
  }
  // Hebrew writes the shekel sign after the number.
  const he = (x: number) => `${x.toLocaleString('he-IL')} ₪`;
  if (a.kind === 'item') return `בהנחה של פריט ב-${he(a.unitPrice)}, שהיה נקנה ב-${Math.round(a.wantSecond * 100)}% מהמקרים`;
  if (a.kind === 'minSpend') return `לסל של ${he(a.basket)}, ומינימום הקנייה ${he(a.minSpend)}`;
  return `בהנחה של סל קנייה ב-${he(a.basket)}`;
}

export interface RankOptions {
  clubs?: ClubId[];
  pointValue?: number;
  now?: Date;
}

const ALL_CLUBS: ClubId[] = ['amex', 'isracard'];

/**
 * Live, readable offers. A parent listing with live, readable tier variants
 * is an umbrella: its name often omits conditions the variants state (a
 * minimum spend, the points price), so the variants stand in for it.
 */
function liveOffers(sql: Sql, clubs: ClubId[], where: ReturnType<Sql>) {
  return sql<OfferRow[]>`
    SELECT o.*, m.display_name FROM offers o JOIN merchants m ON m.id = o.merchant_id
    WHERE o.gone_at IS NULL AND o.status = 'parsed' AND NOT o.out_of_stock
      AND o.club_id IN ${sql(clubs)} AND ${where}
      AND NOT EXISTS (
        SELECT 1 FROM offers c
        WHERE c.club_id = o.club_id AND c.parent_key = o.source_offer_key AND c.gone_at IS NULL AND c.status = 'parsed'
      )`;
}

function toRanked(rows: OfferRow[], baselines: Baselines, opts: RankOptions): (RankedOffer & { merchantId: number })[] {
  const now = opts.now ?? new Date();
  return rows.map((r) => {
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
      merchantId: r.merchant_id,
      club: r.club_id,
      merchant: r.display_name,
      name: r.name,
      category: r.category,
      url: r.source_url,
      type: r.type,
      pointsCost: r.points_cost,
      pointsRequired: r.points_required,
      requiresBonus: r.requires_bonus,
      tierRestricted: r.tier_restricted,
      minSpend: n(r.min_spend),
      assumption: assumptionFor(r.type, n(r.min_spend), baseline, s),
      lastSeen: r.last_seen,
      score: s,
    };
  });
}

function rankWithPointsTieBreak<T extends RankedOffer>(items: T[]): T[] {
  // Among equal savings, fewer points first.
  items.sort((a, b) => (a.pointsCost ?? 0) - (b.pointsCost ?? 0));
  return rank(items);
}

/**
 * Live offers for a merchant, scored and ranked. The query is matched on the
 * canonical key first; when nothing matches exactly, on keys that contain it.
 */
export async function bestFor(sql: Sql, query: string, aliases: AliasTable, baselines: Baselines, opts: RankOptions = {}): Promise<RankedOffer[]> {
  const clubs = opts.clubs ?? ALL_CLUBS;
  let rows = await liveOffers(sql, clubs, sql`m.key = ${aliases.key(query)}`);
  if (rows.length === 0) rows = await liveOffers(sql, clubs, sql`m.key LIKE ${'%' + foldName(query) + '%'}`);
  return rankWithPointsTieBreak(toRanked(rows, baselines, opts));
}

/**
 * The best offer of each merchant, ranked, for a "worth a look" list. Only
 * savings the offer states outright (₪ off, price vs. regular price, voucher
 * value) qualify: across categories, an estimate built on an assumed basket
 * would rank our assumptions, not the offers.
 */
export async function topDeals(sql: Sql, baselines: Baselines, opts: RankOptions & { limit?: number } = {}): Promise<RankedOffer[]> {
  const rows = await liveOffers(sql, opts.clubs ?? ALL_CLUBS, sql`true`);
  const stated = toRanked(rows, baselines, opts).filter((r) => r.score.basis === 'explicit' && r.score.expected != null && r.score.expected > 0);
  const ranked = rankWithPointsTieBreak(stated);
  const seen = new Set<number>();
  const out: RankedOffer[] = [];
  for (const r of ranked) {
    if (seen.has(r.merchantId)) continue;
    seen.add(r.merchantId);
    out.push(r);
    if (out.length >= (opts.limit ?? 12)) break;
  }
  return out;
}

/** Merchant names with at least one live, readable offer, for search suggestions. */
export async function merchantNames(sql: Sql, clubs: ClubId[] = ALL_CLUBS): Promise<string[]> {
  const rows = await sql<{ display_name: string }[]>`
    SELECT DISTINCT m.display_name FROM merchants m JOIN offers o ON o.merchant_id = m.id
    WHERE o.gone_at IS NULL AND o.status = 'parsed' AND o.club_id IN ${sql(clubs)}
    ORDER BY m.display_name`;
  return rows.map((r) => r.display_name);
}

export interface ClubStatus {
  club: ClubId;
  name: string;
  lastPeriod: string | null;
  lastFinishedAt: Date | null;
  lastComplete: boolean;
  liveOffers: number;
  needsReview: number;
}

/** When each club was last checked, and how much of it the rules could read. */
export async function clubStatus(sql: Sql): Promise<ClubStatus[]> {
  const rows = await sql<
    { id: ClubId; name: string; period: string | null; finished_at: Date | null; complete: boolean | null; live: number; review: number }[]
  >`
    SELECT c.id, c.name, r.period::text, r.finished_at, r.complete,
      (SELECT count(*)::int FROM offers o WHERE o.club_id = c.id AND o.gone_at IS NULL AND o.status = 'parsed') AS live,
      (SELECT count(*)::int FROM offers o WHERE o.club_id = c.id AND o.gone_at IS NULL AND o.status = 'needs_review') AS review
    FROM clubs c
    LEFT JOIN LATERAL (
      SELECT period, finished_at, complete FROM scrape_runs s WHERE s.club_id = c.id AND s.finished_at IS NOT NULL
      ORDER BY s.period DESC, s.finished_at DESC LIMIT 1
    ) r ON true
    ORDER BY c.id`;
  return rows.map((r) => ({
    club: r.id,
    name: r.name,
    lastPeriod: r.period,
    lastFinishedAt: r.finished_at,
    lastComplete: Boolean(r.complete),
    liveOffers: r.live,
    needsReview: r.review,
  }));
}
