import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { benefitsFromPage } from '../src/sources/epi.js';
import { browserGet, ISRACARD_HOME, withBrowser } from '../src/sources/isracard.js';

/**
 * One slow, browser-based fetch of the Isracard home page per day, logged
 * to trial-log.jsonl. Isracard joins v1 only after 7 passes in a row.
 */
const contact = process.env.SCRAPER_CONTACT ?? 'e9713710@gmail.com';
const logFile = join(import.meta.dirname, '..', 'trial-log.jsonl');

const entry = await withBrowser(async (browser) => {
  const page = await browserGet(browser, ISRACARD_HOME, contact);
  let benefits = 0;
  let parseError: string | null = null;
  if (page.ok) {
    try {
      benefits = benefitsFromPage(page.body, 'isracard', ISRACARD_HOME).length;
    } catch (e) {
      parseError = (e as Error).message;
    }
  }
  return {
    at: new Date().toISOString(),
    pass: page.ok && benefits > 0,
    status: page.status,
    waitedSeconds: Math.round(page.waitedMs / 1000),
    reason: page.reason ?? parseError,
    benefits,
  };
});

appendFileSync(logFile, JSON.stringify(entry) + '\n');
console.log(JSON.stringify(entry));
process.exitCode = entry.pass ? 0 : 1;
