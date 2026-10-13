import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import type { AliasTable } from '../merchants/normalize.js';
import { CircuitBreaker, FetchFailure, type Fetcher } from '../net/fetcher.js';
import type { CrawlContext, SourceAdapter } from '../sources/adapter.js';
import { PageShapeError } from '../sources/epi.js';
import type { ExtractedTerms, Extractor, RawOffer } from '../types.js';

/**
 * One daily scrape of one club. Built to be run twice safely (Distributed
 * Task Reliability R10.1): a completion marker per club and day, a lease so
 * a crashed run can be taken over, UPSERTs keyed on the club's own offer id,
 * and a version bump only when the extracted facts actually change.
 */

export interface ScrapeOptions {
  sql: Sql;
  adapter: SourceAdapter;
  extractor: Extractor;
  aliases: AliasTable;
  /** Fetches a page body; defaults to fetcher.get when a Fetcher is given. */
  fetchBody?: (url: string) => Promise<string>;
  fetcher?: Fetcher;
  period?: string;
  force?: boolean;
  log?: (msg: string) => void;
}

export interface ScrapeResult {
  skipped: boolean;
  reason?: string;
  pagesOk: number;
  pagesFailed: number;
  offersSeen: number;
  offersChanged: number;
  needsReview: number;
  markedGone: number;
  complete: boolean;
}

const LEASE_MINUTES = 30;
/** A run that sees far fewer offers than the last complete run is not trusted to mark offers gone. */
const MIN_SHARE_OF_PREVIOUS = 0.7;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function factsHash(terms: ExtractedTerms, raw: RawOffer): string {
  const facts = { ...terms, name: raw.name, category: raw.category, outOfStock: raw.outOfStock, url: raw.url, parent: raw.parentKey };
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32);
}

