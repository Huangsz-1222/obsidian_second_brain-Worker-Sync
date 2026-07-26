import type { Env } from './env';
import { saveToGitHub } from './github';
import { sendMessage } from './telegram';

// Helper to sanitize filenames
function sanitizeFilename(name: string): string {
  // Remove \ / : * ? " < > |
  return name.replace(/[\\/:*?"<>|]/g, '').trim();
}

function generateYamlFrontmatter(title: string, url: string, author?: string): string {
  const now = new Date();
  // Escape double quotes in title
  const safeTitle = title.replace(/"/g, '\\"');
  
  return `---
title: "${safeTitle}"
source: "${url}"
author: "${author || 'Unknown'}"
created_at: ${now.toISOString()}
tags:
  - clipping
  - unread
---

`;
}

export async function processArticle(env: Env, url: string, chatId: number): Promise<void> {
  console.log('[clip] processArticle start, url=', url, 'chatId=', chatId);
  try {
    // 1. Fetch from Jina Reader API
    const jinaUrl = `https://r.jina.ai/${url}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    if (env.JINA_API_KEY) {
      headers['Authorization'] = `Bearer ${env.JINA_API_KEY}`;
    }

    let response;
    let retries = 3;
    while (retries > 0) {
      response = await fetch(jinaUrl, { headers });
      if (response.status === 429) {
        retries--;
        if (retries === 0) break;
        
        let waitTime = 2; // Default 2 seconds
        try {
          const errData: any = await response.clone().json();
          if (errData.retryAfter) {
            waitTime = errData.retryAfter;
          }
        } catch (e) {
          // ignore
        }
        
        console.log(`Rate limited by Jina. Waiting ${waitTime}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      throw new Error(`Jina Reader failed: ${response?.status} ${await response?.text()}`);
    }

    const resJson: any = await response.json();
    console.log('[clip] Jina ok, status=', response.status, 'hasTitle=', !!resJson?.data?.title, 'contentLen=', (resJson?.data?.content || '').length);
    // Jina returns { code, status, data: { title, url, content, author, ... } }
    const data = resJson.data || resJson; // Fallback in case of different format
    
    let title = data.title || 'Untitled';
    let content = data.content || '';
    let author = data.author || '';

    // Append original link at the end
    content += `\n\n> 原文連結：[點擊跳轉](${url})\n`;

    // 2. Generate filename and frontmatter
    const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const cleanTitle = sanitizeFilename(title);
    const filename = `${dateStr}-${cleanTitle}.md`;

    const frontmatter = generateYamlFrontmatter(title, url, author);
    const finalContent = frontmatter + content;

    // 3. Save to GitHub
    console.log('[clip] saving to github, filename=', filename, 'bodyLen=', finalContent.length);
    const savedPath = await saveToGitHub(env, filename, finalContent);
    console.log('[clip] github saved at', savedPath);

    // 4. Send success message
    await sendMessage(env, chatId, `已成功存入 Obsidian：\`${savedPath}\``);
  } catch (error: any) {
    console.error('[clip] Process error:', error?.message || error, error?.stack);
    await sendMessage(env, chatId, `採集失敗：${error.message || error}`);
  }
}


