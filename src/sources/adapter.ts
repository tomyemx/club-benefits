import type { ClubId, RawOffer } from '../types.js';

export interface CrawlContext {
  /**
   * Fetch one page. Returns the body, or null when the page failed; the job
   * records the failure, the breaker and the dead letter.
   */
  get(url: string, label: string): Promise<string | null>;
  /** A page arrived but could not be read; the run continues and is marked incomplete. */
  pageFailed(url: string, label: string, error: Error): Promise<void>;
}

export interface SourceAdapter {
  club: ClubId;
  homeUrl: string;
  /** Crawl every page the club lists and return its benefits, deduplicated. */
  crawl(ctx: CrawlContext): Promise<RawOffer[]>;
}
