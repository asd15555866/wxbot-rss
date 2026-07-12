// 共享工具函数

// 延时（用于节流 / 重试退避）
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 判断错误是否为 SQLite UNIQUE 约束冲突
export function isUniqueConstraintError(error) {
  return !!error && typeof error.message === 'string' && error.message.includes('UNIQUE');
}

// 从 URL 提取站点名（去掉 www. 前缀）
export function getSiteNameFromUrl(url, fallback = 'Unknown Site') {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return fallback;
  }
}

// ===== DeepSeek AI 客户端 =====
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 调用 DeepSeek 聊天补全接口，返回去空白后的文本内容
export async function callDeepSeekChat(apiKey, messages, model = 'deepseek-chat') {
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages })
  });

  if (!response.ok) throw new Error(`AI API 请求失败: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content.trim();
}

// ===== ilink Hub 消息发送 =====
// 统一处理鉴权、错误日志；payload 由调用方决定（不同接口字段不同）
export async function sendHubMessage(env, payload) {
  const HUB_URL = env?.HUB_URL || 'https://hub.openilink.com';
  const APP_TOKEN = env?.APP_TOKEN;

  if (!APP_TOKEN) {
    console.error('[sendHubMessage] 缺少环境变量 APP_TOKEN');
    return null;
  }

  try {
    const response = await fetch(`${HUB_URL}/bot/v1/message/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${APP_TOKEN}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[sendHubMessage] 发送失败:', response.status, errorText);
      return null;
    }

    return response;
  } catch (error) {
    console.error('[sendHubMessage] 调用 Hub API 出错:', error.message);
    return null;
  }
}
