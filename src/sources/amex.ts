import type { RawOffer } from '../types.js';
import type { CrawlContext, SourceAdapter } from './adapter.js';
import { benefitsFromPage, categoryLinks, mergeBenefits, PageShapeError } from './epi.js';

/**
 * Amex IL benefits site, plain HTTP. The home page model lists the
 * category pages; each category page carries its benefits in window.epi.
 * Both Amex and Isracard share this crawl; only the fetching differs.
 */
export function epiAdapter(club: 'amex' | 'isracard', homeUrl: string): SourceAdapter {
  return {
    club,
    homeUrl,
    async crawl(ctx: CrawlContext): Promise<RawOffer[]> {
      const home = await ctx.get(homeUrl, 'home');
      if (home == null) return [];
      // A home page we can't read means the layout changed: let it throw.
      const all = new Map<string, RawOffer>();
      mergeBenefits(all, benefitsFromPage(home, club, homeUrl));
      for (const cat of categoryLinks(home, homeUrl)) {
        const body = await ctx.get(cat.url, cat.name);
        if (body == null) continue;
        try {
          mergeBenefits(all, benefitsFromPage(body, club, homeUrl));
        } catch (e) {
          if (!(e instanceof PageShapeError)) throw e;
          await ctx.pageFailed(cat.url, cat.name, e);
        }
      }
      return [...all.values()];
    },
  };
}

export const amex = epiAdapter('amex', 'https://rewards.americanexpress.co.il/');
