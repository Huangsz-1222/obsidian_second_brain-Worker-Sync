import type { Env } from './env';
import { Buffer } from 'node:buffer';

export async function saveToGitHub(env: Env, filename: string, content: string): Promise<string> {
  const repo = env.GITHUB_REPO;
  const path = `${env.OBSIDIAN_SAVE_PATH}/${filename}`;
  const branch = env.GITHUB_BRANCH || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;

  // Check if file exists to get the SHA (required for updating, though we might only be creating)
  let sha: string | undefined = undefined;
  
  const getRes = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'Cloudflare-Worker'
    }
  });

  if (getRes.status === 200) {
    const data: any = await getRes.json();
    sha = data.sha;
  }

  const base64Content = Buffer.from(content, 'utf-8').toString('base64');

  const putRes = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'Cloudflare-Worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `Sync clipping: ${filename}`,
      content: base64Content,
      branch: branch,
      ...(sha ? { sha } : {})
    }),
  });

  if (!putRes.ok) {
    const errorText = await putRes.text();
    throw new Error(`GitHub API error: ${putRes.status} ${errorText}`);
  }

  return path;
}

