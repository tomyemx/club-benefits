# club-benefits

Scrapes public Israeli discount-club benefit pages once a day, groups the offers by merchant, and ranks them by expected shekels saved, with a confidence badge.

Plan and decisions: the Claude Doc "Club Benefits Aggregator: build plan" and the Trove note "Discount-club aggregator: plan and decisions". This folder covers milestones M2 and M4: the Amex scraper, the ranking, and a Hebrew right-to-left web page (plus the same answers from a CLI).

## Quick start

```bash
# Node >= 22.21, Postgres 16 running locally
cp .env.example .env            # optional; these are the defaults
npm install
npm run db:migrate
npm run scrape -- amex          # ~40 s: 12 pages, 3 s apart
npm run build && npm start      # the page, at http://localhost:3000
npm run best -- "סינמה סיטי"    # the same answer in the terminal
npm test                        # needs the clubs_test database
npm run test:e2e                # builds, then drives the page in Chromium
```

## The page

- **Search** a merchant (the box suggests every merchant with a live offer), tick your clubs, and optionally say what a point is worth to you.
- **Each card** shows the estimate ("כ-51 ₪"), the confidence badge, the club, points or bonus requirements, how the number was reached ("שווי 60 ₪ × 0.85 סיכוי שההטבה עדיין בתוקף"), the assumption behind it, a link to the club's own page, and the date it was last seen.
- **With no search**, "שווה לבדוק" lists the best offer of each merchant, but only among offers that state their saving outright. Estimates that rest on an assumed basket appear when you search for that merchant, not in the overview, so the overview doesn't rank our own assumptions.
- The footer shows when each club was last checked, how many offers wait for manual review, and the disclaimer.
- No client-side JavaScript is needed: the form is a plain GET, so every result is a shareable URL.

Local databases, as used in development:

```bash
sudo -u postgres psql -c "CREATE ROLE clubs LOGIN PASSWORD 'clubs' SUPERUSER;" \
  -c "CREATE DATABASE clubs OWNER clubs;" -c "CREATE DATABASE clubs_test OWNER clubs;"
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run scrape -- amex [--force]` | Daily scrape. A second run the same day does nothing unless `--force`. |
| `npm run scrape -- isracard --enable-isracard` | Browser-based scrape. Disabled until the trial passes. |
| `npm run trial:isracard` | One Isracard fetch; appends pass/fail to `trial-log.jsonl`. Seven passes in a row admit it to v1. |
| `npm run best -- "<merchant>" [--clubs amex] [--point-value 0.05]` | Ranked offers for a merchant. Points are shown, and priced only when you give a ₪ value per point. |
| `npm run db:reset` | Drop and recreate the local database (refuses non-local hosts). |

## How it works

1. **Fetch** (`src/net/fetcher.ts`): robots.txt first; a User-Agent naming the tool and a contact address; 3 s between requests; a 30 s timeout; at most 3 retries with backoff and jitter. A 200 that is really a bot wall or an error page counts as a failure, not as an empty page. A circuit breaker per club opens on fault density.
2. **Parse** (`src/sources/epi.ts`): Amex and Isracard share one platform. Every page embeds its model as `window.epi = {...}`, so no HTML scraping is needed. A home-page tile, or a tier variant shown under its parent's name, is a *teaser*: it never overwrites a real listing.
3. **Extract** (`src/extract/rules.ts`): rules read `"<merchant> - <offer>"` names into a closed schema (type, %, ₪ off, price, regular price, voucher value, minimum spend, points, flags). What the rules can't read is marked `needs_review`, never guessed. An LLM extractor can implement the same `Extractor` interface later.
4. **Merchants** (`src/merchants/normalize.ts`): mechanical folding (quotes, hyphens, generic prefixes like רשת/אתר/שובר), then the human-edited `data/merchant-aliases.csv`, resolved in one hop on both sides. There is no fuzzy matching, so מודיעין never swallows מודיעין עילית.
5. **Store** (`src/jobs/scrape.ts`): a completion marker per club per day with a 30-minute lease; UPSERT keyed on the club's own benefit id; the version moves only when the facts change; failed pages go to `dlq`. An offer is marked gone only after a complete run, with no failed pages and at least 70% of the last complete run's offers.
6. **Rank** (`src/rank/score.ts`): `E = P_valid × P_applicable × haircut × V(B) − cost`, with the High/Medium/Low badge from the plan. A parent listing with readable tier variants gives way to them. Basket and ticket prices are assumptions in `data/category-baselines.json`; edit them to match your spending.

## Rules this code keeps

- Public pages only: no login, no CAPTCHA solving, no disguised User-Agent, no IP rotation.
- Store facts and the source URL only: no descriptions, images or logos. Every result links back with a "last seen" date and says the club's own terms bind.
- Amex IL's terms (§2) allow personal, non-commercial use. A public launch waits for a lawyer's answer (see the plan doc's Legal section).

## Status on 2026-10-13

- Amex live: 265 offers from 12 pages; 215 parsed, 50 for review (points-conversion programs, lounges, GOLD-program banners, names without a merchant). Three forced reruns changed 3, 1 and 0 offers. The first two were placeholder-to-real upgrades, which happen at most once per offer.
- Isracard trial: day 1 failed (bot challenge did not clear in 30 s with the honest User-Agent).
- 100 unit and DB tests, 8 end-to-end page tests. The run-twice, version-bump, gone-marking and overview-filter checks were each broken on purpose once and caught.

Stack: Next.js 15.5.27 and React 19.1.9, past the December 2025 React Server Components advisory (CVE-2025-55182). Data access is plain SQL through postgres-js; Supabase and Vercel deployment are not set up yet.
