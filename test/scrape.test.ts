import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, reset } from '../src/db/client.js';
import { rulesExtractor } from '../src/extract/rules.js';
import { runScrape } from '../src/jobs/scrape.js';
import { AliasTable } from '../src/merchants/normalize.js';
import { bestFor, loadBaselines } from '../src/rank/best.js';
import { epiAdapter } from '../src/sources/amex.js';

const URL_ = process.env.TEST_DATABASE_URL ?? 'postgres://clubs:clubs@localhost:5432/clubs_test';
const sql = connect(URL_);
const HOME = 'https://rewards.americanexpress.co.il/';
const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'amex-home.html'), 'utf8');
const aliases = new AliasTable([]);
const adapter = epiAdapter('amex', HOME);

/** Serves the fixture as the home page and an empty-but-valid page for each category. */
function site(home = fixture, failCategories = false) {
  const empty = '<script>window.epi = {"CurrentPage":{"Benefits":[]}};</script>';
  return async (url: string) => {
    if (url === HOME) return home;
    if (failCategories) throw new Error('HTTP 503');
    return empty;
  };
}

/** Everything a run decides, without the timestamps that move on every run. */
async function snapshot() {
  return sql`
    SELECT club_id, source_offer_key, parent_key, merchant_raw, type, percent, amount_off, price, regular_price,
           face_value, min_spend, points_cost, status, content_hash, version, gone_at IS NULL AS live
    FROM offers ORDER BY source_offer_key`;
}

beforeEach(async () => {
  await reset(sql, URL_);
});

afterAll(async () => {
  await sql.end();
});

