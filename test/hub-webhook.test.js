import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleHubWebhook } from '../src/hub-webhook.js';
import { DBManager } from '../src/db-manager.js';
import { RSSParser } from '../src/rss-parser.js';
import { WeixinBot } from '../src/weixin-bot.js';

const event = (command, args = {}, extra = {}) => ({
  type: 'event',
  event: { type: 'command', data: { command, args, sender: { id: 'user' }, ...extra } }
});
const request = (body) => ({ json: async () => body });

describe('handleHubWebhook', () => {
  let env;
  beforeEach(() => {
    env = { DB: {}, HUB_URL: 'https://hub', APP_TOKEN: 'token' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '', json: async () => ({}) }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('handles non-command events and static commands', async () => {
    expect((await handleHubWebhook(request({ type: 'message' }), env)).status).toBe(200);
    await handleHubWebhook(request(event('/start')), env);
    expect(fetch).toHaveBeenCalled();
    await handleHubWebhook(request(event('帮助')), env);
    await handleHubWebhook(request(event('unknown')), env);
    expect(JSON.parse(await (await handleHubWebhook(request(event('/start')), env)).text())).toEqual({ ok: true });
  });
  it('extracts URL arguments and handles add subscription states', async () => {
    vi.spyOn(RSSParser.prototype, 'parseRSS').mockResolvedValue([{ title: 'x' }]);
    vi.spyOn(DBManager.prototype, 'checkSubscriptionExists').mockResolvedValue(false);
    vi.spyOn(DBManager.prototype, 'addSubscription').mockResolvedValue(true);
    await handleHubWebhook(request(event('添加', {}, { text: '添加 https://www.example.com/feed' })), env);
    expect(DBManager.prototype.addSubscription).toHaveBeenCalledWith('user', 'https://www.example.com/feed', 'example.com');
    await handleHubWebhook(request(event('添加', { url: 'bad' })), env);
    vi.spyOn(DBManager.prototype, 'checkSubscriptionExists').mockResolvedValue(true);
    await handleHubWebhook(request(event('添加', 'https://example.com/feed')), env);
    expect(fetch).toHaveBeenCalled();
  });
  it('lists and deletes subscriptions', async () => {
    vi.spyOn(DBManager.prototype, 'getUserSubscriptions').mockResolvedValue([]);
    await handleHubWebhook(request(event('列表')), env);
    vi.spyOn(DBManager.prototype, 'getUserSubscriptions').mockResolvedValue([{ rss_url: 'r', site_name: 'Site', created_at: 'today' }]);
    await handleHubWebhook(request(event('列表')), env);
    await handleHubWebhook(request(event('删除', {})), env);
    await handleHubWebhook(request(event('删除', { feed_id: '9' })), env);
    vi.spyOn(DBManager.prototype, 'deleteSubscription').mockResolvedValue(true);
    await handleHubWebhook(request(event('删除', { feed_id: '1' })), env);
    expect(DBManager.prototype.deleteSubscription).toHaveBeenCalledWith('user', 'r');
  });
  it('checks feeds, failures, stats, and status', async () => {
    vi.spyOn(DBManager.prototype, 'getUserSubscriptions').mockResolvedValue([]);
    await handleHubWebhook(request(event('更新')), env);
    await handleHubWebhook(request(event('/check_rss')), env);
    vi.spyOn(DBManager.prototype, 'getFailedSubscriptions').mockResolvedValue([]);
    await handleHubWebhook(request(event('失败')), env);
    vi.spyOn(DBManager.prototype, 'getStats').mockResolvedValue({ users: 1, subscriptions: 2, items: 3 });
    await handleHubWebhook(request(event('统计')), env);
    vi.spyOn(DBManager.prototype, 'getUserSubscriptions').mockResolvedValue([{ rss_url: 'r', site_name: 'Site' }]);
    vi.spyOn(RSSParser.prototype, 'getAccessStats').mockReturnValue({ successCount: 1, failureCount: 0, rateLimitCount: 0 });
    await handleHubWebhook(request(event('状态')), env);
    expect(fetch).toHaveBeenCalled();
  });
  it('runs feed checking and covers reply fetch failures', async () => {
    vi.spyOn(DBManager.prototype, 'getUserSubscriptions').mockResolvedValue([{ rss_url: 'r', site_name: 'S' }]);
    vi.spyOn(RSSParser.prototype, 'parseRSS').mockResolvedValue([{ guid: 'g', title: 'T' }]);
    vi.spyOn(DBManager.prototype, 'checkItemExists').mockResolvedValue(false);
    vi.spyOn(DBManager.prototype, 'saveRSSItem').mockResolvedValue();
    vi.spyOn(WeixinBot.prototype, 'sendRSSUpdate').mockResolvedValue();
    await handleHubWebhook(request(event('更新')), env);
    fetch.mockRejectedValue(new Error('network'));
    await handleHubWebhook(request(event('/start')), env);
    env.APP_TOKEN = undefined;
    await handleHubWebhook(request(event('/start')), env);
  });
});
