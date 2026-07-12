import { DBManager } from './db-manager.js';

export class WeixinBot {
  constructor(db, env) {
    this.dbManager = new DBManager(db);
    this.env = env;
  }

  // ===== 核心推送方法 =====

  async sendRSSItem(userId, item, siteName) {
    let summary = '';
    try {
      const contentToSummarize = `标题：${item.title}\n内容：${item.fullContent || item.description || ''}`;
      summary = await this.generateAISummary(contentToSummarize);
    } catch (error) {
      console.error('AI 总结失败，使用原始内容:', error);
      summary = item.description || item.title || '（无内容）';
    }

    // 🆕 翻译标题（如果是英文则翻译，中文保持原样）
    let title = item.title;
    try {
      title = await this.translateTitle(item.title);
    } catch (e) {
      console.warn('翻译标题失败，保留原标题:', e.message);
    }

    const link = item.link || '';
    
    // 优化时间显示
    let timeDisplay = item.publishedAt || '未知时间';
    try {
      const date = new Date(item.publishedAt);
      if (!isNaN(date.getTime())) {
        timeDisplay = date.toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
    } catch (e) {}

    // 🆕 使用 Markdown 格式
    let message = `# ${title}\n\n`;
    message += `> ${summary}\n\n`;
    message += `[点击查看全文](${link})\n\n`;
    message += `📌 ${siteName}\n\n `;
    message += `🕐 ${timeDisplay}`;

    await this.sendViaILink(userId, message);
  }

  async sendRSSUpdate(ownerUserId, rssUrl, item, siteName) {
    const pushMode = await this.dbManager.getUserPushMode(ownerUserId) || 'smart';
    const chatIds = await this.dbManager.listBindingsForSubscription(ownerUserId, rssUrl);
    
    console.log(`用户 ${ownerUserId} 推送模式: ${pushMode}, 绑定目标: ${chatIds.length}个`);
    
    let attempted = 0, succeeded = 0, failed = 0;
    const sendPrivate = async () => {
      attempted++;
      try {
        await this.sendRSSItem(ownerUserId, item, siteName);
        succeeded++;
      } catch (e) {
        failed++;
        console.warn('推送到私聊失败', ownerUserId, e.message);
      }
    };
    
    switch (pushMode) {
      case 'smart':
        if (chatIds.length === 0) {
          await sendPrivate();
        } else {
          for (const chatId of chatIds) {
            const already = await this.dbManager.hasPushedToChat(rssUrl, item.guid, chatId);
            if (already) continue;
            try {
              attempted++;
              await this.sendRSSItem(chatId, item, siteName);
              await this.dbManager.savePushRecord(rssUrl, item.guid, chatId);
              succeeded++;
              await new Promise(r => setTimeout(r, 200));
            } catch (e) {
              failed++;
              console.warn('推送到目标失败', chatId, e.message);
            }
          }
        }
        break;
      case 'both':
        await sendPrivate();
        for (const chatId of chatIds) {
          const already = await this.dbManager.hasPushedToChat(rssUrl, item.guid, chatId);
          if (already) continue;
          try {
            attempted++;
            await this.sendRSSItem(chatId, item, siteName);
            await this.dbManager.savePushRecord(rssUrl, item.guid, chatId);
            succeeded++;
            await new Promise(r => setTimeout(r, 200));
          } catch (e) {
            failed++;
            console.warn('推送到目标失败', chatId, e.message);
          }
        }
        break;
      case 'private':
        await sendPrivate();
        break;
      case 'targets':
        for (const chatId of chatIds) {
          const already = await this.dbManager.hasPushedToChat(rssUrl, item.guid, chatId);
          if (already) continue;
          try {
            attempted++;
            await this.sendRSSItem(chatId, item, siteName);
            await this.dbManager.savePushRecord(rssUrl, item.guid, chatId);
            succeeded++;
            await new Promise(r => setTimeout(r, 200));
          } catch (e) {
            failed++;
            console.warn('推送到目标失败', chatId, e.message);
          }
        }
        break;
    }
    
    const delivered = succeeded > 0 || attempted === 0;
    console.log(`推送完成：尝试${attempted}次，成功${succeeded}次，失败${failed}次`);
    return { attempted, succeeded, failed, delivered };
  }

  // ===== AI 总结 =====

  async generateAISummary(text) {
    const truncatedText = text.substring(0, 2000);
    const AI_API_KEY = this.env?.DEEPSEEK_API_KEY;
    if (!AI_API_KEY) {
      console.error('❌ 环境变量 DEEPSEEK_API_KEY 未设置，无法生成 AI 摘要');
      return text.substring(0, 200) || '（无内容）';
    }
    const AI_API_URL = 'https://api.deepseek.com/v1/chat/completions';

    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: `请用中文总结以下内容，要求：
1. 自动判断内容类型（促销/教程/活动/新闻/其他）
2. 根据类型选择最合适的展示格式：
   - 如果是 VPS/主机促销：用项目符号列出价格、配置、优惠
   - 如果是教程/指南：用短段落概括核心步骤
   - 如果是活动通知：突出时间、地点、参与方式
   - 如果是技术讨论：提炼主要观点和结论
3. 使用 Markdown 列表（"- " 开头）让排版清晰
4. 控制在 100-150 字左右，不丢失关键信息` },
          { role: 'user', content: truncatedText }
        ]
      })
    });

    if (!response.ok) throw new Error(`AI API 请求失败: ${response.status}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI API 返回内容为空或格式异常');
    return content.trim();
  }

  // ===== 标题翻译 =====

  async translateTitle(title) {
    // 如果标题中包含中文字符，直接返回原标题
    if (/[\u4e00-\u9fa5]/.test(title)) {
      return title;
    }
    const AI_API_KEY = this.env?.DEEPSEEK_API_KEY;
    if (!AI_API_KEY) {
      console.error('❌ 环境变量 DEEPSEEK_API_KEY 未设置，无法翻译标题');
      return title;
    }
    const AI_API_URL = 'https://api.deepseek.com/v1/chat/completions';

    try {
      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: '你是一个翻译助手，请将用户提供的英文标题翻译成简洁流畅的中文，只输出翻译结果，不要添加任何额外说明。' },
            { role: 'user', content: title }
          ]
        })
      });

      if (!response.ok) throw new Error(`翻译API请求失败: ${response.status}`);
      const data = await response.json();
      const translated = data?.choices?.[0]?.message?.content?.trim();
      if (!translated) return title;
      return translated;
    } catch (error) {
      console.error('翻译标题失败，使用原标题:', error);
      return title;
    }
  }

  // ===== 微信推送 =====

  async sendViaILink(userId, message) {
    const HUB_URL = this.env?.HUB_URL;
    const APP_TOKEN = this.env?.APP_TOKEN;
    
    if (!HUB_URL || !APP_TOKEN) {
      throw new Error('[sendViaILink] 缺少环境变量 HUB_URL 或 APP_TOKEN');
    }
    
    const TO_USER_ID = 'o9cq80-CwnZEH3pANf4ct59vCTlo@im.wechat';
    const payload = { to_user_id: TO_USER_ID, content: message };
    const API_ENDPOINT = `${HUB_URL}/bot/v1/message/send`;

    try {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${APP_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[sendViaILink] 发送失败:', response.status, errorText);
        throw new Error(`[sendViaILink] 发送失败: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      console.log('[sendViaILink] 发送成功:', result);
      return true;
    } catch (error) {
      console.error('[sendViaILink] 调用 Hub API 出错:', error.message);
      throw error;
    }
  }

  // ===== 辅助方法 =====

  escapeHTML(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  isValidUrl(string) {
    try { new URL(string); return true; } catch { return false; }
  }

  async extractSiteName(url) {
    try {
      const domain = new URL(url).hostname;
      return domain.replace('www.', '');
    } catch { return 'Unknown Site'; }
  }
}