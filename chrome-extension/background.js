// 設定您的 Worker 網址
const WORKER_URL = "https://obsidian-clipping-worker.ogeypt.workers.dev/webhook/browser";
// 設定您的 Webhook 密碼 (預設與 TELEGRAM_WEBHOOK_SECRET 相同)
const WORKER_SECRET = "1234";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url) return;

  // Show "sending" notification
  chrome.notifications.create({
    type: "basic",
    iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyczQuNDggMTAgMTAgMTAgMTAtNC40OCAxMC0xMFMxNy41MiAy 12IDJ6IiBmaWxsPSIjNDI4NUY0Ii8+PC9zdmc+", // Simple default icon
    title: "Obsidian Clipper",
    message: "傳送至 Worker 中..."
  });

  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: tab.url,
        secret: WORKER_SECRET
      })
    });

    if (response.ok) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyczQuNDggMTAgMTAgMTAgMTAtNC40OCAxMC0xMFMxNy41MiAy 12IDJ6IiBmaWxsPSIjMEY5RDU4Ii8+PC9zdmc+", // Green icon
        title: "Obsidian Clipper",
        message: "✅ 已發送成功！正在後台處理中..."
      });
    } else {
      const errText = await response.text();
      throw new Error(`Error ${response.status}: ${errText}`);
    }
  } catch (error) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJDNi40OCAyIDIgNi40OCAyIDEyczQuNDggMTAgMTAgMTAgMTAtNC40OCAxMC0xMFMxNy41MiAy 12IDJ6IiBmaWxsPSIjREIzMjM2Ii8+PC9zdmc+", // Red icon
      title: "Obsidian Clipper Error",
      message: error.message
    });
  }
});
