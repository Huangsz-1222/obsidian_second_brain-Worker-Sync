import type { Env } from "./index";
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

interface ResolvedPath {
  /** 解碼並正規化後的 URL 路徑（/ 開頭，無尾端斜線；根目錄為 /） */
  rawPath: string;
  /** URL 原本是否以 / 結尾（代表客戶端將其視為 collection） */
  isCollectionPath: boolean;
  /** bucket 內的前綴（無前後斜線，可能為空字串） */
  prefix: string;
  /** 對應的 R2 object key（無開頭斜線；根目錄 = prefix 本身） */
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

function fileEntry(path: string, object: R2Object): DavEntry {
  return {
    href: encodePathHref(path),
    displayName: path.split("/").pop() ?? path,
    isCollection: false,
    size: object.size,
    etag: object.httpEtag,
    lastModified: object.uploaded,
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

  const bucket = env.VAULT_BUCKET;
  const head = resolved.isRoot ? null : await bucket.head(resolved.key);
  const entries: DavEntry[] = [];

  if (head && !resolved.isCollectionPath) {
    entries.push(fileEntry(resolved.rawPath, head));
  } else {
    let exists = resolved.isRoot;
    const listPrefix = collectionListPrefix(resolved);
    if (!exists) {
      const probe = await bucket.list({ prefix: listPrefix, limit: 1 });
      exists = probe.objects.length > 0 || probe.delimitedPrefixes.length > 0;
    }
    if (!exists) {
      return new Response("404 Not Found", { status: 404 });
    }

    const selfPath = resolved.isRoot ? "/" : resolved.rawPath + "/";
    entries.push(collectionEntry(selfPath));

    if (depth === "1") {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({
          prefix: listPrefix,
          delimiter: "/",
          cursor,
          limit: 1000,
        });
        for (const object of page.objects) {
          if (object.key === listPrefix) continue; // 目錄 marker 物件
          entries.push(fileEntry(keyToPath(resolved.prefix, object.key), object));
        }
        for (const dir of page.delimitedPrefixes) {
          entries.push(collectionEntry(keyToPath(resolved.prefix, dir)));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  }

  return new Response(multistatus(entries), { status: 207, headers: XML_HEADERS });
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  headers.set(
    "Content-Type",
    object.httpMetadata?.contentType ?? "application/octet-stream",
  );
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
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
    const head = await env.VAULT_BUCKET.head(resolved.key);
    if (!head) return new Response("404 Not Found", { status: 404 });
    return new Response(null, { status: 200, headers: objectHeaders(head) });
  }
  const object = await env.VAULT_BUCKET.get(resolved.key);
  if (!object) return new Response("404 Not Found", { status: 404 });
  return new Response(object.body, { status: 200, headers: objectHeaders(object) });
}

async function putObject(
  request: Request,
  env: Env,
  resolved: ResolvedPath,
): Promise<Response> {
  if (resolved.isRoot || resolved.isCollectionPath) {
    return new Response("405 Method Not Allowed", { status: 405 });
  }
  const existed = (await env.VAULT_BUCKET.head(resolved.key)) !== null;
  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
  await env.VAULT_BUCKET.put(resolved.key, request.body ?? "", {
    httpMetadata: { contentType },
  });
  return new Response(null, { status: existed ? 204 : 201 });
}

async function deleteResource(env: Env, resolved: ResolvedPath): Promise<Response> {
  if (resolved.isRoot) {
    return new Response("403 Forbidden", { status: 403 });
  }
  const bucket = env.VAULT_BUCKET;
  const head = await bucket.head(resolved.key);
  if (head) {
    await bucket.delete(resolved.key);
    return new Response(null, { status: 204 });
  }

  // 視為 collection：刪除前綴下所有物件（含目錄 marker）
  const listPrefix = resolved.key + "/";
  let found = false;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: listPrefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) {
      found = true;
      await bucket.delete(keys);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return new Response(null, { status: found ? 204 : 404 });
}

async function mkcol(request: Request, env: Env, resolved: ResolvedPath): Promise<Response> {
  if (resolved.isRoot) {
    return new Response("405 Method Not Allowed", { status: 405 });
  }
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > 0) {
    return new Response("415 Unsupported Media Type", { status: 415 });
  }
  // R2 是扁平儲存：用零位元組的 marker 物件代表空目錄
  await env.VAULT_BUCKET.put(resolved.key + "/", "");
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
  const bucket = env.VAULT_BUCKET;

  // 收集來源：單一檔案，或 collection 前綴下的所有物件
  const sourceKeys: string[] = [];
  const sourceHead = await bucket.head(resolved.key);
  if (sourceHead) {
    sourceKeys.push(resolved.key);
  } else {
    const listPrefix = resolved.key + "/";
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: listPrefix, cursor, limit: 1000 });
      sourceKeys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  if (sourceKeys.length === 0) {
    return new Response("404 Not Found", { status: 404 });
  }

  const destExisted = (await bucket.head(destResolved.key)) !== null;
  if (!overwrite && destExisted) {
    return new Response("412 Precondition Failed", { status: 412 });
  }

  for (const sourceKey of sourceKeys) {
    const suffix = sourceKey.slice(resolved.key.length);
    const object = await bucket.get(sourceKey);
    if (!object) continue;
    await bucket.put(destResolved.key + suffix, object.body, {
      httpMetadata: object.httpMetadata,
    });
  }

  if (isMove) {
    for (let i = 0; i < sourceKeys.length; i += 1000) {
      await bucket.delete(sourceKeys.slice(i, i + 1000));
    }
  }

  return new Response(null, { status: destExisted ? 204 : 201 });
}