describe('runScrape', () => {
  it('stores every benefit on the first run', async () => {
    const r = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    expect(r).toMatchObject({ skipped: false, pagesOk: 4, pagesFailed: 0, offersSeen: 21, offersChanged: 21, complete: true });
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM offers`;
    expect(row!.count).toBe(21);
  });

  it('does nothing on a second run the same day (completion marker)', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    const second = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    expect(second).toMatchObject({ skipped: true, reason: 'already done' });
  });

  it('run twice, diff empty: a forced rerun changes nothing', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    const before = await snapshot();
    const again = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13', force: true });
    expect(again.offersChanged).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('bumps the version only of an offer whose facts changed', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    const changed = fixture.replace('אמפי תל אביב - 50 ש\\"ח הנחה לכרטיס בתוספת 305 נקודות', 'אמפי תל אביב - 70 ש\\"ח הנחה לכרטיס בתוספת 305 נקודות');
    expect(changed).not.toBe(fixture);
    const r = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(changed), period: '2026-10-14' });
    expect(r.offersChanged).toBe(1);
    const [row] = await sql`SELECT amount_off, version FROM offers WHERE source_offer_key = '34706'`;
    expect(row).toMatchObject({ amount_off: '70', version: 2 });
  });

  it('never lets a placeholder overwrite a real listing stored earlier', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    // Next day the site serves variant 3103 under its parent's name only.
    const placeholder = fixture.replace('1 פלוס 1 לכרטיס תמורת 440 נקודות לספארי רמת גן', 'ספארי רמת גן - 1+1 לכרטיס');
    expect(placeholder).not.toBe(fixture);
    const r = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(placeholder), period: '2026-10-14' });
    expect(r.offersChanged).toBe(0);
    const [row] = await sql`SELECT name, points_cost, version, gone_at FROM offers WHERE source_offer_key = '3103'`;
    expect(row).toMatchObject({ name: '1 פלוס 1 לכרטיס תמורת 440 נקודות לספארי רמת גן', points_cost: 440, version: 1, gone_at: null });
  });

  it('marks an offer gone only after a complete run that no longer lists it', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    const without = fixture.replace('"BenefitId": 2165', '"BenefitId": 999002165');
    expect(without).not.toBe(fixture);

    // Category pages fail: the run is incomplete, so nothing is marked gone.
    const partial = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(without, true), period: '2026-10-14' });
    expect(partial.complete).toBe(false);
    expect(partial.markedGone).toBe(0);
    const [still] = await sql`SELECT gone_at FROM offers WHERE source_offer_key = '2165'`;
    expect(still!.gone_at).toBeNull();

    const full = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(without), period: '2026-10-15' });
    expect(full.complete).toBe(true);
    expect(full.markedGone).toBe(1);
    const [gone] = await sql`SELECT gone_at FROM offers WHERE source_offer_key = '2165'`;
    expect(gone!.gone_at).not.toBeNull();
  });

  it('sends a failed page to the dead-letter queue', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(fixture, true), period: '2026-10-13' });
    const rows = await sql`SELECT kind, error FROM dlq ORDER BY id`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ kind: 'fetch', error: 'HTTP 503' });
  });

  it('lets a run with failed pages be retried the same day', async () => {
    const first = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(fixture, true), period: '2026-10-13' });
    expect(first.pagesFailed).toBeGreaterThan(0);
    const retry = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    expect(retry).toMatchObject({ skipped: false, pagesFailed: 0, complete: true });
  });

  it('records a run whose home page failed as failed, not done', async () => {
    const down = async () => {
      throw new Error('network: fetch failed');
    };
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: down, period: '2026-10-13' });
    const [run] = await sql`SELECT status FROM scrape_runs WHERE period = '2026-10-13'`;
    expect(run!.status).toBe('failed');
  });

  it('treats a members-only category page (Benefits: null) as empty, not broken', async () => {
    const personal = '<script>window.epi = {"CurrentPage":{"Benefits":null,"CategoryName":"הטבות נתב\\"ג","ChildCategories":[]}};</script>';
    const fetchBody = async (url: string) => (url === HOME ? fixture : personal);
    const r = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody, period: '2026-10-13' });
    expect(r).toMatchObject({ pagesOk: 4, pagesFailed: 0, complete: true });
  });

  it('keeps going past one unreadable category page, but marks the run incomplete', async () => {
    const fetchBody = async (url: string) => (url === HOME ? fixture : '<html>something else</html>');
    const r = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody, period: '2026-10-13' });
    expect(r).toMatchObject({ pagesOk: 1, pagesFailed: 3, offersSeen: 21, complete: false });
    const rows = await sql`SELECT kind FROM dlq`;
    expect(rows.map((x) => x.kind)).toEqual(['parse', 'parse', 'parse']);
  });

  it('fails the run, not silently empties it, when the home page layout changes', async () => {
    const r = await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site('<html>redesigned</html>'), period: '2026-10-13' });
    expect(r.complete).toBe(false);
    const [run] = await sql`SELECT status FROM scrape_runs WHERE period = '2026-10-13'`;
    expect(run!.status).toBe('failed');
    const [dlq] = await sql`SELECT kind FROM dlq`;
    expect(dlq!.kind).toBe('parse');
  });
});

describe('bestFor', () => {
  it('ranks a merchant\'s tier variants, fewer points first, and values them', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    const ranked = await bestFor(sql, "מקדונלד'ס", aliases, loadBaselines(), { now: new Date() });
    // The umbrella parent ("מקדונלד'ס - מגוון ארוחות רויאל ב- 22 ₪") gives way to its variants.
    expect(ranked.map((r) => r.name)).toEqual([
      "מגוון ארוחות רויאל במקדונלד'ס ב- 22 ש''ח במקום 51 ש''ח בתוספת 80 נקודות",
      "מגוון ארוחות רויאל במקדונלד'ס ב- 22 ש''ח במקום 51 ש''ח בתוספת 200 נקודות",
    ]);
    // ₪51 - ₪22 = ₪29 at P_valid 0.85.
    expect(ranked[0]!.score.expected).toBeCloseTo(24.6, 1);
  });

  it('uses the variants\' minimum spend instead of the umbrella\'s headline', async () => {
    await runScrape({ sql, adapter, extractor: rulesExtractor, aliases, fetchBody: site(), period: '2026-10-13' });
    const ranked = await bestFor(sql, 'רשת ה.שטרן', aliases, loadBaselines(), { now: new Date() });
    expect(ranked.map((r) => r.minSpend)).toEqual([3000, 3000]);
    // A ₪500 basket against a ₪3,000 minimum: the ₪350 is out of reach.
    expect(ranked[0]!.score.expected).toBe(0);
  });
});
