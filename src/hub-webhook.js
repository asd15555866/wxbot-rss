// hub-webhook.js
import { WeixinBot } from './weixin-bot.js';
import { DBManager } from './db-manager.js';
import { RSSParser } from './rss-parser.js';
import { sleep, getSiteNameFromUrl, sendHubMessage } from './utils.js';

export async function handleHubWebhook(request, env) {
  const body = await request.json();
  const event = body;
  
  // 只处理 command 事件
if (event.type === 'event' && event.event?.type === 'command') {
  const command = event.event.data.command;
  const senderId = event.event.data.sender?.id;
  let args = event.event.data.args || {};
  
  // 🔥 新增：如果 args 是空对象，尝试从原始消息提取 URL
  if (typeof args === 'object' && Object.keys(args).length === 0) {
    const rawText = event.event.data.text || event.event.data.content || '';
    const match = rawText.match(/https?:\/\/[^\s]+/);
    if (match) {
      args = match[0]; // 直接作为字符串
      console.log('📝 从原始消息提取到 URL:', args);
    }
  }
    // 用 senderId 作为 userId
    const userId = senderId;
    
    // 根据命令分发处理
    let reply = await handleHubCommand(command, args, userId, env);
    
    // 如果有回复，发送给用户
    if (reply) {
      await sendHubReply(event, reply, env);
    }
    
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  
  return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
}

// ===== 命令分发器 =====

async function handleHubCommand(command, args, userId, env) {
  console.log('🔍 收到命令:', JSON.stringify({ command, args }));
  const dbManager = new DBManager(env.DB);
  
  switch (command) {
    case '/start':
      return '📖 欢迎使用 RSS 订阅 Bot！\n\n' +
             '📋 可用命令：\n' +
             '▪ /添加 <RSS链接> - 添加订阅\n' +
             '▪ /列表 - 查看订阅列表\n' +
             '▪ /删除 <编号> - 删除订阅\n' +
             '▪ /更新 - 立即检查所有订阅\n' +
             '▪ /失败 - 查看失败的订阅\n' +
             '▪ /统计 - 查看统计信息\n' +
             '▪ /状态 - 查看 RSS 源状态\n' +
             '▪ /帮助 - 显示帮助信息';
    
    case '添加':
      return await handleAddCommand(args, userId, env);
    
    case '列表':
      return await handleListCommand(userId, env);
    
    case '删除':
      return await handleDeleteCommand(args, userId, env);
    
    case '/check_rss':
    case '更新':
      return await handleCheckFeedsCommand(userId, env);
    
    case '失败':
      return await handleFailedCommand(userId, env);
    
    case '统计':
      return await handleStatsCommand(userId, env);
    
    case '状态':
      return await handleStatusCommand(userId, env);
    
    case '帮助':
      return '📖 帮助信息：\n\n' +
             '🔗 /添加 <RSS链接> - 添加单个RSS订阅\n' +
             '📝 /列表 - 查看所有订阅\n' +
             '🗑 /删除 <编号> - 删除单个订阅\n' +
             '🔍 /更新 - 立即检查所有订阅\n' +
             '⚠️ /失败 - 查看失败的订阅\n' +
             '📊 /统计 - 查看统计信息\n' +
             '📈 /状态 - 查看RSS源状态报告\n' +
             '❓ /帮助 - 显示帮助信息';
    
    default:
      return `❌ 未知命令：${command}\n输入 /帮助 查看可用命令。`;
  }
}

// ===== 各命令实现 =====

// 1. 添加订阅
async function handleAddCommand(args, userId, env) {
  const dbManager = new DBManager(env.DB);
  
  // 兼容 args 是字符串或对象
  let url = '';
  if (typeof args === 'string') {
    url = args;
  } else if (args.url) {
    url = args.url;
  } else if (args._ && args._.length > 0) {
    url = args._[0];
  }
  
  // 如果还是没提取到，尝试从第一个参数获取
  if (!url) {
    const firstArg = Object.values(args)[0];
    if (firstArg && typeof firstArg === 'string' && firstArg.startsWith('http')) {
      url = firstArg;
    }
  }
  
  if (!url || !url.startsWith('http')) {
    return '❌ 请提供有效的 RSS 链接。\n用法：添加 <RSS链接>';
  }
  
  try {
    // 测试 RSS 是否可访问
    const rssParser = new RSSParser(env);
    let siteName = '';
    try {
      const items = await rssParser.parseRSS(url);
      if (items.length > 0) {
        siteName = getSiteNameFromUrl(url);
      }
    } catch (e) {
      siteName = getSiteNameFromUrl(url);
    }
    
    // 检查是否已订阅
    const exists = await dbManager.checkSubscriptionExists(userId, url);
    if (exists) {
      return `⚠️ 已订阅: ${siteName}`;
    }
    
    // 添加订阅
    await dbManager.addSubscription(userId, url, siteName);
    return `✅ 订阅成功: ${siteName}\n🔗 ${url}`;
    
  } catch (error) {
    console.error('添加订阅失败:', error);
    return `❌ 订阅失败: ${error.message}`;
  }
}

// 2. 查看订阅列表
async function handleListCommand(userId, env) {
  const dbManager = new DBManager(env.DB);
  
  try {
    const subs = await dbManager.getUserSubscriptions(userId);
    if (subs.length === 0) {
      return '📭 您还没有任何 RSS 订阅。使用 /添加 <RSS链接> 添加。';
    }
    
    let message = `📚 您的 RSS 订阅列表（${subs.length} 个）：\n\n`;
    subs.forEach((sub, index) => {
      message += `${index + 1}. ${sub.site_name}\n`;
      message += `   🔗 ${sub.rss_url}\n`;
      message += `   📅 ${sub.created_at}\n\n`;
    });
    message += '💡 使用 /删除 <编号> 取消订阅';
    return message;
    
  } catch (error) {
    console.error('获取列表失败:', error);
    return `❌ 获取列表失败: ${error.message}`;
  }
}

// 3. 删除订阅
async function handleDeleteCommand(args, userId, env) {
  const dbManager = new DBManager(env.DB);
  
  // 获取订阅编号
  const feedId = args.feed_id || args._?.[0];
  if (!feedId) {
    return '❌ 请提供订阅编号。\n用法：/删除 <编号> 或 /删除 --feed_id <编号>';
  }
  
  try {
    const subs = await dbManager.getUserSubscriptions(userId);
    const index = parseInt(feedId) - 1;
    
    if (isNaN(index) || index < 0 || index >= subs.length) {
      return `❌ 无效的订阅编号: ${feedId}。使用 /list 查看所有订阅。`;
    }
    
    const sub = subs[index];
    const deleted = await dbManager.deleteSubscription(userId, sub.rss_url);
    
    if (deleted) {
      return `✅ 已取消订阅: ${sub.site_name}`;
    } else {
      return `❌ 取消订阅失败，请稍后再试`;
    }
    
  } catch (error) {
    console.error('删除订阅失败:', error);
    return `❌ 删除订阅失败: ${error.message}`;
  }
}

// 4. 检查所有 RSS
async function handleCheckFeedsCommand(userId, env) {
  const dbManager = new DBManager(env.DB);
  const rssParser = new RSSParser(env);
  const bot = new WeixinBot(env.DB, env);
  
  try {
    const subs = await dbManager.getUserSubscriptions(userId);
    if (subs.length === 0) {
      return '📭 您还没有任何 RSS 订阅。使用 /添加 <RSS链接> 添加。';
    }
    
    let totalNew = 0;
    const results = [];
    
    for (const sub of subs) {
      try {
        const items = await rssParser.parseRSS(sub.rss_url);
        if (items.length === 0) {
          results.push(`⏭️ ${sub.site_name}: 无新内容`);
          continue;
        }
        
        let newCount = 0;
        for (const item of items) {
          const exists = await dbManager.checkItemExists(sub.rss_url, item.guid);
          if (!exists) {
            // 推送给用户
            await bot.sendRSSUpdate(userId, sub.rss_url, item, sub.site_name);
            await dbManager.saveRSSItem(sub.rss_url, item);
            newCount++;
            await sleep(300);
          }
        }
        
        if (newCount > 0) {
          results.push(`✅ ${sub.site_name}: ${newCount} 条新文章`);
          totalNew += newCount;
        } else {
          results.push(`⏭️ ${sub.site_name}: 无新内容`);
        }
      } catch (error) {
        results.push(`❌ ${sub.site_name}: ${error.message}`);
        await dbManager.recordFailure(sub.rss_url, error.message);
      }
    }
    
    return `📊 RSS 检查完成\n\n${results.join('\n')}\n\n📈 共 ${totalNew} 条新文章`;
    
  } catch (error) {
    console.error('检查 RSS 失败:', error);
    return `❌ RSS 检查失败: ${error.message}`;
  }
}

// 5. 查看失败订阅
async function handleFailedCommand(userId, env) {
  const dbManager = new DBManager(env.DB);
  
  try {
    const userSubscriptions = await dbManager.getUserSubscriptions(userId);
    const failedSubs = await dbManager.getFailedSubscriptions();
    
    const userFailed = failedSubs.filter(failed =>
      userSubscriptions.some(sub => sub.rss_url === failed.rss_url)
    );
    
    if (userFailed.length === 0) {
      return '✅ 您的所有 RSS 订阅都工作正常！';
    }
    
    let message = `⚠️ 失败的 RSS 订阅 (${userFailed.length} 个)：\n\n`;
    userFailed.forEach((failed, index) => {
      const errorMsg = failed.error_message || '未知错误';
      const shortError = errorMsg.length > 50 ? errorMsg.substring(0, 50) + '...' : errorMsg;
      message += `${index + 1}. ${failed.site_name || '未知网站'}\n`;
      message += `   🔗 ${failed.rss_url}\n`;
      message += `   ❌ ${shortError}\n`;
      message += `   🔄 失败次数: ${failed.failure_count}\n\n`;
    });
    
    message += '💡 建议：检查 RSS 源是否可访问，或考虑删除失效的订阅';
    return message;
    
  } catch (error) {
    console.error('获取失败订阅失败:', error);
    return `❌ 获取失败信息时出错: ${error.message}`;
  }
}

// 6. 查看统计信息
async function handleStatsCommand(userId, env) {
  const dbManager = new DBManager(env.DB);
  
  try {
    const userStats = await dbManager.getUserSubscriptions(userId);
    const globalStats = await dbManager.getStats();
    
    return `📊 统计信息：\n\n` +
           `👤 您的订阅：${userStats.length} 个\n` +
           `🌐 全局统计：\n` +
           `  └ 总用户：${globalStats.users} 人\n` +
           `  └ 总订阅：${globalStats.subscriptions} 个\n` +
           `  └ 文章记录：${globalStats.items} 条\n\n` +
           `🔄 检查频率：每 10 分钟\n` +
           `💾 记录保留：30 天`;
    
  } catch (error) {
    console.error('获取统计信息失败:', error);
    return `❌ 获取统计信息失败: ${error.message}`;
  }
}

// 7. 查看 RSS 源状态
async function handleStatusCommand(userId, env) {
  const dbManager = new DBManager(env.DB);
  const rssParser = new RSSParser(env);
  
  try {
    const subs = await dbManager.getUserSubscriptions(userId);
    if (subs.length === 0) {
      return '📭 您还没有任何 RSS 订阅。';
    }
    
    let message = `📊 RSS 源状态报告 (${subs.length} 个)：\n\n`;
    
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const stats = rssParser.getAccessStats(sub.rss_url);
      
      let status = '🟢 正常';
      let details = '';
      
      if (stats.rateLimitCount > 0) {
        status = '🔴 频率限制';
        const lastAccess = new Date(stats.lastAccess);
        const now = new Date();
        const timeDiff = Math.floor((now - lastAccess) / 1000 / 60);
        details = `限流 ${stats.rateLimitCount} 次，${timeDiff} 分钟前访问`;
      } else if (stats.failureCount > 0) {
        status = '🟡 部分失败';
        details = `失败 ${stats.failureCount} 次，成功 ${stats.successCount} 次`;
      } else if (stats.successCount > 0) {
        details = `成功 ${stats.successCount} 次`;
      }
      
      message += `${i + 1}. ${sub.site_name}\n`;
      message += `   ${status}\n`;
      if (details) {
        message += `   📝 ${details}\n`;
      }
      message += `   🔗 ${sub.rss_url}\n\n`;
    }
    
    return message;
    
  } catch (error) {
    console.error('获取状态信息失败:', error);
    return `❌ 获取状态信息失败: ${error.message}`;
  }
}

// ===== 发送回复 =====

async function sendHubReply(event, text, env) {
  const to = event.event.data.sender?.id;

  if (!to) {
    console.warn('缺少 to，无法发送回复');
    return;
  }

  await sendHubMessage(env, { to, type: 'text', content: text });
}