-- Club benefits aggregator: initial schema.
-- Facts only: no descriptions, images or logos are stored (plan, legal rule 5).

CREATE TABLE IF NOT EXISTS clubs (
  id text PRIMARY KEY,
  name text NOT NULL,
  home_url text NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id serial PRIMARY KEY,
  club_id text NOT NULL REFERENCES clubs(id),
  url text NOT NULL,
  label text,
  etag text,
  last_modified text,
  last_ok_at timestamptz,
  UNIQUE (club_id, url)
);

-- Completion marker: one row per club per day. A second run the same day
-- finds status 'done' and does nothing (Distributed Task Reliability R10.3).
CREATE TABLE IF NOT EXISTS scrape_runs (
  id serial PRIMARY KEY,
  club_id text NOT NULL REFERENCES clubs(id),
  period date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  lease_until timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  pages_ok int NOT NULL DEFAULT 0,
  pages_failed int NOT NULL DEFAULT 0,
  offers_seen int NOT NULL DEFAULT 0,
  offers_changed int NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false,
  UNIQUE (club_id, period)
);

CREATE TABLE IF NOT EXISTS raw_snapshots (
  id serial PRIMARY KEY,
  source_id int NOT NULL REFERENCES sources(id),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  sha256 text NOT NULL,
  bytes int NOT NULL,
  UNIQUE (source_id, sha256)
);

CREATE TABLE IF NOT EXISTS merchants (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  display_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
  id serial PRIMARY KEY,
  club_id text NOT NULL REFERENCES clubs(id),
  source_offer_key text NOT NULL,
  parent_key text,
  merchant_id int REFERENCES merchants(id),
  merchant_raw text,
  name text NOT NULL,
  category text,
  type text NOT NULL,
  percent numeric,
  amount_off numeric,
  price numeric,
  regular_price numeric,
  face_value numeric,
  min_spend numeric,
  points_cost int,
  points_required boolean NOT NULL DEFAULT false,
  requires_bonus boolean NOT NULL DEFAULT false,
  up_to boolean NOT NULL DEFAULT false,
  from_price boolean NOT NULL DEFAULT false,
  multi boolean NOT NULL DEFAULT false,
  tier_restricted boolean NOT NULL DEFAULT false,
  no_stacking boolean NOT NULL DEFAULT false,
  out_of_stock boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  review_reason text,
  extractor text NOT NULL,
  source_url text NOT NULL,
  -- Hash of the extracted facts; a change bumps version (R4.5).
  content_hash text NOT NULL,
  version int NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  gone_at timestamptz,
  UNIQUE (club_id, source_offer_key)
);

CREATE INDEX IF NOT EXISTS offers_merchant_idx ON offers (merchant_id) WHERE gone_at IS NULL;

CREATE TABLE IF NOT EXISTS dlq (
  id serial PRIMARY KEY,
  club_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fetch', 'parse', 'extract')),
  url text,
  error text NOT NULL,
  attempts int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

INSERT INTO clubs (id, name, home_url) VALUES
  ('amex', 'American Express IL', 'https://rewards.americanexpress.co.il/'),
  ('isracard', 'Isracard', 'https://benefits.isracard.co.il/')
ON CONFLICT (id) DO NOTHING;