export async function runScrape(opts: ScrapeOptions): Promise<ScrapeResult> {
  const { sql, adapter, extractor, aliases } = opts;
  const log = opts.log ?? (() => {});
  const period = opts.period ?? today();
  const club = adapter.club;
  const result: ScrapeResult = { skipped: false, pagesOk: 0, pagesFailed: 0, offersSeen: 0, offersChanged: 0, needsReview: 0, markedGone: 0, complete: false };

  // Claim the run: new row, or take over a failed run or an expired lease.
  const force = Boolean(opts.force);
  const claimed = await sql<{ id: number }[]>`
    INSERT INTO scrape_runs (club_id, period, status, lease_until)
    VALUES (${club}, ${period}, 'running', now() + make_interval(mins => ${LEASE_MINUTES}))
    ON CONFLICT (club_id, period) DO UPDATE
      SET status = 'running', lease_until = EXCLUDED.lease_until, started_at = now(), finished_at = NULL,
          pages_ok = 0, pages_failed = 0, offers_seen = 0, offers_changed = 0, complete = false
      WHERE scrape_runs.status = 'failed'
         OR (scrape_runs.status = 'running' AND scrape_runs.lease_until < now())
         OR ${force}
    RETURNING id`;
  if (claimed.length === 0) {
    const [row] = await sql<{ status: string }[]>`SELECT status FROM scrape_runs WHERE club_id = ${club} AND period = ${period}`;
    log(`${club} ${period}: already ${row?.status}, nothing to do`);
    return { ...result, skipped: true, reason: `already ${row?.status}` };
  }
  const runId = claimed[0]!.id;
  const runStart = new Date();

  const breaker = new CircuitBreaker(club, log);
  const fetchBody = opts.fetchBody ?? (async (url: string) => (await opts.fetcher!.get(url)).body);

  const get: CrawlContext['get'] = async (url, label) => {
    if (!breaker.allows) {
      result.pagesFailed++;
      return null;
    }
    try {
      const body = await fetchBody(url);
      const [source] = await sql<{ id: number }[]>`
        INSERT INTO sources (club_id, url, label, last_ok_at) VALUES (${club}, ${url}, ${label}, now())
        ON CONFLICT (club_id, url) DO UPDATE SET label = EXCLUDED.label, last_ok_at = now()
        RETURNING id`;
      const sha = createHash('sha256').update(body).digest('hex');
      await sql`INSERT INTO raw_snapshots (source_id, sha256, bytes) VALUES (${source!.id}, ${sha}, ${Buffer.byteLength(body)})
                ON CONFLICT (source_id, sha256) DO NOTHING`;
      breaker.record(true);
      result.pagesOk++;
      log(`ok   ${label} (${url})`);
      return body;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      breaker.record(false, msg);
      result.pagesFailed++;
      await sql`INSERT INTO dlq (club_id, kind, url, error) VALUES (${club}, 'fetch', ${url}, ${msg})`;
      log(`FAIL ${label} (${url}): ${msg}`);
      return null;
    }
  };

  const pageFailed: CrawlContext['pageFailed'] = async (url, label, error) => {
    // It was fetched, so it counted as ok; it was not usable, so it is a failure.
    result.pagesOk--;
    result.pagesFailed++;
    await sql`INSERT INTO dlq (club_id, kind, url, error) VALUES (${club}, 'parse', ${url}, ${error.message})`;
    log(`FAIL ${label} (${url}): unreadable page: ${error.message}`);
  };

  let offers: RawOffer[] = [];
  try {
    offers = await adapter.crawl({ get, pageFailed });
  } catch (e) {
    const kind = e instanceof PageShapeError ? 'parse' : 'fetch';
    const msg = e instanceof Error ? e.message : String(e);
    await sql`INSERT INTO dlq (club_id, kind, url, error) VALUES (${club}, ${kind}, ${adapter.homeUrl}, ${msg})`;
    await sql`UPDATE scrape_runs SET status = 'failed', finished_at = now(), pages_ok = ${result.pagesOk}, pages_failed = ${result.pagesFailed} WHERE id = ${runId}`;
    log(`${club}: crawl failed (${kind}): ${msg}`);
    return result;
  }

  const byKey = new Map(offers.map((o) => [o.sourceOfferKey, o]));
  const extracted = offers.map((raw) => ({ raw, terms: extractor.extract(raw, raw.parentKey ? byKey.get(raw.parentKey) ?? null : null) }));
  result.offersSeen = offers.length;
  result.needsReview = extracted.filter((x) => x.terms.status === 'needs_review').length;

  const [prev] = await sql<{ offers_seen: number }[]>`
    SELECT offers_seen FROM scrape_runs WHERE club_id = ${club} AND complete AND id <> ${runId} ORDER BY period DESC LIMIT 1`;
  const enoughOffers = !prev || offers.length >= prev.offers_seen * MIN_SHARE_OF_PREVIOUS;
  result.complete = result.pagesFailed === 0 && offers.length > 0 && enoughOffers;
  if (!enoughOffers) log(`${club}: saw ${offers.length} offers vs ${prev!.offers_seen} last time; not marking anything gone`);

  await sql.begin(async (tx) => {
    for (const { raw, terms } of extracted) {
      let merchantId: number | null = null;
      if (terms.merchantRaw) {
        const key = aliases.key(terms.merchantRaw);
        const [m] = await tx<{ id: number }[]>`
          INSERT INTO merchants (key, display_name) VALUES (${key}, ${terms.merchantRaw})
          ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
          RETURNING id`;
        merchantId = m!.id;
      }
      const hash = factsHash(terms, raw);
      if (raw.teaser) {
        // A teaser (home tile, or a variant shown under its parent's name)
        // never overwrites what a full listing told us earlier; it only
        // confirms the offer is still listed. Stored as-is only when new.
        const [seen] = await tx<{ revived: boolean }[]>`
          WITH prev AS (
            SELECT gone_at FROM offers WHERE club_id = ${club} AND source_offer_key = ${raw.sourceOfferKey}
          )
          UPDATE offers SET last_seen = now(), gone_at = NULL, version = version + CASE WHEN gone_at IS NOT NULL THEN 1 ELSE 0 END
          WHERE club_id = ${club} AND source_offer_key = ${raw.sourceOfferKey}
          RETURNING (SELECT gone_at IS NOT NULL FROM prev) AS revived`;
        if (seen) {
          if (seen.revived) result.offersChanged++;
          continue;
        }
      }
      // prev is read from the snapshot before this statement's write, so it
      // tells whether the row is new, revived, or carries different facts.
      const [row] = await tx<{ changed: boolean }[]>`
        WITH prev AS (
          SELECT content_hash, gone_at FROM offers WHERE club_id = ${club} AND source_offer_key = ${raw.sourceOfferKey}
        )
        INSERT INTO offers (
          club_id, source_offer_key, parent_key, merchant_id, merchant_raw, name, category, type,
          percent, amount_off, price, regular_price, face_value, min_spend, points_cost,
          points_required, requires_bonus, up_to, from_price, multi, tier_restricted, no_stacking, out_of_stock,
          status, review_reason, extractor, source_url, content_hash, last_seen, gone_at
        ) VALUES (
          ${club}, ${raw.sourceOfferKey}, ${raw.parentKey}, ${merchantId}, ${terms.merchantRaw}, ${raw.name}, ${raw.category}, ${terms.type},
          ${terms.percent}, ${terms.amountOff}, ${terms.price}, ${terms.regularPrice}, ${terms.faceValue}, ${terms.minSpend}, ${terms.pointsCost},
          ${terms.pointsRequired}, ${terms.requiresBonus}, ${terms.upTo}, ${terms.fromPrice}, ${terms.multi}, ${terms.tierRestricted}, ${terms.noStacking}, ${raw.outOfStock},
          ${terms.status}, ${terms.reviewReason}, ${extractor.name}, ${raw.url}, ${hash}, now(), NULL
        )
        ON CONFLICT (club_id, source_offer_key) DO UPDATE SET
          parent_key = EXCLUDED.parent_key, merchant_id = EXCLUDED.merchant_id, merchant_raw = EXCLUDED.merchant_raw,
          name = EXCLUDED.name, category = EXCLUDED.category, type = EXCLUDED.type,
          percent = EXCLUDED.percent, amount_off = EXCLUDED.amount_off, price = EXCLUDED.price,
          regular_price = EXCLUDED.regular_price, face_value = EXCLUDED.face_value, min_spend = EXCLUDED.min_spend,
          points_cost = EXCLUDED.points_cost, points_required = EXCLUDED.points_required, requires_bonus = EXCLUDED.requires_bonus,
          up_to = EXCLUDED.up_to, from_price = EXCLUDED.from_price, multi = EXCLUDED.multi,
          tier_restricted = EXCLUDED.tier_restricted, no_stacking = EXCLUDED.no_stacking, out_of_stock = EXCLUDED.out_of_stock,
          status = EXCLUDED.status, review_reason = EXCLUDED.review_reason, extractor = EXCLUDED.extractor,
          source_url = EXCLUDED.source_url, content_hash = EXCLUDED.content_hash,
          version = offers.version + CASE WHEN offers.content_hash <> EXCLUDED.content_hash OR offers.gone_at IS NOT NULL THEN 1 ELSE 0 END,
          last_seen = now(), gone_at = NULL
        RETURNING COALESCE((SELECT content_hash <> ${hash} OR gone_at IS NOT NULL FROM prev), true) AS changed`;
      if (row!.changed) result.offersChanged++;
    }
  });

  if (result.complete) {
    const gone = await sql`
      UPDATE offers SET gone_at = now() WHERE club_id = ${club} AND gone_at IS NULL AND last_seen < ${runStart} RETURNING id`;
    result.markedGone = gone.length;
  }

  // Any failed page leaves the run 'failed' so a later run the same day may
  // claim it again; the offers that did arrive are already stored.
  const status = result.pagesFailed > 0 ? 'failed' : 'done';
  await sql`
    UPDATE scrape_runs SET status = ${status}, finished_at = now(), pages_ok = ${result.pagesOk}, pages_failed = ${result.pagesFailed},
      offers_seen = ${result.offersSeen}, offers_changed = ${result.offersChanged}, complete = ${result.complete}
    WHERE id = ${runId}`;
  log(`${club} ${period}: ${result.offersSeen} offers (${result.needsReview} need review), ${result.pagesOk} pages ok, ${result.pagesFailed} failed, ${result.markedGone} gone, complete=${result.complete}`);
  return result;
}

export { FetchFailure };
