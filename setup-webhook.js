const fs = require('fs');
const dotenv = require('dotenv');

// 從 .dev.vars 載入環境變數（若存在）
if (fs.existsSync('.dev.vars')) {
  const envConfig = dotenv.parse(fs.readFileSync('.dev.vars'));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const WORKER_URL = process.argv[2];

if (!TELEGRAM_BOT_TOKEN) {
  console.error('請先設定 TELEGRAM_BOT_TOKEN（環境變數或 .dev.vars）');
  process.exit(1);
}
if (!TELEGRAM_WEBHOOK_SECRET) {
  console.error('請先設定 TELEGRAM_WEBHOOK_SECRET（環境變數或 .dev.vars）');
  process.exit(1);
}
if (!WORKER_URL) {
  console.error('請提供已部署的 Worker 網址。');
  console.error('用法：node setup-webhook.js <https://your-worker-url.workers.dev>');
  process.exit(1);
}

const webhookUrl = `${WORKER_URL.replace(/\/$/, '')}/webhook/telegram`;
const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

async function setWebhook() {
  console.log(`Setting webhook to: ${webhookUrl}`);
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: TELEGRAM_WEBHOOK_SECRET
    })
  });
  const data = await response.json();
  console.log('Response:', data);
}

setWebhook();
