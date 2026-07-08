import { WeixinBot } from './weixin-bot.js';
import { RSSParser } from './rss-parser.js';
import { DBManager } from './db-manager.js';
import { handleHubWebhook } from './hub-webhook.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 初始化数据库表
    try {
      const dbManager = new DBManager(env.DB);
      await dbManager.ensureSchema();
    } catch (e) {
      console.warn('初始化数据库结构失败(可忽略):', e.message);
    }

    // Hub Webhook 处理（微信命令入口）
    if (url.pathname === '/hub/webhook' && request.method === 'POST') {
      return await handleHubWebhook(request, env);
    }
    
    // 手动触发 RSS 检查
    if (url.pathname === '/check-rss' && request.method === 'GET') {
      await this.checkRSSFeeds(env);
      return new Response('RSS检查完成', { status: 200 });
    }
    
    return new Response('RSS Bot运行中', { status: 200 });
  },

  // Cron 触发的 RSS 检查
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(this.checkRSSFeeds(env));
  },

  // 检查所有 RSS 源
  async checkRSSFeeds(env) {
    const dbManager = new DBManager(env.DB);
    const rssParser = new RSSParser(env);
    const bot = new WeixinBot(env.DB, env);  // 注意：不再传 TELEGRAM_BOT_TOKEN
    
    try {
      const subscriptions = await dbManager.getAllSubscriptions();
      
      if (subscriptions.length === 0) {
        console.log('没有找到任何RSS订阅');
        return;
      }
      
      const urlToSubscribers = new Map();
      for (const sub of subscriptions) {
        const key = sub.rss_url;
        if (!urlToSubscribers.has(key)) {
          urlToSubscribers.set(key, []);
        }
        urlToSubscribers.get(key).push(sub);
      }

      const urls = Array.from(urlToSubscribers.keys());
      const BATCH_SIZE = 15;
      
      console.log(`开始处理 ${urls.length} 个RSS源，批次大小: ${BATCH_SIZE}`);
      
      for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        const batchUrls = urls.slice(i, i + BATCH_SIZE);
        console.log(`处理批次 ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(urls.length/BATCH_SIZE)}`);
        
        const results = await Promise.allSettled(batchUrls.map(async (rssUrl) => {
          const subsForUrl = urlToSubscribers.get(rssUrl);
          const siteName = subsForUrl[0]?.site_name || 'RSS';
          
          try {
            const stats = rssParser.getAccessStats(rssUrl);
            if (stats.rateLimitCount > 0) {
              console.log(`跳过 ${siteName} - 频率限制中`);
              return { skipped: true, reason: 'rate_limited' };
            }
            
            const items = await rssParser.parseRSS(rssUrl);
            if (items.length > 0) {
              await dbManager.clearFailureRecord(rssUrl);
              console.log(`成功解析 ${siteName}: ${items.length} 条内容`);
              
              let processedCount = 0;
              for (const item of items) {
                try {
                  const exists = await dbManager.checkItemExists(rssUrl, item.guid);
                  if (exists) continue;

                  for (const sub of subsForUrl) {
                    try {
                      await bot.sendRSSUpdate(sub.user_id, rssUrl, item, siteName);
                      await new Promise(resolve => setTimeout(resolve, 150));
                    } catch (error) {
                      console.error(`推送给用户 ${sub.user_id} 失败:`, error.message);
                    }
                  }
                  
                  await dbManager.saveRSSItem(rssUrl, item);
                  processedCount++;
                  await new Promise(resolve => setTimeout(resolve, 300));
                } catch (error) {
                  console.error(`处理RSS项目失败:`, error.message);
                }
              }
              
              return { success: true, processed: processedCount };
            } else {
              console.log(`跳过 ${siteName} - 无新内容`);
              return { skipped: true, reason: 'no_content' };
            }
          } catch (error) {
            console.error(`处理RSS源 ${rssUrl} 失败:`, error);
            await dbManager.recordFailure(rssUrl, error.message);
            return { error: true, message: error.message };
          }
        }));
        
        const batchStats = { total: batchUrls.length, success: 0, skipped: 0, error: 0 };
        results.forEach(result => {
          if (result.status === 'fulfilled') {
            if (result.value.success) batchStats.success++;
            else if (result.value.skipped) batchStats.skipped++;
            else if (result.value.error) batchStats.error++;
          } else {
            batchStats.error++;
          }
        });
        
        console.log(`批次 ${Math.floor(i/BATCH_SIZE) + 1} 完成: 成功${batchStats.success}, 跳过${batchStats.skipped}, 失败${batchStats.error}`);
        
        if (i + BATCH_SIZE < urls.length) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      try {
        await dbManager.cleanupOldItems(30);
      } catch (error) {
        console.error('清理旧记录失败:', error);
      }
      
      console.log('RSS检查完成');
      
    } catch (error) {
      console.error('RSS检查失败:', error);
      try {
        await dbManager.recordFailure('SYSTEM_ERROR', `RSS检查失败: ${error.message}`);
      } catch (dbError) {
        console.error('记录系统错误失败:', dbError);
      }
    }
  }
};