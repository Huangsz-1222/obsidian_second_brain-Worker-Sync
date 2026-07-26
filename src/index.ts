import { handleWebDav } from "./webdav";

export interface Env {
  /** R2 bucket binding（wrangler.toml） */
  VAULT_BUCKET: R2Bucket;
  /** Basic Auth 帳號（wrangler secret put AUTH_USERNAME） */
  AUTH_USERNAME: string;
  /** Basic Auth 密碼（wrangler secret put AUTH_PASSWORD） */
  AUTH_PASSWORD: string;
  /** 選用：Vault 在 bucket 內的子路徑前綴 */
  VAULT_PREFIX?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":
    "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK, PROPPATCH",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Depth, Destination, Overwrite, Lock-Token, Timeout, If",
  "Access-Control-Expose-Headers": "ETag, Lock-Token, DAV",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight（瀏覽器預檢不帶憑證，需在驗證前處理）
    if (request.method === "OPTIONS" && request.headers.has("Origin")) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!(await isAuthorized(request, env))) {
      return new Response("401 Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Obsidian Second Brain Sync", charset="UTF-8"',
          ...CORS_HEADERS,
        },
      });
    }

    try {
      const response = await handleWebDav(request, env);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(CORS_HEADERS)) {
        headers.set(name, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.error("WebDAV handler error:", error);
      return new Response("500 Internal Server Error", {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
} satisfies ExportedHandler<Env>;

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;

  const [userHash, passHash, expectedUserHash, expectedPassHash] = await Promise.all([
    sha256Hex(decoded.slice(0, separator)),
    sha256Hex(decoded.slice(separator + 1)),
    sha256Hex(env.AUTH_USERNAME ?? ""),
    sha256Hex(env.AUTH_PASSWORD ?? ""),
  ]);

  // 以 SHA-256 雜湊做常數時間比對，避免 timing attack
  return (
    constantTimeEqual(userHash, expectedUserHash) &&
    constantTimeEqual(passHash, expectedPassHash)
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
