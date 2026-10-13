import { describe, expect, it } from 'vitest';
import { pValidFor, rank, score, type Score, type ScoreInput } from '../src/rank/score.js';

const NONE = {
  percent: null, amountOff: null, price: null, regularPrice: null, faceValue: null, minSpend: null,
  pointsCost: null, upTo: false, fromPrice: false, multi: false, tierRestricted: false,
} as const;

const pharmacy = { basket: 300, unitPrice: 30, wantSecond: 0.8 };

function input(terms: Partial<ScoreInput['terms']> & Pick<ScoreInput['terms'], 'type'>, extra: Partial<ScoreInput> = {}): ScoreInput {
  return { terms: { ...NONE, ...terms }, baseline: pharmacy, source: 'scraped', ageDays: 1 / 7, ...extra };
}

describe('the plan doc worked examples (pharmacy, B = ₪300, scraped yesterday)', () => {
  // ageDays 0 so P_valid is exactly 0.85, as in the doc's table.
  it('A: 10% off excluding sale items (20% of basket) -> ₪20.4, High', () => {
    const s = score(input({ type: 'percent', percent: 10 }, { excludedShare: 0.2, ageDays: 0 }));
    expect(s.value).toBe(24);
    expect(s.expected).toBe(20.4);
    expect(s.badge).toBe('High');
  });

  it('B: ₪50 off a ₪400 minimum -> ₪17.0, High', () => {
    const s = score(input({ type: 'fixed_off', amountOff: 50, minSpend: 400 }, { ageDays: 0 }));
    expect(s.value).toBe(20);
    expect(s.expected).toBe(17);
    expect(s.badge).toBe('High');
  });

  it('C: up to 25% on selected items, applicability unknown -> ₪8.0, Low', () => {
    const s = score(input({ type: 'percent', percent: 25, upTo: true }, { vague: true, pApplicable: 0.5, ageDays: 0 }));
    expect(s.value).toBe(37.5);
    expect(s.expected).toBe(8);
    expect(s.badge).toBe('Low');
  });
});

describe('valuation', () => {
  it('values a price only against a stated regular price', () => {
    expect(score(input({ type: 'fixed_price', price: 22, regularPrice: 51 })).value).toBe(29);
    const bare = score(input({ type: 'fixed_price', price: 75 }));
    expect(bare.expected).toBeNull();
    expect(bare.badge).toBe('Low');
  });

  it('values a voucher as face minus price', () => {
    expect(score(input({ type: 'voucher', faceValue: 200, price: 140 })).value).toBe(60);
  });

  it('values 1+1 as one unit times the chance it was wanted', () => {
    expect(score(input({ type: 'bogo' }, { baseline: { basket: 90, unitPrice: 45, wantSecond: 0.8 } })).value).toBe(36);
  });

  it('subtracts points only when a point value is given', () => {
    const t = { type: 'fixed_off', amountOff: 50, pointsCost: 300 } as const;
    expect(score(input(t, { ageDays: 0 })).expected).toBe(42.5);
    expect(score(input(t, { ageDays: 0, pointValue: 0.05 })).expected).toBe(27.5);
  });

  it('halves applicability for a tier-limited offer', () => {
    expect(score(input({ type: 'fixed_off', amountOff: 100, tierRestricted: true }, { ageDays: 0 })).expected).toBe(42.5);
  });
});

describe('freshness and badge', () => {
  it('decays scraped validity about 2% a week', () => {
    expect(pValidFor('scraped', 0)).toBe(0.85);
    expect(pValidFor('scraped', 35)).toBeCloseTo(0.85 * 0.9, 5);
    expect(pValidFor('official', 100)).toBe(0.95);
  });

  it('drops to Medium after 14 days and Low after 60', () => {
    const t = { type: 'fixed_off', amountOff: 50 } as const;
    expect(score(input(t, { ageDays: 10 })).badge).toBe('High');
    expect(score(input(t, { ageDays: 20 })).badge).toBe('Medium');
    expect(score(input(t, { ageDays: 61 })).badge).toBe('Low');
  });
});

describe('rank', () => {
  const s = (expected: number | null, badge: Score['badge']): { score: Score; id: string } => ({
    id: `${expected}-${badge}`,
    score: { expected, value: expected, basis: 'explicit', badge, pValid: 0.85, pApplicable: 1, haircut: 1 },
  });

  it('sorts by expected saving with unvalued offers last', () => {
    expect(rank([s(null, 'Low'), s(10, 'High'), s(30, 'High')]).map((x) => x.id)).toEqual(['30-High', '10-High', 'null-Low']);
  });

  it('keeps a Low offer below a High one unless it is worth more than 15% more', () => {
    expect(rank([s(11, 'Low'), s(10, 'High')]).map((x) => x.id)).toEqual(['10-High', '11-Low']);
    expect(rank([s(12, 'Low'), s(10, 'High')]).map((x) => x.id)).toEqual(['12-Low', '10-High']);
  });
});
