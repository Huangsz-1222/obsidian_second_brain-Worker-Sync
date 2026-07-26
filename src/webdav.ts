import type { Env } from "./index";
import {
  copyOne,
  copyUnder,
  deleteOne,
  deleteUnder,
  getFile,
  headFile,
  listUnder,
  MAX_FILE_SIZE,
  putFile,
  type FileRow,
} from "./store";
import {
  encodePathHref,
  lockDiscovery,
  multistatus,
  type DavEntry,
} from "./xml";

const XML_HEADERS: Record<string, string> = {
  "Content-Type": "application/xml; charset=utf-8",
  DAV: "1, 2",
};

const ALLOWED_METHODS =
  "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK, PROPPATCH";

const DIRECTORY_CONTENT_TYPE = "httpd/unix-directory";

interface ResolvedPath {
  /** 解碼並正規化後的 URL 路徑（/ 開頭，無尾端斜線；根目錄為 /） */
  rawPath: string;
  /** URL 原本是否以 / 結尾（代表客戶端將其視為 collection） */
  isCollectionPath: boolean;
  /** vault 路徑前綴（無前後斜線，可能為空字串） */
  prefix: string;
  /** 對應 files 表的 path（無開頭斜線；根目錄 = prefix 本身） */
  key: string;
  /** 是否為根目錄 */
  isRoot: boolean;
}

export async function handleWebDav(request: Request, env: Env): Promise<Response> {
  const resolved = resolveRequestPath(new URL(request.url).pathname, env);
  if (resolved instanceof Response) return resolved;

  switch (request.method) {
    case "OPTIONS":
      return new Response(null, {
        status: 200,
        headers: { DAV: "1, 2", Allow: ALLOWED_METHODS, "MS-Author-Via": "DAV" },
      });
    case "PROPFIND":
      return propfind(request, env, resolved);
    case "GET":
      return getObject(env, resolved, false);
    case "HEAD":
      return getObject(env, resolved, true);
    case "PUT":
      return putObject(request, env, resolved);
    case "DELETE":
      return deleteResource(env, resolved);
    case "MKCOL":
      return mkcol(request, env, resolved);
    case "COPY":
      return copyOrMove(request, env, resolved, false);
    case "MOVE":
      return copyOrMove(request, env, resolved, true);
    case "LOCK": {
      const token = `opaquelocktoken:${crypto.randomUUID()}`;
      return new Response(lockDiscovery(resolved.rawPath, token), {
        status: 200,
        headers: { ...XML_HEADERS, "Lock-Token": `<${token}>` },
      });
    }
    case "UNLOCK":
      return new Response(null, { status: 204 });
    case "PROPPATCH":
      return new Response("403 Forbidden", { status: 403 });
    default:
      return new Response("405 Method Not Allowed", {
        status: 405,
        headers: { Allow: ALLOWED_METHODS },
      });
  }
}

function resolveRequestPath(pathname: string, env: Env): ResolvedPath | Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("400 Bad Request", { status: 400 });
  }
  const parts = decoded.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.includes("..")) {
    return new Response("400 Bad Request", { status: 400 });
  }
  const rawPath = "/" + parts.join("/");
  const prefix = (env.VAULT_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  const isRoot = rawPath === "/";
  const key = isRoot ? prefix : (prefix ? `${prefix}/` : "") + rawPath.slice(1);
  return {
    rawPath,
    isCollectionPath: decoded.endsWith("/") && !isRoot,
    prefix,
    key,
    isRoot,
  };
}

function keyToPath(prefix: string, key: string): string {
  const stripped = prefix ? key.slice(prefix.length + 1) : key;
  return "/" + stripped;
}

function fileEntry(path: string, row: FileRow): DavEntry {
  return {
    href: encodePathHref(path),
    displayName: path.split("/").pop() ?? path,
    isCollection: false,
    size: row.size,
    etag: `"${row.etag}"`,
    lastModified: new Date(row.modified),
  };
}

function collectionEntry(pathWithSlash: string): DavEntry {
  const segments = pathWithSlash.split("/").filter((s) => s.length > 0);
  return {
    href: encodePathHref(pathWithSlash),
    displayName: segments.length > 0 ? segments[segments.length - 1] : "/",
    isCollection: true,
  };
}

function collectionListPrefix(resolved: ResolvedPath): string {
  return resolved.key === "" ? "" : resolved.key + "/";
}

async function propfind(
  request: Request,
  env: Env,
  resolved: ResolvedPath,
): Promise<Response> {
  const depth = request.headers.get("Depth") ?? "1";
  if (depth === "infinity") {
    return new Response("403 Forbidden: Depth infinity is not supported", { status: 403 });
  }

  const db = env.VAULT_DB;
  const head = resolved.isRoot ? null : await headFile(db, resolved.key);
  const entries: DavEntry[] = [];

  if (head && !resolved.isCollectionPath) {
    entries.push(fileEntry(resolved.rawPath, head));
  } else {
    const listPrefix = collectionListPrefix(resolved);
    const rows = await listUnder(db, listPrefix);
    if (!resolved.isRoot && rows.length === 0) {
      return new Response("404 Not Found", { status: 404 });
    }

    const selfPath = resolved.isRoot ? "/" : resolved.rawPath + "/";
    entries.push(collectionEntry(selfPath));

    if (depth === "1") {
      // rows 包含所有後代；依第一層路徑段分組出直接子項
      const subDirs = new Set<string>();
      for (const row of rows) {
        const rest = row.path.slice(listPrefix.length);
        if (rest === "") continue; // 目前目錄的 marker 列
        const slashIndex = rest.indexOf("/");
        if (slashIndex === -1) {
          entries.push(fileEntry(keyToPath(resolved.prefix, row.path), row));
        } else {
          subDirs.add(rest.slice(0, slashIndex));
        }
      }
      for (const dir of subDirs) {
        const dirKey = listPrefix + dir;
        entries.push(collectionEntry(keyToPath(resolved.prefix, dirKey) + "/"));
      }
    }
  }

  return new Response(multistatus(entries), { status: 207, headers: XML_HEADERS });
}

