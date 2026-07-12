import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/worker.js';
import { DBManager } from '../src/db-manager.js';
import { RSSParser } from '../src/rss-parser.js';
import { WeixinBot } from '../src/weixin-bot.js';

const db = { prepare: vi.fn(() => ({ run: vi.fn(async () => ({ changes: 1 })) })) };
const responseText = (res) => res.text();

describe('worker', () => {
  let env;
  beforeEach(() => {
    env = { DB: db };
    vi.stubGlobal('setTimeout', (fn) => { fn(); return 0; });
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('routes fetch requests and catches schema errors', async () => {
    vi.spyOn(DBManager.prototype, 'ensureSchema').mockResolvedValue();
    vi.spyOn(worker, 'checkRSSFeeds').mockResolvedValue();
    expect(await responseText(await worker.fetch(new Request('https://x/'), env, {}))).toBe('RSS Bot运行中');
    expect((await worker.fetch(new Request('https://x/check-rss'), env, {})).status).toBe(200);
    const webhook = await worker.fetch(new Request('https://x/hub/webhook', { method: 'POST', body: JSON.stringify({ type: 'message' }) }), env, {});
    expect(webhook.status).toBe(200);
    DBManager.prototype.ensureSchema.mockRejectedValue(new Error('schema'));
    expect(await worker.fetch(new Request('https://x/'), env, {})).toBeInstanceOf(Response);
  });
  it('schedules RSS checks', async () => {
    vi.spyOn(worker, 'checkRSSFeeds').mockResolvedValue();
    const waitUntil = vi.fn();
    await worker.scheduled({}, env, { waitUntil });
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
  it('returns early without subscriptions', async () => {
    vi.spyOn(DBManager.prototype, 'getAllSubscriptions').mockResolvedValue([]);
    await worker.checkRSSFeeds(env);
  });
  it('groups subscriptions, sends new items, skips existing/rate-limited, and records errors', async () => {
    vi.spyOn(DBManager.prototype, 'getAllSubscriptions').mockResolvedValue([
      { rss_url: 'good', user_id: 'u', site_name: 'Good' },
      { rss_url: 'good', user_id: 'u2', site_name: 'Good' },
      { rss_url: 'limited', user_id: 'u', site_name: 'Limited' },
      { rss_url: 'bad', user_id: 'u', site_name: 'Bad' }
    ]);
    vi.spyOn(RSSParser.prototype, 'getAccessStats').mockImplementation((url) => url === 'limited' ? { rateLimitCount: 1 } : { rateLimitCount: 0 });
    vi.spyOn(RSSParser.prototype, 'parseRSS').mockImplementation(async (url) => {
      if (url === 'bad') throw new Error('parse failed');
      return [{ guid: 'new', title: 'New' }, { guid: 'old', title: 'Old' }];
    });
    vi.spyOn(DBManager.prototype, 'checkItemExists').mockImplementation(async (url, guid) => guid === 'old');
    vi.spyOn(DBManager.prototype, 'clearFailureRecord').mockResolvedValue();
    vi.spyOn(DBManager.prototype, 'saveRSSItem').mockResolvedValue();
    vi.spyOn(DBManager.prototype, 'recordFailure').mockResolvedValue();
    vi.spyOn(DBManager.prototype, 'cleanupOldItems').mockResolvedValue(0);
    vi.spyOn(WeixinBot.prototype, 'sendRSSUpdate').mockResolvedValue();
    await worker.checkRSSFeeds(env);
    expect(WeixinBot.prototype.sendRSSUpdate).toHaveBeenCalledWith('u', 'good', expect.objectContaining({ guid: 'new' }), 'Good');
    expect(DBManager.prototype.saveRSSItem).toHaveBeenCalledWith('good', expect.objectContaining({ guid: 'new' }));
    expect(DBManager.prototype.recordFailure).toHaveBeenCalledWith('bad', 'parse failed');
  });
});
