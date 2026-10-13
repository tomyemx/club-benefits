import { chromium, type Browser } from 'playwright-core';
import { blockReason } from '../net/fetcher.js';
import { epiAdapter } from './amex.js';

/**
 * Isracard runs the Amex platform behind a Cloudflare managed challenge.
 * A plain headless browser passed it about half the time in testing, on its
 * own; nothing here solves or evades a challenge. When the page still shows
 * the challenge after the wait, the fetch fails and we try again tomorrow.
 * Disabled until the 7-day trial (npm run trial:isracard) shows it holds.
 */

export const ISRACARD_HOME = 'https://benefits.isracard.co.il/';
export const isracard = epiAdapter('isracard', ISRACARD_HOME);

const CHROMIUM = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export interface BrowserPage {
  ok: boolean;
  status: number | null;
  body: string;
  reason: string | null;
  waitedMs: number;
}

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM, args: ['--no-sandbox'] });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** Load a page and wait up to maxWaitMs for a challenge to clear by itself. */
export async function browserGet(browser: Browser, url: string, contact: string, maxWaitMs = 30_000): Promise<BrowserPage> {
  const ctx = await browser.newContext({
    locale: 'he-IL',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) club-benefits/0.1 (personal research; contact: ${contact})`,
  });
  const page = await ctx.newPage();
  const started = Date.now();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    let body = await page.content();
    while (blockReason(body) && Date.now() - started < maxWaitMs) {
      await page.waitForTimeout(5000);
      body = await page.content();
    }
    const reason = blockReason(body);
    return { ok: !reason, status: res?.status() ?? null, body, reason, waitedMs: Date.now() - started };
  } finally {
    await ctx.close();
  }
}
