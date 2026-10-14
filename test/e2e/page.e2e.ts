import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, reset } from '../../src/db/client.js';
import { rulesExtractor } from '../../src/extract/rules.js';
import { runScrape } from '../../src/jobs/scrape.js';
import { AliasTable } from '../../src/merchants/normalize.js';
import { epiAdapter } from '../../src/sources/amex.js';

/**
 * The built page against a database seeded from the test fixture. Run with
 * `npm run test:e2e` (builds first). Every check names the literal text that
 * would be missing if the feature broke (Agentic QA R9.1).
 */

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://clubs:clubs@localhost:5432/clubs_test';
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const HOME = 'https://rewards.americanexpress.co.il/';
const ROOT = join(import.meta.dirname, '..', '..');

let server: ChildProcess;
let browser: Browser;

async function portAnswers(): Promise<boolean> {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('next start did not come up');
}

async function open(path: string, width = 1280): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'he-IL' });
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  return page;
}

beforeAll(async () => {
  const sql = connect(DB);
  await reset(sql, DB);
  const fixture = readFileSync(join(ROOT, 'test', 'fixtures', 'amex-home.html'), 'utf8');
  const empty = '<script>window.epi = {"CurrentPage":{"Benefits":[]}};</script>';
  await runScrape({
    sql,
    adapter: epiAdapter('amex', HOME),
    extractor: rulesExtractor,
    aliases: new AliasTable([]),
    fetchBody: async (url) => (url === HOME ? fixture : empty),
  });
  await sql.end();

  // A server left over from an earlier run would serve an old build and make
  // every check here meaningless; refuse to run against it.
  if (await portAnswers()) throw new Error(`port ${PORT} is already in use; stop the old server first`);
  // Start next directly (not through npx) in its own process group, so
  // killing the group also stops the next-server child.
  server = spawn(process.execPath, [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'ignore',
    detached: true,
  });
  await waitForServer();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
});

afterAll(async () => {
  await browser?.close();
  if (server?.pid) process.kill(-server.pid, 'SIGTERM');
});

describe('home page', () => {
  it('is Hebrew, right to left', async () => {
    const page = await open('/');
    expect(await page.getAttribute('html', 'dir')).toBe('rtl');
    expect(await page.getAttribute('html', 'lang')).toBe('he');
    expect(await page.textContent('h1')).toBe('איפה הכי משתלם?');
  });

  it('lists stated savings only, best first, one card per merchant', async () => {
    const page = await open('/');
    const merchants = await page.locator('#deals-title ~ ol .merchant').allTextContents();
    // BUYME ALL voucher: ₪200 for ₪140 -> 60 × 0.85 = 51. Amphi: ₪50 off -> 42.5.
    expect(merchants.slice(0, 2)).toEqual(['BUYME ALL', 'אמפי תל אביב']);
    expect(await page.locator('#deals-title ~ ol .card').first().locator('.value').textContent()).toBe('כ-51 ₪');
    // Sixt's 16% depends on an assumed basket, so it stays out of the overview.
    expect(merchants).not.toContain('שלמה Sixt');
    expect(new Set(merchants).size).toBe(merchants.length);
  });

  it('shows when the club was last checked, and the disclaimer', async () => {
    const footer = await (await open('/')).textContent('footer');
    expect(footer).toContain('אמריקן אקספרס: נבדק');
    expect(footer).toContain('התנאים המחייבים הם של המועדון');
  });
});

describe('merchant search', () => {
  it('ranks the tier variants, fewer points first, and links back to the club', async () => {
    const page = await open(`/?q=${encodeURIComponent('ספארי רמת גן')}`);
    expect(await page.textContent('#results-title')).toBe('2 הטבות עבור "ספארי רמת גן"');
    const cards = page.locator('#results-title ~ ol .card');
    expect(await cards.first().textContent()).toContain('150 נקודות');
    expect(await cards.nth(1).textContent()).toContain('440 נקודות');
    expect(await cards.first().locator('a', { hasText: 'לפרטים באתר המועדון' }).getAttribute('href')).toMatch(/^https:\/\/rewards\.americanexpress\.co\.il\/link\//);
  });

  it('explains an estimate that rests on an assumption', async () => {
    const page = await open(`/?q=${encodeURIComponent('רשת ה.שטרן')}`);
    expect(await page.locator('.assumption').first().textContent()).toContain('ומינימום הקנייה 3,000 ₪');
  });

  it('says so when nothing matches', async () => {
    const page = await open(`/?q=${encodeURIComponent('אין כזה עסק')}`);
    expect(await page.textContent('#results-title')).toBe('לא נמצאו הטבות פעילות עבור "אין כזה עסק"');
  });

  it('ignores clubs that are not enabled', async () => {
    const page = await open(`/?q=${encodeURIComponent('ספארי רמת גן')}&club=isracard&club=nonsense`);
    expect(await page.textContent('#results-title')).toBe('2 הטבות עבור "ספארי רמת גן"');
  });
});

describe('phone width', () => {
  it('has no horizontal scroll at 390 px', async () => {
    for (const path of ['/', `/?q=${encodeURIComponent('ספארי רמת גן')}`]) {
      const page = await open(path, 390);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBe(0);
    }
  });
});
