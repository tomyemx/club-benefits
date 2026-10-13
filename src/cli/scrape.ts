import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { connect, migrate } from '../db/client.js';
import { rulesExtractor } from '../extract/rules.js';
import { runScrape } from '../jobs/scrape.js';
import { AliasTable } from '../merchants/normalize.js';
import { Fetcher } from '../net/fetcher.js';
import { amex } from '../sources/amex.js';
import { browserGet, isracard, withBrowser } from '../sources/isracard.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: 'boolean', default: false },
    'enable-isracard': { type: 'boolean', default: false },
  },
});

const club = positionals[0];
const contact = process.env.SCRAPER_CONTACT ?? 'e9713710@gmail.com';
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const aliases = AliasTable.fromFile(join(import.meta.dirname, '..', '..', 'data', 'merchant-aliases.csv'));
const sql = connect();

try {
  await migrate(sql);
  if (club === 'amex') {
    const fetcher = new Fetcher({ contact, log });
    const r = await runScrape({ sql, adapter: amex, extractor: rulesExtractor, aliases, fetcher, force: values.force, log });
    process.exitCode = r.skipped || r.complete ? 0 : 1;
  } else if (club === 'isracard') {
    if (!values['enable-isracard']) {
      console.error('isracard is disabled until the 7-day trial passes (npm run trial:isracard); pass --enable-isracard to run anyway');
      process.exitCode = 2;
    } else {
      await withBrowser(async (browser) => {
        const fetchBody = async (url: string) => {
          const page = await browserGet(browser, url, contact);
          if (!page.ok) throw new Error(`${page.reason} after ${Math.round(page.waitedMs / 1000)} s`);
          await new Promise((r) => setTimeout(r, 5000));
          return page.body;
        };
        const r = await runScrape({ sql, adapter: isracard, extractor: rulesExtractor, aliases, fetchBody, force: values.force, log });
        process.exitCode = r.skipped || r.complete ? 0 : 1;
      });
    }
  } else {
    console.error('usage: npm run scrape -- amex|isracard [--force]');
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
