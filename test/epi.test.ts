import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { benefitsFromPage, categoryLinks, mergeBenefits, PageShapeError, readEpi, stripHtml } from '../src/sources/epi.js';
import type { RawOffer } from '../src/types.js';

const BASE = 'https://rewards.americanexpress.co.il/';
const html = readFileSync(join(import.meta.dirname, 'fixtures', 'amex-home.html'), 'utf8');

describe('readEpi', () => {
  it('reads the object even when strings contain braces and escaped quotes', () => {
    const page = `<script>window.epi = {"a":"x } y","b":"say \\"hi\\" {","c":{"d":1}};</script>`;
    expect(readEpi(page)).toEqual({ a: 'x } y', b: 'say "hi" {', c: { d: 1 } });
  });

  it('fails loudly when the model is missing', () => {
    expect(() => readEpi('<html>no model</html>')).toThrow(PageShapeError);
  });
});

describe('benefitsFromPage', () => {
  const offers = benefitsFromPage(html, 'amex', BASE);
  const byKey = new Map(offers.map((o) => [o.sourceOfferKey, o]));

  it('returns parents, their tier variants and the hot benefits, once each', () => {
    // 8 parents + 10 children + 3 category hot benefits in the fixture.
    expect(offers).toHaveLength(21);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(21);
    expect(offers.filter((o) => o.teaser).map((o) => o.sourceOfferKey)).toEqual(['34659', '2172', '35674']);
  });

  it('lets a full listing replace a home-page teaser tile with the same id', () => {
    const all = new Map<string, RawOffer>();
    mergeBenefits(all, offers);
    const full = { ...byKey.get('35674')!, name: 'קו רקיע 2026 - 60 ש"ח הנחה לכרטיס', teaser: undefined };
    mergeBenefits(all, [full]);
    expect(all.get('35674')!.name).toBe('קו רקיע 2026 - 60 ש"ח הנחה לכרטיס');
    // ...but a teaser never replaces a full listing.
    mergeBenefits(all, [{ ...full, name: 'מתחם ההופעות קו רקיע', teaser: true }]);
    expect(all.get('35674')!.name).toBe('קו רקיע 2026 - 60 ש"ח הנחה לכרטיס');
  });

  it('links each tier variant to its parent and inherits the category', () => {
    const child = byKey.get('3103')!;
    expect(child.parentKey).toBe('2214');
    expect(child.name).toBe('1 פלוס 1 לכרטיס תמורת 440 נקודות לספארי רמת גן');
    expect(child.category).toBe('בילוי ופנאי למשפחה');
  });

  it('marks a tier variant that only repeats its parent name as a placeholder', () => {
    const page = (childName: string) =>
      `<script>window.epi = ${JSON.stringify({
        CurrentPage: { Benefits: [{ BenefitId: 2214, MobileBenefitName: 'ספארי רמת גן - 1+1 לכרטיס', ChildBenefits: [{ BenefitId: 3103, MobileBenefitName: childName }] }] },
      })};</script>`;
    const placeholder = benefitsFromPage(page('ספארי רמת גן - 1+1 לכרטיס'), 'amex', BASE).find((o) => o.sourceOfferKey === '3103')!;
    expect(placeholder.teaser).toBe(true);

    // Whichever page comes first, the real variant name wins.
    const real = benefitsFromPage(page('1 פלוס 1 לכרטיס תמורת 440 נקודות לספארי רמת גן'), 'amex', BASE);
    for (const order of [[[placeholder], real], [real, [placeholder]]]) {
      const all = new Map<string, RawOffer>();
      for (const list of order) mergeBenefits(all, list);
      expect(all.get('3103')!.name).toBe('1 פלוס 1 לכרטיס תמורת 440 נקודות לספארי רמת גן');
    }
  });

  it('makes benefit links absolute and conditions plain text', () => {
    const o = byKey.get('2214')!;
    expect(o.url.startsWith('https://rewards.americanexpress.co.il/link/')).toBe(true);
    expect(o.conditions).not.toMatch(/<[a-z]/i);
  });

  it('throws when a page has no benefits list (a changed layout, not an empty day)', () => {
    expect(() => benefitsFromPage('<script>window.epi = {"CurrentPage":{}};</script>', 'amex', BASE)).toThrow(PageShapeError);
  });

  it('lists the category pages to crawl', () => {
    const cats = categoryLinks(html, BASE);
    expect(cats.map((c) => c.name)).toEqual(['נופש חו"ל', 'טרקלינים בעולם', 'תרבות ופנאי']);
    expect(cats[0]!.url).toBe('https://rewards.americanexpress.co.il/link/c160821e32b347bf8b259a5c8d138e1c.aspx');
  });
});

describe('stripHtml', () => {
  it('keeps list items apart and decodes entities', () => {
    expect(stripHtml('<p>א&nbsp;ב</p><ol><li>אחת</li><li>&quot;שתיים&quot;</li></ol>')).toBe('א ב | אחת | "שתיים"');
  });

  it('drops a tag cut off at the end of a truncated field', () => {
    expect(stripHtml('<p>ללא כפל מבצעים</p><span style="color: #000')).toBe('ללא כפל מבצעים');
  });
});
