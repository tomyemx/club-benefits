import { describe, expect, it } from 'vitest';
import { blockReason, CircuitBreaker, Fetcher, FetchFailure, parseRobots, robotsAllows } from '../src/net/fetcher.js';

type Reply = { status: number; body: string; headers?: Record<string, string> };

/** A fake fetch that serves scripted replies per URL and records what was asked. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const queue = routes[url];
    if (!queue || queue.length === 0) return new Response('not found', { status: 404 });
    const r = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response(r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const noSleep = async () => {};

describe('robots.txt', () => {
  const rules = parseRobots(['User-agent: Googlebot', 'Disallow: /', '', 'User-agent: *', 'Disallow: /wp-admin/', 'Allow: /wp-admin/admin-ajax.php'].join('\n'));

  it('applies only the * group', () => {
    expect(rules.disallow).toEqual(['/wp-admin/']);
    expect(robotsAllows(rules, '/coupons/ksp/')).toBe(true);
    expect(robotsAllows(rules, '/wp-admin/x')).toBe(false);
  });

  it('lets the longest matching Allow win', () => {
    expect(robotsAllows(rules, '/wp-admin/admin-ajax.php')).toBe(true);
  });
});

describe('blockReason', () => {
  it.each([
    ['<title>Just a moment...</title>', 'bot challenge page'],
    ['<title>רק רגע...</title>', 'bot challenge page'],
    ['<title>Attention Required! | Cloudflare</title>', 'bot challenge page'],
    ['<title>httpErrors</title>', 'site error page'],
    ['The requested URL was rejected. Please consult', 'WAF rejection page'],
  ])('%s', (body, why) => {
    expect(blockReason(body)).toBe(why);
  });

  it('passes a real page', () => {
    expect(blockReason('<title>הטבות</title><script>window.epi = {}</script>')).toBeNull();
  });
});

describe('Fetcher', () => {
  const origin = 'https://club.test';

  it('identifies itself with a contact address', async () => {
    const { impl, calls } = fakeFetch({ [`${origin}/robots.txt`]: [{ status: 404, body: '' }], [`${origin}/a`]: [{ status: 200, body: 'ok' }] });
    const f = new Fetcher({ contact: 'me@example.com', fetchImpl: impl, sleep: noSleep });
    await f.get(`${origin}/a`);
    expect(calls.at(-1)!.headers['User-Agent']).toContain('contact: me@example.com');
  });

  it('retries a 503 and then succeeds', async () => {
    const { impl, calls } = fakeFetch({
      [`${origin}/robots.txt`]: [{ status: 404, body: '' }],
      [`${origin}/a`]: [{ status: 503, body: '' }, { status: 503, body: '' }, { status: 200, body: 'ok' }],
    });
    const page = await new Fetcher({ contact: 'c', fetchImpl: impl, sleep: noSleep }).get(`${origin}/a`);
    expect(page.body).toBe('ok');
    expect(calls.filter((c) => c.url.endsWith('/a'))).toHaveLength(3);
  });

  it('gives up after 3 retries', async () => {
    const { impl, calls } = fakeFetch({ [`${origin}/robots.txt`]: [{ status: 404, body: '' }], [`${origin}/a`]: [{ status: 500, body: '' }] });
    await expect(new Fetcher({ contact: 'c', fetchImpl: impl, sleep: noSleep }).get(`${origin}/a`)).rejects.toThrow('HTTP 500');
    expect(calls.filter((c) => c.url.endsWith('/a'))).toHaveLength(4);
  });

  it('treats a 200 challenge page as a failure and does not hammer it', async () => {
    const { impl, calls } = fakeFetch({
      [`${origin}/robots.txt`]: [{ status: 404, body: '' }],
      [`${origin}/a`]: [{ status: 200, body: '<title>Just a moment...</title>' }],
    });
    const err = await new Fetcher({ contact: 'c', fetchImpl: impl, sleep: noSleep }).get(`${origin}/a`).catch((e) => e);
    expect(err).toBeInstanceOf(FetchFailure);
    expect((err as FetchFailure).retryable).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('/a'))).toHaveLength(1);
  });

  it('obeys robots.txt and never requests a disallowed page', async () => {
    const { impl, calls } = fakeFetch({ [`${origin}/robots.txt`]: [{ status: 200, body: 'User-agent: *\nDisallow: /private' }] });
    await expect(new Fetcher({ contact: 'c', fetchImpl: impl, sleep: noSleep }).get(`${origin}/private/x`)).rejects.toThrow('robots');
    expect(calls.map((c) => c.url)).toEqual([`${origin}/robots.txt`]);
  });

  it('reads an HTML page served as robots.txt as "no robots file"', async () => {
    const { impl } = fakeFetch({
      [`${origin}/robots.txt`]: [{ status: 200, body: '<!DOCTYPE html><title>httpErrors</title>' }],
      [`${origin}/private/x`]: [{ status: 200, body: 'ok' }],
    });
    expect((await new Fetcher({ contact: 'c', fetchImpl: impl, sleep: noSleep }).get(`${origin}/private/x`)).body).toBe('ok');
  });

  it('waits between requests to the same host', async () => {
    const waits: number[] = [];
    const { impl } = fakeFetch({ [`${origin}/robots.txt`]: [{ status: 404, body: '' }], [`${origin}/a`]: [{ status: 200, body: 'ok' }] });
    const f = new Fetcher({ contact: 'c', fetchImpl: impl, spacingMs: 3000, sleep: async (ms) => void waits.push(ms) });
    await f.get(`${origin}/a`);
    await f.get(`${origin}/a`);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...waits)).toBeGreaterThan(2500);
  });
});

describe('CircuitBreaker', () => {
  it('opens on fault density, not on a single failure, and logs why', () => {
    const logs: string[] = [];
    const b = new CircuitBreaker('amex', (m) => logs.push(m));
    b.record(true);
    b.record(false, 'timeout');
    expect(b.allows).toBe(true);
    b.record(false, 'HTTP 500');
    expect(b.allows).toBe(false);
    expect(logs).toEqual(['breaker amex: closed -> open (2/3 failed; last: HTTP 500)']);
  });
});
