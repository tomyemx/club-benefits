import type { ExtractedTerms } from '../types.js';

/**
 * Expected shekels saved, from the build plan:
 *   E = P_valid × P_applicable × H × V(B) − C
 * B is the typical basket for the merchant's category. Pure functions only.
 */

export interface Baseline {
  basket: number;
  unitPrice: number;
  wantSecond: number;
}

export type SourceKind = 'official' | 'scraped' | 'crowd';
export type Badge = 'High' | 'Medium' | 'Low';

export interface ScoreInput {
  terms: Pick<
    ExtractedTerms,
    | 'type' | 'percent' | 'amountOff' | 'price' | 'regularPrice' | 'faceValue' | 'minSpend'
    | 'pointsCost' | 'upTo' | 'fromPrice' | 'multi' | 'tierRestricted'
  >;
  baseline: Baseline;
  source: SourceKind;
  /** Days since the offer was last seen on its source page. */
  ageDays: number;
  /** Share of the basket the offer excludes (sale items, tobacco...). */
  excludedShare?: number;
  /** Override when applicability is known; otherwise derived (0.5 for tier-limited). */
  pApplicable?: number;
  /** Extra haircut reasons the caller knows of ("selected items"). */
  vague?: boolean;
  /** ₪ per loyalty point. 0 means points are shown, not priced. */
  pointValue?: number;
  /** Membership fee per use. */
  feePerUse?: number;
}

export interface Score {
  /** null when the offer can't be valued from what it states. */
  expected: number | null;
  value: number | null;
  /** How V(B) was obtained: from the offer's own numbers, or from a baseline assumption. */
  basis: 'explicit' | 'baseline' | 'none';
  badge: Badge;
  pValid: number;
  pApplicable: number;
  haircut: number;
}

/** Value of a forced top-up to reach a minimum spend (0..1). */
export const TOP_UP_VALUE = 0.3;
/** "Up to X" is worth about half its ceiling (RetailMeNot 2014: 43% advertised, 23% realised). */
export const UP_TO_FACTOR = 0.5;

export function pValidFor(source: SourceKind, ageDays: number): number {
  if (source === 'official') return 0.95;
  if (source === 'crowd') return 0.6;
  const weeks = Math.max(0, ageDays) / 7;
  return Math.max(0, 0.85 * (1 - 0.02 * weeks));
}

export function valueOf(input: ScoreInput): { value: number | null; basis: Score['basis'] } {
  const { terms: t, baseline: b } = input;
  const eligible = b.basket * (1 - (input.excludedShare ?? 0));
  switch (t.type) {
    case 'percent': {
      if (t.percent == null) return { value: null, basis: 'none' };
      const p = t.upTo ? t.percent * UP_TO_FACTOR : t.percent;
      return { value: (p / 100) * eligible, basis: 'baseline' };
    }
    case 'fixed_off': {
      if (t.amountOff == null) return { value: null, basis: 'none' };
      let f = t.upTo ? t.amountOff * UP_TO_FACTOR : t.amountOff;
      if (t.minSpend != null && b.basket < t.minSpend) {
        f = Math.max(0, f - (t.minSpend - b.basket) * TOP_UP_VALUE);
        return { value: f, basis: 'baseline' };
      }
      return { value: f, basis: 'explicit' };
    }
    case 'fixed_price':
      if (t.price != null && t.regularPrice != null) {
        return { value: Math.max(0, t.regularPrice - t.price), basis: 'explicit' };
      }
      // A price with nothing to compare it to can't be valued honestly.
      return { value: null, basis: 'none' };
    case 'voucher':
      if (t.faceValue != null && t.price != null) {
        return { value: Math.max(0, t.faceValue - t.price), basis: 'explicit' };
      }
      return { value: null, basis: 'none' };
    case 'bogo':
    case 'free_item':
      return { value: b.unitPrice * b.wantSecond, basis: 'baseline' };
    default:
      return { value: null, basis: 'none' };
  }
}

export function score(input: ScoreInput): Score {
  const { terms: t } = input;
  const { value, basis } = valueOf(input);
  const pValid = pValidFor(input.source, input.ageDays);
  const pApplicable = input.pApplicable ?? (t.tierRestricted ? 0.5 : 1);
  const vague = Boolean(input.vague || t.upTo || t.fromPrice || t.multi);
  const haircut = vague ? 0.5 : 1;
  const cost = (t.pointsCost ?? 0) * (input.pointValue ?? 0) + (input.feePerUse ?? 0);

  const expected = value == null ? null : round1(pValid * pApplicable * haircut * value - cost);
  return { expected, value: value == null ? null : round1(value), basis, badge: badgeFor(input, basis, vague), pValid, pApplicable, haircut };
}

/**
 * The plan's badge: High = open or official source, checked within 14
 * days, no "up to", conditions parsed. Medium = one of those fails. Low =
 * "up to", crowd-only, older than 60 days, or no value at all.
 */
export function badgeFor(input: Pick<ScoreInput, 'terms' | 'source' | 'ageDays'>, basis: Score['basis'], vague: boolean): Badge {
  if (basis === 'none') return 'Low';
  if (input.terms.upTo || input.source === 'crowd' || input.ageDays > 60) return 'Low';
  const misses = [input.ageDays > 14, vague].filter(Boolean).length;
  return misses === 0 ? 'High' : misses === 1 ? 'Medium' : 'Low';
}

const BADGE_RANK: Record<Badge, number> = { High: 2, Medium: 1, Low: 0 };

/**
 * Sort by expected saving, unvalued offers last. A Low offer never sits
 * above a High one unless it is worth more than 15% more.
 */
export function rank<T extends { score: Score }>(items: T[]): T[] {
  const sorted = [...items].sort((a, b) => (b.score.expected ?? -Infinity) - (a.score.expected ?? -Infinity));
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]!.score;
      const b = sorted[i + 1]!.score;
      if (a.expected == null || b.expected == null) continue;
      if (BADGE_RANK[a.badge] === 0 && BADGE_RANK[b.badge] === 2 && a.expected <= b.expected * 1.15) {
        [sorted[i], sorted[i + 1]] = [sorted[i + 1]!, sorted[i]!];
        swapped = true;
      }
    }
  }
  return sorted;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
