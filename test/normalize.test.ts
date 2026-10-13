import { describe, expect, it } from 'vitest';
import { AliasTable, foldName } from '../src/merchants/normalize.js';

describe('foldName (tier 1, orthography only)', () => {
  it.each([
    ["מקדונלד'ס", 'מקדונלדס'],
    ['רשת סינמה סיטי', 'סינמה סיטי'],
    ['שובר BUYME CHEF', 'buyme chef'],
    ['אתר טרמינל X', 'טרמינל x'],
    ['סופר - פארם', 'סופר פארם'],
    ['קריית מוצקין', 'קרית מוצקין'],
    ['  קולנוע   לב ', 'קולנוע לב'],
  ])('%s -> %s', (raw, folded) => {
    expect(foldName(raw)).toBe(folded);
  });

  it('keeps distinct places distinct: no prefix or substring folding', () => {
    // LLM Wiki p. 23: a rule that merges מודיעין and מודיעין-מכבים-רעות would also swallow מודיעין עילית.
    expect(foldName('מודיעין')).not.toBe(foldName('מודיעין עילית'));
    expect(foldName('מקדונלדס נתב"ג')).not.toBe(foldName("מקדונלד'ס"));
  });

  it('never strips a generic prefix down to nothing', () => {
    expect(foldName('רשת')).toBe('רשת');
  });
});

describe('AliasTable (tier 2, human-edited)', () => {
  const table = AliasTable.fromCsv(
    ['alias,canonical', '# a note', 'סופר פארם,סופר-פארם', 'super pharm,סופר-פארם', 'a,b', 'b,c'].join('\n'),
  );

  it('resolves both the stored name and the query to one key', () => {
    expect(table.key('סופר - פארם')).toBe(table.key('Super Pharm'));
    expect(table.key('סופר-פארם')).toBe(table.key('סופר פארם'));
  });

  it('follows exactly one hop, so a chain shows up as a gap, not a loop', () => {
    expect(table.key('a')).toBe('b');
    expect(table.key('b')).toBe('c');
  });

  it('passes unknown names through folded', () => {
    expect(table.key('רשת ה.שטרן')).toBe('ה.שטרן');
  });
});
