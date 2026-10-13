import type { ClubId, RawOffer } from '../types.js';

/**
 * Amex IL and Isracard run the same benefits platform. Every page embeds
 * its model as `window.epi = {...}` inside a script tag; benefits sit in
 * CurrentPage.Benefits[], with tier variants in Benefits[].ChildBenefits[]
 * and a few more under Categories[].HotBenefits[].
 */

export class PageShapeError extends Error {}

/** Extract the JSON object assigned to window.epi, respecting strings. */
export function readEpi(html: string): unknown {
  const start = html.search(/window\.epi\s*=\s*\{/);
  if (start < 0) throw new PageShapeError('window.epi not found');
  const open = html.indexOf('{', start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return JSON.parse(html.slice(open, i + 1));
    }
  }
  throw new PageShapeError('window.epi is not closed');
}

interface EpiBenefit {
  BenefitId?: string | number;
  MobileBenefitName?: string | null;
  Name?: string | null;
  BenefitConditionText?: string | null;
  LinkUrl?: string | null;
  OutOfStock?: boolean | string | null;
  Category?: { Name?: string | null } | string | null;
  ChildBenefits?: EpiBenefit[] | null;
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|div)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    // A tag cut off at the end of a truncated field.
    .replace(/<[^>]*$/, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s*\|\s*(\|\s*)+/g, ' | ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .trim();
}

function categoryName(c: EpiBenefit['Category']): string | null {
  if (!c) return null;
  if (typeof c === 'string') {
    // Some payloads carry a Python-style repr: "{'Name': 'קולנוע', ...}".
    const m = c.match(/'Name':\s*'([^']*)'/);
    return m ? m[1]! : null;
  }
  return c.Name ?? null;
}

function toRaw(b: EpiBenefit, club: ClubId, baseUrl: string, parentKey: string | null, inheritedCategory: string | null): RawOffer | null {
  if (b.BenefitId == null) return null;
  const name = (b.MobileBenefitName ?? b.Name ?? '').trim();
  if (!name) return null;
  return {
    club,
    sourceOfferKey: String(b.BenefitId),
    parentKey,
    name,
    conditions: stripHtml(b.BenefitConditionText),
    category: categoryName(b.Category) ?? inheritedCategory,
    url: new URL(b.LinkUrl ?? '/', baseUrl).href,
    outOfStock: String(b.OutOfStock).toLowerCase() === 'true',
  };
}

/**
 * All benefits on a page, parents before their children, deduplicated by
 * id. Throws PageShapeError when the page has no benefits list at all, so a
 * changed layout is a loud failure rather than an empty success.
 */
export function benefitsFromPage(html: string, club: ClubId, baseUrl: string): RawOffer[] {
  const epi = readEpi(html) as {
    CurrentPage?: { Benefits?: EpiBenefit[] | null; Categories?: { HotBenefits?: EpiBenefit[] }[]; CategoryName?: unknown; ChildCategories?: unknown };
  };
  const page = epi.CurrentPage;
  if (!page) throw new PageShapeError('CurrentPage missing');
  // A personalised (members-only) category page sends Benefits: null to an
  // anonymous visitor. That is an empty page, not a changed layout.
  const isCategoryPage = 'CategoryName' in page || 'ChildCategories' in page;
  if (page.Benefits === null && isCategoryPage) return [];
  if (!Array.isArray(page.Benefits)) throw new PageShapeError('CurrentPage.Benefits missing');

  const out = new Map<string, RawOffer>();
  const add = (r: RawOffer | null) => {
    if (r && !out.has(r.sourceOfferKey)) out.set(r.sourceOfferKey, r);
  };
  for (const b of page.Benefits) {
    const parent = toRaw(b, club, baseUrl, null, null);
    add(parent);
    for (const child of b.ChildBenefits ?? []) {
      const r = toRaw(child, club, baseUrl, parent?.sourceOfferKey ?? null, parent?.category ?? null);
      // The site sometimes serves a tier variant under a copy of its parent's
      // name (seen 2026-10-13, varying by page and request). Such a copy is a
      // placeholder; the variant's own listing replaces it when any page has it.
      if (r && parent && r.name === parent.name) add({ ...r, teaser: true });
      else add(r);
    }
  }
  for (const cat of page.Categories ?? []) {
    for (const b of cat.HotBenefits ?? []) {
      const r = toRaw(b, club, baseUrl, null, null);
      if (r) add({ ...r, teaser: true });
    }
  }
  return [...out.values()];
}

/**
 * Merge benefits from several pages: first full listing wins, and a full
 * listing always replaces a teaser tile with the same id.
 */
export function mergeBenefits(into: Map<string, RawOffer>, list: RawOffer[]): void {
  for (const o of list) {
    const have = into.get(o.sourceOfferKey);
    if (!have || (have.teaser && !o.teaser)) into.set(o.sourceOfferKey, o);
  }
}

/** Category page links listed on the home page model. */
export function categoryLinks(html: string, baseUrl: string): { name: string; url: string }[] {
  const epi = readEpi(html) as { CurrentPage?: { Categories?: { Name?: string; LinkUrl?: string }[] } };
  return (epi.CurrentPage?.Categories ?? [])
    .filter((c) => c.LinkUrl)
    .map((c) => ({ name: c.Name ?? '', url: new URL(c.LinkUrl!, baseUrl).href }));
}
