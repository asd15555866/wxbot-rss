import { sleep } from './utils.js';

export class RSSParser {
  constructor(env) {
    this.rateLimitMap = new Map();
    this.env = env;
  }

  async fetchFullContent(url) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        }
      });
      const html = await response.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.substring(0, 2000);
    } catch (error) {
      console.error('抓取文章正文失败:', error);
      return '';
    }
  }

  async parseRSS(url) {
    if (this.isRateLimited(url)) {
      console.log(`跳过 ${url} - 频率限制中`);
      return [];
    }

    const maxRetries = 2;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 尝试 ${attempt}/${maxRetries}: ${url}`);

        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="121", "Google Chrome";v="121"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Cache-Control': 'max-age=0'
        };

        const response = await fetch(url, {
          method: 'GET',
          headers: headers,
          redirect: 'follow'
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const xmlText = await response.text();
        console.log(`📄 获取到 ${xmlText.length} 字符`);

        const trimmed = xmlText.trim();
        const isLikelyRSS = trimmed.startsWith('<rss') || trimmed.startsWith('<feed') || trimmed.startsWith('<?xml');

        if (!isLikelyRSS) {
          if (xmlText.includes('Just a moment') ||
              xmlText.includes('DDoS protection by Cloudflare') ||
              xmlText.includes('<title>403 Forbidden</title>') ||
              xmlText.includes('<title>Access Denied</title>') ||
              xmlText.includes('cf-browser-verification') ||
              xmlText.includes('__cf_chl')) {
            throw new Error('返回验证页面，非有效RSS');
          }
          console.log(`⚠️ 内容非标准RSS，但未检测到验证页，继续解析`);
        }

        const cleanedXML = this.preprocessXML(xmlText);
        const items = this.parseXML(cleanedXML);

        if (items.length === 0) {
          const specialItems = await this.trySpecialFormats(url, cleanedXML);
          if (specialItems.length > 0) {
            await this.hydrateFullContent(specialItems);
            this.recordSuccess(url);
            console.log(`✅ 特殊解析成功，${specialItems.length} 条`);
            return specialItems;
          }
          if (this.isValidEmptyRSS(cleanedXML)) {
            console.log(`⚠️ 空但有效RSS: ${url}`);
            return [];
          }
          throw new Error('未找到任何条目');
        }

        await this.hydrateFullContent(items);

        this.recordSuccess(url);
        console.log(`✅ 成功解析 ${url}，${items.length} 条`);
        return items;

      } catch (error) {
        lastError = error.message;
        console.warn(`❌ 尝试 ${attempt} 失败: ${error.message}`);
        if (attempt < maxRetries) {
          const delay = Math.min(Math.pow(2, attempt) * 1000, 10000);
          console.log(`⏳ ${delay}ms 后重试...`);
          await sleep(delay);
        }
      }
    }

    this.recordFailure(url);
    console.error(`❌ 所有尝试失败 ${url}: ${lastError || 'Unknown'}`);
    return [];
  }

  // 为前 N 条条目拉取正文，无正文时回退到描述/空串
  async hydrateFullContent(items, limit = 3) {
    for (let i = 0; i < Math.min(items.length, limit); i++) {
      const item = items[i];
      item.fullContent = item.link ? (await this.fetchFullContent(item.link) || item.description || '') : (item.description || '');
    }
  }

  // ===== 以下为辅助方法（原样保留） =====
  isRateLimited(url) {
    const record = this.rateLimitMap.get(url);
    if (!record) return false;
    const now = Date.now();
    const cooldown = record.rateLimitCount > 0 ? Math.min(300000 * Math.pow(2, record.rateLimitCount), 3600000) :
                     (record.failureCount > 0 ? Math.min(120000 * record.failureCount, 1800000) : 60000);
    return (now - record.lastAccess) < cooldown;
  }

  recordSuccess(url) {
    this.rateLimitMap.set(url, {
      lastAccess: Date.now(),
      failureCount: 0,
      rateLimitCount: 0,
      successCount: (this.rateLimitMap.get(url)?.successCount || 0) + 1
    });
  }

  recordFailure(url) {
    const record = this.rateLimitMap.get(url) || { lastAccess: 0, failureCount: 0, rateLimitCount: 0, successCount: 0 };
    record.lastAccess = Date.now();
    record.failureCount++;
    this.rateLimitMap.set(url, record);
  }

  recordRateLimit(url) {
    const record = this.rateLimitMap.get(url) || { lastAccess: 0, failureCount: 0, rateLimitCount: 0, successCount: 0 };
    record.lastAccess = Date.now();
    record.rateLimitCount++;
    this.rateLimitMap.set(url, record);
  }

  getAccessStats(url) {
    return this.rateLimitMap.get(url) || { lastAccess: 0, failureCount: 0, rateLimitCount: 0, successCount: 0 };
  }

  preprocessXML(xmlText) {
    let cleaned = xmlText.trim();
    if (cleaned.charCodeAt(0) === 0xFEFF) cleaned = cleaned.substring(1);
    cleaned = cleaned.replace(/\x00/g, '');
    if (!cleaned.startsWith('<?xml') && (cleaned.includes('<rss') || cleaned.includes('<feed'))) {
      cleaned = '<?xml version="1.0" encoding="UTF-8"?>\n' + cleaned;
    }
    return this.fixHTMLEntities(cleaned);
  }

  fixHTMLEntities(text) {
    return text
      .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
      .replace(/</g, (match, offset, string) => {
        const nextTag = string.indexOf('>', offset);
        const nextLt = string.indexOf('<', offset + 1);
        if (nextTag === -1 || (nextLt !== -1 && nextLt < nextTag)) return '&lt;';
        return match;
      });
  }

  async trySpecialFormats(url, xmlText) {
    const items = [];
    try {
      if (xmlText.trim().startsWith('{')) {
        const jsonItems = this.parseJSONFeed(xmlText);
        if (jsonItems.length > 0) return jsonItems;
      }
      if (url.includes('linux.do') || url.includes('discourse')) {
        const discourseItems = this.parseDiscourseRSS(xmlText);
        if (discourseItems.length > 0) return discourseItems;
      }
      if (url.includes('hostloc') || url.includes('forum.php')) {
        const forumItems = this.parseForumRSS(xmlText);
        if (forumItems.length > 0) return forumItems;
      }
    } catch (e) {}
    return items;
  }

  parseJSONFeed(jsonText) {
    try {
      const feed = JSON.parse(jsonText);
      const items = [];
      if (feed.items && Array.isArray(feed.items)) {
        for (const item of feed.items.slice(0, 10)) {
          items.push({
            title: item.title || '',
            link: item.url || item.external_url || '',
            description: this.stripHTML(item.content_text || item.content_html || item.summary || '').substring(0, 200),
            guid: item.id || item.url || item.title,
            publishedAt: item.date_published ? new Date(item.date_published).toLocaleString('zh-CN') : ''
          });
        }
      }
      return items;
    } catch { return []; }
  }

  parseDiscourseRSS(xmlText) {
    const items = [];
    try {
      const itemMatches = xmlText.match(/<item[^>]*>[\s\S]*?<\/item>/gi) ||
                         xmlText.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi);
      if (itemMatches) {
        for (const itemXml of itemMatches.slice(0, 10)) {
          const item = this.parseRSSItem(itemXml);
          if (item.title) items.push(item);
        }
      }
    } catch (e) {}
    return items;
  }

  parseForumRSS(xmlText) {
    const items = [];
    try {
      let fixedXml = xmlText
        .replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;')
        .replace(/encoding="gb2312"/i, 'encoding="utf-8"');
      const itemMatches = fixedXml.match(/<item[^>]*>[\s\S]*?<\/item>/gi);
      if (itemMatches) {
        for (const itemXml of itemMatches.slice(0, 10)) {
          const item = this.parseRSSItem(itemXml);
          if (item.title) items.push(item);
        }
      }
    } catch (e) {}
    return items;
  }

  parseXML(xmlText) {
    const items = [];
    const isAtom = xmlText.includes('<feed') && xmlText.includes('xmlns="http://www.w3.org/2005/Atom"');
    let itemMatches = isAtom ? xmlText.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi) :
                               xmlText.match(/<item[^>]*>[\s\S]*?<\/item>/gi);
    if (!itemMatches) return items;
    for (const itemXml of itemMatches) {
      try {
        const item = isAtom ? this.parseAtomEntry(itemXml) : this.parseRSSItem(itemXml);
        if (item.title && item.guid) items.push(item);
      } catch (e) {}
    }
    return items.slice(0, 10);
  }

  parseRSSItem(itemXml) {
    const item = {};
    const titleMatch = itemXml.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/) || itemXml.match(/<title[^>]*>(.*?)<\/title>/);
    item.title = titleMatch ? this.decodeHTML(titleMatch[1].trim()) : '';
    const linkMatch = itemXml.match(/<link[^>]*>(.*?)<\/link>/);
    item.link = linkMatch ? linkMatch[1].trim() : '';
    const descMatch = itemXml.match(/<description[^>]*><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                      itemXml.match(/<description[^>]*>(.*?)<\/description>/) ||
                      itemXml.match(/<content:encoded[^>]*><!\[CDATA\[(.*?)\]\]><\/content:encoded>/);
    if (descMatch) item.description = this.stripHTML(this.decodeHTML(descMatch[1])).substring(0, 200);
    const guidMatch = itemXml.match(/<guid[^>]*>(.*?)<\/guid>/);
    item.guid = guidMatch ? guidMatch[1].trim() : item.link || item.title;
    const pubDateMatch = itemXml.match(/<pubDate[^>]*>(.*?)<\/pubDate>/);
    if (pubDateMatch) {
      try { item.publishedAt = new Date(pubDateMatch[1].trim()).toLocaleString('zh-CN'); } catch { item.publishedAt = pubDateMatch[1].trim(); }
    }
    return item;
  }

  parseAtomEntry(entryXml) {
    const item = {};
    const titleMatch = entryXml.match(/<title[^>]*type=["']?html["']?[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                       entryXml.match(/<title[^>]*type=["']?html["']?[^>]*>(.*?)<\/title>/) ||
                       entryXml.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                       entryXml.match(/<title[^>]*>(.*?)<\/title>/);
    item.title = titleMatch ? this.decodeHTML(titleMatch[1].trim()) : '';
    const linkMatch = entryXml.match(/<link[^>]+href=["'](.*?)["'][^>]*\/?>/) || entryXml.match(/<link[^>]+href=["'](.*?)["'][^>]*><\/link>/);
    item.link = linkMatch ? linkMatch[1].trim() : '';
    const contentMatch = entryXml.match(/<content[^>]*type=["']?html["']?[^>]*><!\[CDATA\[(.*?)\]\]><\/content>/) ||
                         entryXml.match(/<content[^>]*type=["']?html["']?[^>]*>(.*?)<\/content>/) ||
                         entryXml.match(/<content[^>]*><!\[CDATA\[(.*?)\]\]><\/content>/) ||
                         entryXml.match(/<content[^>]*>(.*?)<\/content>/) ||
                         entryXml.match(/<summary[^>]*type=["']?html["']?[^>]*><!\[CDATA\[(.*?)\]\]><\/summary>/) ||
                         entryXml.match(/<summary[^>]*type=["']?html["']?[^>]*>(.*?)<\/summary>/) ||
                         entryXml.match(/<summary[^>]*><!\[CDATA\[(.*?)\]\]><\/summary>/) ||
                         entryXml.match(/<summary[^>]*>(.*?)<\/summary>/);
    if (contentMatch) item.description = this.stripHTML(this.decodeHTML(contentMatch[1])).substring(0, 200);
    const idMatch = entryXml.match(/<id[^>]*>(.*?)<\/id>/);
    item.guid = idMatch ? idMatch[1].trim() : item.link || item.title;
    const publishedMatch = entryXml.match(/<published[^>]*>(.*?)<\/published>/) || entryXml.match(/<updated[^>]*>(.*?)<\/updated>/);
    if (publishedMatch) {
      try { item.publishedAt = new Date(publishedMatch[1].trim()).toLocaleString('zh-CN'); } catch { item.publishedAt = publishedMatch[1].trim(); }
    }
    return item;
  }

  stripHTML(html) { return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
  decodeHTML(str) {
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
    return str.replace(/&[a-z0-9#]+;/gi, match => entities[match] || match);
  }
  isValidEmptyRSS(xmlText) { return xmlText.includes('<rss') || xmlText.includes('<feed') || (xmlText.includes('<?xml') && (xmlText.includes('rss') || xmlText.includes('atom'))); }
}
