/**
 * Polite HTTP for scrapers. Rules from the plan's legal section and from
 * Distributed Task Reliability (pp. 5-7): read robots.txt first, identify
 * ourselves, space requests, time out every call, retry at most 3 times with
 * backoff and jitter, and treat a 200 that carries an error or a bot wall as
 * the failure it is.
 */

export class FetchFailure extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  body: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

export interface FetcherOptions {
  contact: string;
  /** Minimum gap between two requests to the same host. */
  spacingMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** Signs that a 200 is not the page we asked for. */
const BLOCK_MARKERS: [RegExp, string][] = [
  [/<title>\s*(?:Just a moment|רק רגע|Attention Required)/i, 'bot challenge page'],
  [/cf-browser-verification|challenge-platform/i, 'bot challenge page'],
  [/<title>\s*httpErrors\s*<\/title>/i, 'site error page'],
  [/The requested URL was rejected/i, 'WAF rejection page'],
];

export function blockReason(body: string): string | null {
  for (const [re, why] of BLOCK_MARKERS) if (re.test(body)) return why;
  return null;
}

/** robots.txt rules for user-agent * only; we send no other product token match. */
export function parseRobots(text: string): { disallow: string[]; allow: string[] } {
  const disallow: string[] = [];
  const allow: string[] = [];
  let applies = false;
  let sawRule = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const key = field!.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (sawRule) {
        applies = false;
        sawRule = false;
      }
      if (value === '*') applies = true;
    } else if (key === 'disallow' || key === 'allow') {
      sawRule = true;
      if (!applies || !value) continue;
      (key === 'disallow' ? disallow : allow).push(value);
    }
  }
  return { disallow, allow };
}

export function robotsAllows(rules: { disallow: string[]; allow: string[] }, path: string): boolean {
  const longest = (list: string[]) => list.filter((p) => path.startsWith(p)).reduce((m, p) => Math.max(m, p.length), -1);
  const d = longest(rules.disallow);
  if (d < 0) return true;
  return longest(rules.allow) >= d;
}

export class Fetcher {
  private readonly lastHit = new Map<string, number>();
  private readonly robots = new Map<string, { disallow: string[]; allow: string[] }>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  readonly userAgent: string;

  constructor(private readonly opts: FetcherOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
    this.userAgent = `club-benefits/0.1 (personal research; contact: ${opts.contact})`;
  }

  private async space(host: string): Promise<void> {
    const gap = this.opts.spacingMs ?? 3000;
    const last = this.lastHit.get(host);
    if (last != null) {
      const wait = last + gap - Date.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastHit.set(host, Date.now());
  }

  /** Fetch and cache robots.txt. A missing file, or an HTML page served in its place, allows everything. */
  async robotsFor(origin: string) {
    const cached = this.robots.get(origin);
    if (cached) return cached;
    let rules = { disallow: [] as string[], allow: [] as string[] };
    try {
      const res = await this.raw(`${origin}/robots.txt`, {});
      const looksLikeRobots = res.status === 200 && !/^\s*</.test(res.body);
      if (looksLikeRobots) rules = parseRobots(res.body);
      this.log(`robots ${origin}: ${looksLikeRobots ? `${rules.disallow.length} disallow rule(s)` : 'none served'}`);
    } catch (e) {
      this.log(`robots ${origin}: unreachable (${(e as Error).message}), treating as none`);
    }
    this.robots.set(origin, rules);
    return rules;
  }

  private async raw(url: string, headers: Record<string, string>): Promise<FetchedPage> {
    const host = new URL(url).host;
    await this.space(host);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'he-IL,he;q=0.9', ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new FetchFailure(`network: ${(e as Error).message}`, url, true);
    }
    const body = res.status === 304 ? '' : await res.text();
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      notModified: res.status === 304,
    };
  }

  /** GET a page politely. Throws FetchFailure on anything that isn't the real page. */
  async get(url: string, cache: { etag?: string | null; lastModified?: string | null } = {}): Promise<FetchedPage> {
    const u = new URL(url);
    const rules = await this.robotsFor(u.origin);
    if (!robotsAllows(rules, u.pathname)) throw new FetchFailure('disallowed by robots.txt', url, false);

    const headers: Record<string, string> = {};
    if (cache.etag) headers['If-None-Match'] = cache.etag;
    if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;

    const maxRetries = this.opts.maxRetries ?? 3;
    let lastError: FetchFailure | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = 2000 * 2 ** (attempt - 1);
        await this.sleep(backoff / 2 + Math.random() * backoff);
      }
      try {
        const page = await this.raw(url, headers);
        if (page.notModified) return page;
        if (page.status === 429 || page.status >= 500) {
          throw new FetchFailure(`HTTP ${page.status}`, url, true, page.status);
        }
        if (page.status !== 200) throw new FetchFailure(`HTTP ${page.status}`, url, false, page.status);
        const blocked = blockReason(page.body);
        // A bot wall or error page is not retried in a tight loop: we come back tomorrow.
        if (blocked) throw new FetchFailure(`${blocked} (HTTP 200)`, url, false, page.status);
        return page;
      } catch (e) {
        lastError = e instanceof FetchFailure ? e : new FetchFailure(String(e), url, true);
        if (!lastError.retryable) throw lastError;
        if (attempt < maxRetries) this.log(`retry ${attempt + 1}/${maxRetries} ${url}: ${lastError.message}`);
      }
    }
    throw lastError!;
  }
}

/**
 * Circuit breaker per source (Distributed Task Reliability R7.2-7.4): trips
 * on fault density over a rolling window, not on a raw count, and logs every
 * state change with its cause.
 */
export class CircuitBreaker {
  private readonly window: boolean[] = [];
  state: 'closed' | 'open' = 'closed';

  constructor(
    readonly name: string,
    private readonly log: (msg: string) => void = () => {},
    private readonly size = 6,
    private readonly minSamples = 3,
    private readonly threshold = 0.5,
  ) {}

  record(ok: boolean, cause = ''): void {
    this.window.push(ok);
    if (this.window.length > this.size) this.window.shift();
    const failures = this.window.filter((x) => !x).length;
    if (this.state === 'closed' && this.window.length >= this.minSamples && failures / this.window.length >= this.threshold) {
      this.state = 'open';
      this.log(`breaker ${this.name}: closed -> open (${failures}/${this.window.length} failed; last: ${cause})`);
    }
  }

  get allows(): boolean {
    return this.state === 'closed';
  }
}
