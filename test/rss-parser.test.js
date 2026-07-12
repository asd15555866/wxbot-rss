import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RSSParser } from '../src/rss-parser.js';

const rss = (items = '') => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
const item = (title, guid = 'g1') => `<item><title>${title}</title><link>https://example.com/${guid}</link><description><![CDATA[<p>description &amp; more</p>]]></description><guid>${guid}</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`;

describe('RSSParser', () => {
  let parser;
  beforeEach(() => {
    parser = new RSSParser({});
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('setTimeout', (fn) => { fn(); return 0; });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('cleans HTML and decodes entities', () => {
    expect(parser.stripHTML('<p>Hello <b>world</b></p>')).toBe('Hello world');
    expect(parser.decodeHTML('&amp; &lt; &gt; &quot; &#39; &nbsp; &unknown;')).toBe('& < > " \'   &unknown;');
    expect(parser.fixHTMLEntities('a & b < broken <tag> &amp;')).toBe('a &amp; b &lt; broken <tag> &amp;');
  });

  it('preprocesses XML and recognizes valid empty feeds', () => {
    expect(parser.preprocessXML('\ufeff\u0000<rss><channel/></rss>')).toContain('<?xml version="1.0"');
    expect(parser.preprocessXML('<?xml version="1.0"?><feed/>')).toBe('<?xml version="1.0"?><feed/>');
    expect(parser.isValidEmptyRSS('<rss><channel/></rss>')).toBe(true);
    expect(parser.isValidEmptyRSS('<?xml?><atom/>')).toBe(true);
    expect(parser.isValidEmptyRSS('<html/>')).toBe(false);
  });

  it('parses RSS items with CDATA, fallback ids, and truncates descriptions', () => {
    const long = 'x'.repeat(250);
    const parsed = parser.parseRSSItem(`<item><title><![CDATA[Hello &amp; world]]></title><link> https://x.test/a </link><description><![CDATA[<p>${long}</p>]]></description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`);
    expect(parsed.title).toBe('Hello & world');
    expect(parsed.link).toBe('https://x.test/a');
    expect(parsed.description).toHaveLength(200);
    expect(parsed.guid).toBe(parsed.link);
    expect(parsed.publishedAt).toContain('2024');
    expect(parser.parseRSSItem('<item><title>Only title</title></item>').guid).toBe('Only title');
  });

  it('parses Atom title/content/link/date variants', () => {
    const parsed = parser.parseAtomEntry(`<entry><title type="html"><![CDATA[Atom &amp; title]]></title><link href="https://x.test/e" /><content type="html"><![CDATA[<b>Body</b>]]></content><id>atom-id</id><published>2024-01-02T00:00:00Z</published></entry>`);
    expect(parsed).toMatchObject({ title: 'Atom & title', link: 'https://x.test/e', description: 'Body', guid: 'atom-id' });
    expect(parsed.publishedAt).toContain('2024');
    expect(parser.parseAtomEntry('<entry><title>Summary</title><link href="x"/><summary>sum</summary><updated>2024-01-03</updated></entry>').description).toBe('sum');
    expect(parser.parseAtomEntry('<entry><title>T</title><link href="x"/></entry>').guid).toBe('x');
  });

  it('parses RSS and Atom XML, limiting and filtering entries', () => {
    const xml = rss(item('one', '1') + item('two', '2') + '<item><description>x</description><guid>bad</guid></item>');
    expect(parser.parseXML(parser.preprocessXML(xml))).toHaveLength(2);
    const many = Array.from({ length: 12 }, (_, i) => item(`t${i}`, `${i}`)).join('');
    expect(parser.parseXML(many)).toHaveLength(10);
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link href="u"/><id>i</id></entry></feed>';
    expect(parser.parseXML(atom)[0].title).toBe('A');
  });

  it('parses JSON, Discourse, and forum feeds', () => {
    const json = JSON.stringify({ items: [{ id: '1', title: 'J', url: 'https://j', content_html: '<b>text</b>', date_published: '2024-01-01' }] });
    expect(parser.parseJSONFeed(json)[0]).toMatchObject({ title: 'J', link: 'https://j', description: 'text', guid: '1' });
    expect(parser.parseJSONFeed('{bad')).toEqual([]);
    expect(parser.parseDiscourseRSS('<entry><title>D</title><link>u</link><id>d</id></entry>')[0].title).toBe('D');
    expect(parser.parseForumRSS('<item><title>F</title><link>u</link><guid>f</guid></item>')[0].title).toBe('F');
  });

  it('tracks rate limits, failures, and successes', () => {
    expect(parser.isRateLimited('u')).toBe(false);
    parser.recordFailure('u');
    expect(parser.getAccessStats('u')).toMatchObject({ failureCount: 1, successCount: 0 });
    expect(parser.isRateLimited('u')).toBe(true);
    parser.recordRateLimit('u');
    expect(parser.getAccessStats('u').rateLimitCount).toBe(1);
    parser.recordSuccess('u');
    expect(parser.getAccessStats('u')).toMatchObject({ failureCount: 0, rateLimitCount: 0, successCount: 1 });
  });

  it('fetches full content and strips unsafe markup', async () => {
    fetch.mockResolvedValue({ text: async () => '<style>x</style><script>x</script><p>Hello</p> world' });
    expect(await parser.fetchFullContent('https://x')).toBe('Hello world');
    fetch.mockRejectedValue(new Error('network'));
    expect(await parser.fetchFullContent('https://x')).toBe('');
  });

  it('parses RSS and enriches first three items', async () => {
    fetch.mockResolvedValueOnce({ ok: true, text: async () => rss(item('A', 'a') + item('B', 'b')) })
      .mockResolvedValue({ text: async () => '<p>full text</p>' });
    const items = await parser.parseRSS('https://feed');
    expect(items).toHaveLength(2);
    expect(items[0].fullContent).toBe('full text');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries HTTP errors, records failure, and rejects verification pages', async () => {
    fetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Oops' });
    expect(await parser.parseRSS('https://bad')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(parser.getAccessStats('https://bad').failureCount).toBe(1);
    fetch.mockReset().mockResolvedValue({ ok: true, text: async () => 'Just a moment' });
    expect(await parser.parseRSS('https://cf')).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('handles special formats and empty valid RSS', async () => {
    const json = JSON.stringify({ items: [{ title: 'J', id: 'j', url: 'https://j' }] });
    fetch.mockResolvedValue({ ok: true, text: async () => json });
    expect((await parser.parseRSS('https://json')).length).toBe(1);
    fetch.mockReset().mockResolvedValue({ ok: true, text: async () => '<rss><channel/></rss>' });
    expect(await parser.parseRSS('https://empty')).toEqual([]);
  });
});
