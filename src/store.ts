/** D1 檔案列的中繼資料（content 以外） */
export interface FileRow {
  path: string;
  size: number;
  content_type: string;
  etag: string;
  /** ISO 8601 時間字串 */
  modified: string;
}

/**
 * D1 單列 BLOB 上限為 2 MB，保留安全邊界。
 * 超過此大小的檔案會收到 413，建議在 remotely-save 設定略過大檔。
 */
export const MAX_FILE_SIZE = 1_900_000;

/** 前綴範圍查詢的上界（Unicode 最大碼位，任何有效路徑都比它小） */
const UPPER_BOUND = "\u{10FFFF}";

function rangeUpper(prefix: string): string {
  return prefix + UPPER_BOUND;
}

export async function headFile(db: D1Database, key: string): Promise<FileRow | null> {
  return db
    .prepare("SELECT path, size, content_type, etag, modified FROM files WHERE path = ?1")
    .bind(key)
    .first<FileRow>();
}

export interface FileWithContent {
  meta: FileRow;
  content: ArrayBuffer;
}

export async function getFile(
  db: D1Database,
  key: string,
): Promise<FileWithContent | null> {
  const row = await db
    .prepare(
      "SELECT path, content, size, content_type, etag, modified FROM files WHERE path = ?1",
    )
    .bind(key)
    .first<FileRow & { content: unknown }>();
  if (!row) return null;
  const { content, ...meta } = row;
  return { meta, content: normalizeBlob(content) };
}

/**
 * 正規化 D1 BLOB 回傳值：正式環境為 ArrayBuffer，
 * 但本地 miniflare 會回傳 number[]，REST API 則可能是 base64 字串。
 */
function normalizeBlob(content: unknown): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
  }
  if (Array.isArray(content)) {
    return new Uint8Array(content as number[]).buffer;
  }
  if (typeof content === "string") {
    const binary = atob(content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  return new ArrayBuffer(0);
}

/** 寫入檔案（或目錄 marker），回傳新產生的 etag */
export async function putFile(
  db: D1Database,
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<string> {
  const etag = await sha256Hex(content);
  await db
    .prepare(
      "INSERT OR REPLACE INTO files (path, content, size, content_type, etag, modified) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(key, content, content.byteLength, contentType, etag, new Date().toISOString())
    .run();
  return etag;
}

/** 列出前綴下所有列（含子目錄內容），依路徑排序 */
export async function listUnder(db: D1Database, prefix: string): Promise<FileRow[]> {
  const result = await db
    .prepare(
      "SELECT path, size, content_type, etag, modified FROM files WHERE path >= ?1 AND path < ?2 ORDER BY path",
    )
    .bind(prefix, rangeUpper(prefix))
    .all<FileRow>();
  return result.results ?? [];
}

/** 刪除單一 key，回傳是否有刪到 */
export async function deleteOne(db: D1Database, key: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM files WHERE path = ?1").bind(key).run();
  return (result.meta.changes ?? 0) > 0;
}

/** 刪除前綴下所有列，回傳刪除筆數 */
export async function deleteUnder(db: D1Database, prefix: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM files WHERE path >= ?1 AND path < ?2")
    .bind(prefix, rangeUpper(prefix))
    .run();
  return result.meta.changes ?? 0;
}

/** 複製單一檔案（純 SQL，一次查詢完成） */
export async function copyOne(db: D1Database, src: string, dst: string): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO files (path, content, size, content_type, etag, modified)
       SELECT ?1, content, size, content_type, etag, modified FROM files WHERE path = ?2`,
    )
    .bind(dst, src)
    .run();
}

/** 複製整個前綴（目錄），以字串拼接取代路徑前綴，避免 replace() 誤改後段路徑 */
export async function copyUnder(
  db: D1Database,
  srcPrefix: string,
  dstPrefix: string,
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT OR REPLACE INTO files (path, content, size, content_type, etag, modified)
       SELECT ?1 || substr(path, length(?2) + 1), content, size, content_type, etag, modified
       FROM files WHERE path >= ?2 AND path < ?3`,
    )
    .bind(dstPrefix, srcPrefix, rangeUpper(srcPrefix))
    .run();
  return result.meta.changes ?? 0;
}

async function sha256Hex(content: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
