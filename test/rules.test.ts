import { describe, expect, it } from 'vitest';
import { extractTerms, rulesExtractor, splitName } from '../src/extract/rules.js';
import type { RawOffer } from '../src/types.js';

function raw(name: string, extra: Partial<RawOffer> = {}): RawOffer {
  return { club: 'amex', sourceOfferKey: '1', parentKey: null, name, conditions: '', category: null, url: 'https://x/', outOfStock: false, ...extra };
}

describe('splitName', () => {
  it.each([
    ['אמפי תל אביב - 50 ש"ח הנחה לכרטיס בתוספת נקודות', 'אמפי תל אביב'],
    ['קו רקיע 2026 - 60 ש"ח הנחה לכרטיס', 'קו רקיע'],
    ['סופר - פארם - 50 ש\'\'ח הנחה בתוספת נקודות', 'סופר - פארם'],
    ['מצנחי הים האדום - אבוב שכיבה - 1+1 לכרטיס', 'מצנחי הים האדום - אבוב שכיבה'],
    ['מועדוני GRAY- הנחה של 50 ש"ח לכרטיס', 'מועדוני GRAY'],
    ['"ברנרוק" בגבעת ברנר -50 ש\'\'ח הנחה לכרטיס', '"ברנרוק" בגבעת ברנר'],
    ['פיטר פן המחזמר –כרטיס החל מ 79 ש"ח', 'פיטר פן המחזמר'],
    ["פארק האטרקציות 'בא-לגן' - מבוגר חינם ברכישת כרטיס לילד", "פארק האטרקציות 'בא-לגן'"],
  ])('%s -> %s', (name, merchant) => {
    expect(splitName(name).merchant).toBe(merchant);
  });

  it('does not split on a one-letter prefix with a dash ("ב- 99")', () => {
    expect(splitName('מנוי ל 6 סרטים בקולנוע לב ב- 99 ש"ח בתוספת נקודות').merchant).toBeNull();
  });

  it('treats a GOLD program banner as no merchant', () => {
    expect(splitName('הטבה ללקוחות תכנית GOLD - שייק בגודל M ברשת rebar תמורת הטבת בונוס').merchant).toBeNull();
  });
});

describe('extractTerms on real Amex names (2026-10-13 capture)', () => {
  it.each([
    // [offer text, expected subset]
    ['50 ש"ח הנחה לכרטיס בתוספת 305 נקודות', { type: 'fixed_off', amountOff: 50, pointsCost: 305 }],
    ["הנחה של 60 ש''ח לכרטיס בתוספת נקודות", { type: 'fixed_off', amountOff: 60, pointsCost: null, pointsRequired: true }],
    ['הנחה של 16% בהשכרת רכבים בחו\'\'ל לכלל הלקוחות', { type: 'percent', percent: 16, tierRestricted: false }],
    ["הנחה של 20% בהשכרת רכבים בחו''ל ללקוחות הסנטוריון", { type: 'percent', percent: 20, tierRestricted: true }],
    ['הנחה של 7 אחוז נוספים על כל האתר וגם 1+1 על ביקור טעימות', { type: 'percent', percent: 7, multi: true }],
    ['1+1 לכרטיס', { type: 'bogo' }],
    ['1 פלוס 1 לכרטיס תמורת 440 נקודות לספארי רמת גן', { type: 'bogo', pointsCost: 440 }],
    ['מבוגר חינם ברכישת כרטיס לילד במחיר מלא', { type: 'bogo' }],
    ['כרטיס ב 49 ש"ח בתוספת 365 נקודות', { type: 'fixed_price', price: 49, pointsCost: 365 }],
    ['כרטיס ב- 75 ₪ למגוון הצגות', { type: 'fixed_price', price: 75 }],
    ['59 ₪ לכרטיס בתוספת נקודות', { type: 'fixed_price', price: 59 }],
    ['כרטיס החל מ 79 ש"ח בתוספת נקודות', { type: 'fixed_price', price: 79, fromPrice: true }],
    ["מגוון ארוחות רויאל במקדונלד'ס ב- 22 ש''ח במקום 51 ש''ח בתוספת 200 נקודות", { type: 'fixed_price', price: 22, regularPrice: 51, pointsCost: 200 }],
    ["ארוחת בוקר זוגית במחיר 109 ש''ח (במקום 169 ש''ח) תמורת הטבת בונוס", { type: 'fixed_price', price: 109, regularPrice: 169, requiresBonus: true }],
    ["שובר BUYME ALL בשווי 200 ש''ח ב- 140 ש''ח בלבד בתוספת 500 נקודות", { type: 'voucher', faceValue: 200, price: 140, pointsCost: 500 }],
    ["350 ש''ח הנחה ברכישה מעל 3,000 ש\"ח לרכישת תכשיטי יוקרה בתוספת 1,850 נקודות", { type: 'fixed_off', amountOff: 350, minSpend: 3000, pointsCost: 1850 }],
    ["עד 200 ש''ח הנחה בתוספת נקודות ברשת קרפור, על כל המוצרים", { type: 'fixed_off', amountOff: 200, upTo: true }],
    ['קרדיט רבעוני בסך 50 ש"ח (200 ש"ח שנתי) ללקוחות סנטוריון ופלטינה', { type: 'fixed_off', amountOff: 50, tierRestricted: true }],
    ['ארוחת מק רויאל במקדונלד\'ס נתב"ג ב-14.90 ₪ ללקוחות TIME OFF', { type: 'fixed_price', price: 14.9, tierRestricted: true }],
    ['פלטת פרובאנס ללא עלות בהזמנת מסלול טעימות זוגי', { type: 'free_item' }],
    ['מחיר מיוחד לאירוח זוגי והנחות על סדרת הבלנדים', { type: 'other' }],
    ['קרדיט רבעוני בסך 100 $ (400 $ שנתי)', { type: 'other' }],
  ] as const)('%s', (text, expected) => {
    expect(extractTerms(text)).toMatchObject(expected);
  });

  it('reads "no stacking" from the conditions', () => {
    expect(extractTerms('1+1 לכרטיס', 'למשלמים בכרטיס בלבד | ללא כפל מבצעים').noStacking).toBe(true);
  });
});

describe('rulesExtractor', () => {
  it('gives a tier variant its parent merchant', () => {
    const parent = raw('ספארי רמת גן - 1+1 לכרטיס', { sourceOfferKey: '2214' });
    const child = raw('1 פלוס 1 לכרטיס תמורת 440 נקודות לספארי רמת גן', { sourceOfferKey: '3103', parentKey: '2214' });
    expect(rulesExtractor.extract(child, parent)).toMatchObject({ merchantRaw: 'ספארי רמת גן', type: 'bogo', pointsCost: 440, status: 'parsed' });
  });

  it('marks what it cannot read for review instead of guessing', () => {
    expect(rulesExtractor.extract(raw('The Centurion Lounge'), null)).toMatchObject({ status: 'needs_review', reviewReason: 'no merchant in name' });
    expect(rulesExtractor.extract(raw('יקב לטם- מחיר מיוחד לאירוח זוגי'), null)).toMatchObject({
      merchantRaw: 'יקב לטם',
      status: 'needs_review',
      reviewReason: 'offer type not recognised',
    });
  });
});
