import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeixinBot } from '../src/weixin-bot.js';

const db = {};
describe('WeixinBot', () => {
  let bot;
  beforeEach(() => {
    bot = new WeixinBot(db, {});
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('setTimeout', (fn) => { fn(); return 0; });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('escapes HTML, validates URLs, and extracts site names', async () => {
    expect(bot.escapeHTML('')).toBe('');
    expect(bot.escapeHTML('&<>')).toBe('&amp;&lt;&gt;');
    expect(bot.isValidUrl('https://example.com/a')).toBe(true);
    expect(bot.isValidUrl('not url')).toBe(false);
    await expect(bot.extractSiteName('https://www.example.com/a')).resolves.toBe('example.com');
    await expect(bot.extractSiteName('bad')).resolves.toBe('Unknown Site');
  });
  it('generates AI summaries with fallback and API paths', async () => {
    const text = 'x'.repeat(300);
    expect(await bot.generateAISummary(text)).toHaveLength(200);
    bot.env = { DEEPSEEK_API_KEY: 'key' };
    fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '  摘要  ' } }] }) });
    expect(await bot.generateAISummary('hello')).toBe('摘要');
    fetch.mockResolvedValue({ ok: false, status: 503 });
    await expect(bot.generateAISummary('hello')).rejects.toThrow('503');
  });
  it('translates only English titles when configured', async () => {
    expect(await bot.translateTitle('中文标题')).toBe('中文标题');
    expect(await bot.translateTitle('English')).toBe('English');
    bot.env = { DEEPSEEK_API_KEY: 'key' };
    fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: ' 中文标题 ' } }] }) });
    expect(await bot.translateTitle('English')).toBe('中文标题');
    fetch.mockRejectedValue(new Error('network'));
    expect(await bot.translateTitle('Another')).toBe('Another');
  });
  it('sends through iLink only when configured and swallows API errors', async () => {
    await bot.sendViaILink('u', 'm');
    expect(fetch).not.toHaveBeenCalled();
    bot.env = { HUB_URL: 'https://hub', APP_TOKEN: 'token' };
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }).mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'bad' });
    await expect(bot.sendViaILink('u', 'm')).resolves.toBeUndefined();
    await expect(bot.sendViaILink('u', 'm')).resolves.toBeUndefined();
  });
  it('composes RSS markdown and sends it', async () => {
    vi.spyOn(bot, 'generateAISummary').mockResolvedValue('A summary');
    vi.spyOn(bot, 'translateTitle').mockResolvedValue('标题');
    const send = vi.spyOn(bot, 'sendViaILink').mockResolvedValue();
    await bot.sendRSSItem('u', { title: 'Original', description: 'D', link: 'https://x', publishedAt: '2024-01-01' }, 'Example');
    expect(send).toHaveBeenCalledWith('u', expect.stringContaining('# 标题'));
    expect(send.mock.calls[0][1]).toContain('A summary');
    expect(send.mock.calls[0][1]).toContain('[点击查看全文](https://x)');
    expect(send.mock.calls[0][1]).toContain('📌 Example');
  });
  it('supports smart, both, private, and targets push modes', async () => {
    const item = { title: 'T', guid: 'g' };
    const send = vi.spyOn(bot, 'sendRSSItem').mockResolvedValue();
    bot.dbManager.getUserPushMode = vi.fn().mockResolvedValue('smart');
    bot.dbManager.listBindingsForSubscription = vi.fn().mockResolvedValue([]);
    bot.dbManager.hasPushedToChat = vi.fn().mockResolvedValue(false);
    bot.dbManager.savePushRecord = vi.fn().mockResolvedValue(true);
    await bot.sendRSSUpdate('owner', 'rss', item, 'site');
    expect(send).toHaveBeenCalledWith('owner', item, 'site');
    for (const mode of ['both', 'private', 'targets']) {
      send.mockClear();
      bot.dbManager.getUserPushMode.mockResolvedValue(mode);
      bot.dbManager.listBindingsForSubscription.mockResolvedValue(['chat1', 'chat2']);
      bot.dbManager.hasPushedToChat.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      await bot.sendRSSUpdate('owner', 'rss', item, 'site');
      if (mode === 'private' || mode === 'both') expect(send).toHaveBeenCalledWith('owner', item, 'site');
      if (mode !== 'private') {
        expect(send).toHaveBeenCalledWith('chat1', item, 'site');
        expect(bot.dbManager.savePushRecord).toHaveBeenCalled();
      }
    }
  });
});
