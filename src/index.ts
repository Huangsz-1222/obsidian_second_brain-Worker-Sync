import type { Env } from './env';
import { sendMessage } from './telegram';
import { processArticle } from './parser';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    // Telegram webhook endpoint
    if (request.method === 'POST' && url.pathname === '/webhook/telegram') {
      // (Optional) Validate custom secret passed in webhook query or header
      // For Telegram, you can use the secret token feature
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        const body: any = await request.json();
        const message = body.message;

        if (message && message.text) {
          const chatId = message.chat.id;
          const text = message.text as string;

          // Simple URL extraction (find first URL in text)
          const urlMatch = text.match(/(https?:\/\/[^\s]+)/);

          if (urlMatch) {
            const articleUrl = urlMatch[1];
            
            // 1. Acknowledge receipt
            await sendMessage(env, chatId, '已收到，後台提取中...');

            // 2. Perform long-running task in background
            ctx.waitUntil(processArticle(env, articleUrl, chatId));
          } else {
            await sendMessage(env, chatId, '請發送包含文章網址的訊息。');
          }
        }
        
        // Return 200 OK immediately so Telegram doesn't retry
        return new Response('OK', { status: 200 });
      } catch (err: any) {
        console.error('Webhook error:', err);
        return new Response('Error', { status: 500 });
      }
    }

    // Browser Extension endpoint
    if (request.method === 'OPTIONS' && url.pathname === '/webhook/browser') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method === 'POST' && url.pathname === '/webhook/browser') {
      try {
        const body: any = await request.json();
        const articleUrl = body.url;
        const secret = body.secret;
        
        const expectedSecret = env.BROWSER_SECRET || env.TELEGRAM_WEBHOOK_SECRET;

        if (secret !== expectedSecret) {
          return new Response('Unauthorized', { status: 401 });
        }

        if (!articleUrl) {
          return new Response('Missing URL', { status: 400 });
        }

        const chatId = Number(env.ADMIN_CHAT_ID);
        if (!chatId) {
           return new Response('ADMIN_CHAT_ID not configured', { status: 500 });
        }

        // Perform long-running task in background
        ctx.waitUntil(processArticle(env, articleUrl, chatId));

        return new Response(JSON.stringify({ success: true }), { 
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err: any) {
        console.error('Browser webhook error:', err);
        return new Response('Error', { status: 500 });
      }
    }

    // PWA Manifest endpoint
    if (request.method === 'GET' && url.pathname === '/pwa/manifest.json') {
      const manifest = {
        name: "Obsidian Clipper",
        short_name: "Clipper",
        start_url: "/pwa/install",
        display: "standalone",
        icons: [{
          src: "https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/obsidian.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any"
        }],
        share_target: {
          action: "/pwa/share",
          method: "GET",
          params: {
            title: "title",
            text: "text",
            url: "url"
          }
        }
      };
      return new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/manifest+json' }
      });
    }

    // PWA Install page
    if (request.method === 'GET' && url.pathname === '/pwa/install') {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Obsidian Clipper 安裝頁面</title>
          <link rel="manifest" href="/pwa/manifest.json">
          <style>
            body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f4f4f5; text-align: center; padding: 20px; }
            img { width: 120px; height: 120px; margin-bottom: 20px; border-radius: 20px; }
            h1 { color: #18181b; }
            p { color: #52525b; max-width: 400px; line-height: 1.5; font-size: 16px;}
            .btn { background: #7c3aed; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; margin-top: 20px; font-weight: bold; }
          </style>
        </head>
        <body>
          <img src="https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/obsidian.png" alt="Obsidian Logo">
          <h1>Obsidian Clipper</h1>
          <p>這個頁面<strong>不是用來輸入網址的</strong>喔！<br><br>這是一個安裝畫面。請點擊右下角的瀏覽器選單 (⋮)，選擇 <strong>「加到主畫面 (Add to Home screen)」</strong>。</p>
          <p>安裝完成後，以後在任何網頁點擊系統的「分享」，就能直接把它傳到 Obsidian！</p>
        </body>
        </html>
      `;
      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    // PWA Share endpoint
    if (request.method === 'GET' && url.pathname === '/pwa/share') {
      const sharedUrl = url.searchParams.get('url') || url.searchParams.get('text');
      
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>處理中...</title>
          <style>
            body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f4f4f5; text-align: center; }
            h1 { color: #10b981; }
            p { color: #52525b; }
          </style>
        </head>
        <body>
          <h1>✅ 發送成功！</h1>
          <p>文章已在後台處理中，本畫面將自動關閉。</p>
          <script>
            setTimeout(() => { window.close(); }, 2000);
          </script>
        </body>
        </html>
      `;

      if (sharedUrl) {
        const chatId = Number(env.ADMIN_CHAT_ID);
        // Extract URL in case the shared text is something like "Check this out: https://..."
        const urlMatch = sharedUrl.match(/(https?:\/\/[^\s]+)/);
        const finalUrl = urlMatch ? urlMatch[1] : sharedUrl;

        if (chatId && finalUrl) {
           ctx.waitUntil(processArticle(env, finalUrl, chatId));
        }
      }

      return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
    }

    return new Response('Not Found', { status: 404 });
  },
};

