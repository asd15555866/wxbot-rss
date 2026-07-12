# wxbot-rss
连接Clawbot的一个rss订阅机器人，使用ilink推送到微信。

## 安全配置 / Security

请使用 Cloudflare Secrets 保存敏感配置，不要将真实值提交到仓库：

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put APP_TOKEN
wrangler secret put WEBHOOK_SECRET
```

`POST /hub/webhook` 和 `GET /check-rss` 都需要通过以下任一方式提供
`WEBHOOK_SECRET`：

- `X-Webhook-Secret` 请求头
- `?secret=` 查询参数

> **WARNING:** 之前提交的 `APP_TOKEN`（`app_d65cbceb...`）已经暴露在 Git
> 历史中，必须在 ilink 控制台立即轮换/撤销该 Token。同时请轮换任何曾经提交的
> DeepSeek API Key。
