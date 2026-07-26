-- Vault 檔案表：以完整路徑為主鍵，「目錄」用 path 以 / 結尾的 marker 列表示
CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  content      BLOB NOT NULL,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  etag         TEXT NOT NULL,
  modified     TEXT NOT NULL
);
