import { DBManager } from './db-manager.js';
import { sleep, getSiteNameFromUrl, callDeepSeekChat, sendHubMessage } from './utils.js';

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
      // 翻译失败则保留原标题
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
    
    let sentToPrivate = false;
    let sentToTargets = 0;
    
    switch (pushMode) {
      case 'smart':
        if (chatIds.length === 0) {
          await this.sendRSSItem(ownerUserId, item, siteName);
          sentToPrivate = true;
        } else {
          sentToTargets = await this.pushToTargets(rssUrl, item, siteName, chatIds);
        }
        break;
      case 'both':
        await this.sendRSSItem(ownerUserId, item, siteName);
        sentToPrivate = true;
        sentToTargets = await this.pushToTargets(rssUrl, item, siteName, chatIds);
        break;
      case 'private':
        await this.sendRSSItem(ownerUserId, item, siteName);
        sentToPrivate = true;
        break;
      case 'targets':
        sentToTargets = await this.pushToTargets(rssUrl, item, siteName, chatIds);
        break;
    }
    
    console.log(`推送完成：私聊${sentToPrivate ? '✅' : '❌'}, 目标${sentToTargets}个`);
  }

  // 向绑定的会话目标推送（去重 + 节流），返回成功推送的目标数
  async pushToTargets(rssUrl, item, siteName, chatIds) {
    let sentToTargets = 0;
    for (const chatId of chatIds) {
      try {
        const already = await this.dbManager.hasPushedToChat(rssUrl, item.guid, chatId);
        if (already) continue;
        await this.sendRSSItem(chatId, item, siteName);
        await this.dbManager.savePushRecord(rssUrl, item.guid, chatId);
        sentToTargets++;
        await sleep(200);
      } catch (e) {
        console.warn('推送到目标失败', chatId, e.message);
      }
    }
    return sentToTargets;
  }

  // ===== AI 总结 =====

  async generateAISummary(text) {
    const truncatedText = text.substring(0, 2000);
    const AI_API_KEY = this.env?.DEEPSEEK_API_KEY;
    if (!AI_API_KEY) {
      console.error('❌ 环境变量 DEEPSEEK_API_KEY 未设置，无法生成 AI 摘要');
      return text.substring(0, 200) || '（无内容）';
    }

    return await callDeepSeekChat(AI_API_KEY, [
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
    ]);
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

    try {
      const translated = await callDeepSeekChat(AI_API_KEY, [
        { role: 'system', content: '你是一个翻译助手，请将用户提供的英文标题翻译成简洁流畅的中文，只输出翻译结果，不要添加任何额外说明。' },
        { role: 'user', content: title }
      ]);
      if (!translated) return title;
      return translated;
    } catch (error) {
      console.error('翻译标题失败，使用原标题:', error);
      return title;
    }
  }

  // ===== 微信推送 =====

  async sendViaILink(userId, message) {
    const TO_USER_ID = 'o9cq80-CwnZEH3pANf4ct59vCTlo@im.wechat';
    const response = await sendHubMessage(this.env, { to_user_id: TO_USER_ID, content: message });
    if (response) {
      const result = await response.json();
      console.log('[sendViaILink] 发送成功:', result);
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
    return getSiteNameFromUrl(url);
  }
}