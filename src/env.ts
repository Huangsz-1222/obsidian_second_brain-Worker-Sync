export interface Env {
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  OBSIDIAN_SAVE_PATH: string;
  
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  JINA_API_KEY?: string;
  ADMIN_CHAT_ID?: string;
  BROWSER_SECRET?: string;
}