function objectHeaders(row: FileRow): Headers {
  const headers = new Headers();
  headers.set("Content-Type", row.content_type || "application/octet-stream");
  headers.set("Content-Length", String(row.size));
  headers.set("ETag", `"${row.etag}"`);
  headers.set("Last-Modified", new Date(row.modified).toUTCString());
  return headers;
}

async function getObject(
  env: Env,
  resolved: ResolvedPath,
  headOnly: boolean,
): Promise<Response> {
  if (resolved.isRoot || resolved.isCollectionPath) {
    return new Response("404 Not Found", { status: 404 });
  }
  if (headOnly) {
    const head = await headFile(env.VAULT_DB, resolved.key);
    if (!head) return new Response("404 Not Found", { status: 404 });
    return new Response(null, { status: 200, headers: objectHeaders(head) });
  }
  const file = await getFile(env.VAULT_DB, resolved.key);
  if (!file) return new Response("404 Not Found", { status: 404 });
  return new Response(file.content, { status: 200, headers: objectHeaders(file.meta) });
}

async function putObject(
  request: Request,
  env: Env,
  resolved: ResolvedPath,
): Promise<Response> {
  if (resolved.isRoot || resolved.isCollectionPath) {
    return new Response("405 Method Not Allowed", { status: 405 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_FILE_SIZE) {
    return new Response(
      `413 Payload Too Large: D1 單檔上限約 ${Math.floor(MAX_FILE_SIZE / 1_000_000)} MB，請在 remotely-save 設定略過大檔`,
      { status: 413 },
    );
  }
  const existed = (await headFile(env.VAULT_DB, resolved.key)) !== null;
  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
  await putFile(env.VAULT_DB, resolved.key, body, contentType);
  return new Response(null, { status: existed ? 204 : 201 });
}

async function deleteResource(env: Env, resolved: ResolvedPath): Promise<Response> {
  if (resolved.isRoot) {
    return new Response("403 Forbidden", { status: 403 });
  }
  const db = env.VAULT_DB;
  if (await deleteOne(db, resolved.key)) {
    return new Response(null, { status: 204 });
  }
  // 視為 collection：刪除前綴下所有列（含目錄 marker）
  const removed = await deleteUnder(db, resolved.key + "/");
  return new Response(null, { status: removed > 0 ? 204 : 404 });
}

async function mkcol(request: Request, env: Env, resolved: ResolvedPath): Promise<Response> {
  if (resolved.isRoot) {
    return new Response("405 Method Not Allowed", { status: 405 });
  }
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > 0) {
    return new Response("415 Unsupported Media Type", { status: 415 });
  }
  // D1 是扁平 key 儲存：用以 / 結尾的空列代表目錄
  await putFile(env.VAULT_DB, resolved.key + "/", new ArrayBuffer(0), DIRECTORY_CONTENT_TYPE);
  return new Response(null, { status: 201 });
}

async function copyOrMove(
  request: Request,
  env: Env,
  resolved: ResolvedPath,
  isMove: boolean,
): Promise<Response> {
  const destination = request.headers.get("Destination");
  if (!destination) return new Response("400 Bad Request", { status: 400 });

  let destPathname: string;
  try {
    destPathname = new URL(destination).pathname;
  } catch {
    return new Response("400 Bad Request", { status: 400 });
  }
  const destResolved = resolveRequestPath(destPathname, env);
  if (destResolved instanceof Response) return destResolved;
  if (destResolved.isRoot) return new Response("403 Forbidden", { status: 403 });
  if (
    destResolved.key === resolved.key ||
    destResolved.key.startsWith(resolved.key + "/")
  ) {
    return new Response("403 Forbidden: cannot copy into itself", { status: 403 });
  }

  const overwrite = (request.headers.get("Overwrite") ?? "T").toUpperCase() !== "F";
  const db = env.VAULT_DB;

  const sourceIsFile = (await headFile(db, resolved.key)) !== null;
  if (!sourceIsFile) {
    const sourceRows = await listUnder(db, resolved.key + "/");
    if (sourceRows.length === 0) {
      return new Response("404 Not Found", { status: 404 });
    }
  }

  const destHead = await headFile(db, destResolved.key);
  const destExisted =
    destHead !== null || (await listUnder(db, destResolved.key + "/")).length > 0;
  if (!overwrite && destExisted) {
    return new Response("412 Precondition Failed", { status: 412 });
  }

  if (sourceIsFile) {
    await copyOne(db, resolved.key, destResolved.key);
    if (isMove) await deleteOne(db, resolved.key);
  } else {
    await copyUnder(db, resolved.key + "/", destResolved.key + "/");
    if (isMove) await deleteUnder(db, resolved.key + "/");
  }

  return new Response(null, { status: destExisted ? 204 : 201 });
}
