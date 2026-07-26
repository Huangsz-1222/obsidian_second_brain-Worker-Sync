const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "\"": "&quot;",
  "'": "&apos;",
};

/** XML 特殊字元跳脫（中文檔名與 & < > 等字元必須處理） */
export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => XML_ESCAPES[ch] ?? ch);
}

/** 將路徑逐段做 URL encode，保留 / 分隔符與尾端斜線 */
export function encodePathHref(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export interface DavEntry {
  /** 已 URL encode 的 href（collection 需以 / 結尾） */
  href: string;
  displayName: string;
  isCollection: boolean;
  size?: number;
  etag?: string;
  lastModified?: Date;
}

/** 組出 WebDAV 207 Multi-Status XML */
export function multistatus(entries: DavEntry[]): string {
  const items = entries.map((entry) => {
    const props: string[] = [
      `<D:displayname>${escapeXml(entry.displayName)}</D:displayname>`,
      `<D:resourcetype>${entry.isCollection ? "<D:collection/>" : ""}</D:resourcetype>`,
    ];
    if (!entry.isCollection) {
      props.push(`<D:getcontentlength>${entry.size ?? 0}</D:getcontentlength>`);
      if (entry.etag) {
        props.push(`<D:getetag>${escapeXml(entry.etag)}</D:getetag>`);
      }
    }
    if (entry.lastModified) {
      props.push(`<D:getlastmodified>${entry.lastModified.toUTCString()}</D:getlastmodified>`);
      props.push(`<D:creationdate>${entry.lastModified.toISOString()}</D:creationdate>`);
    }
    return [
      "<D:response>",
      `<D:href>${escapeXml(entry.href)}</D:href>`,
      "<D:propstat>",
      `<D:prop>${props.join("")}</D:prop>`,
      "<D:status>HTTP/1.1 200 OK</D:status>",
      "</D:propstat>",
      "</D:response>",
    ].join("");
  });

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<D:multistatus xmlns:D="DAV:">`,
    ...items,
    `</D:multistatus>`,
  ].join("");
}

/** LOCK 回應（無狀態假鎖，僅為相容需要鎖定的 WebDAV 客戶端） */
export function lockDiscovery(path: string, token: string): string {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<D:prop xmlns:D="DAV:">`,
    "<D:lockdiscovery>",
    "<D:activelock>",
    "<D:locktype><D:write/></D:locktype>",
    "<D:lockscope><D:exclusive/></D:lockscope>",
    "<D:depth>infinity</D:depth>",
    "<D:timeout>Second-3600</D:timeout>",
    `<D:locktoken><D:href>${escapeXml(token)}</D:href></D:locktoken>`,
    `<D:lockroot><D:href>${escapeXml(encodePathHref(path))}</D:href></D:lockroot>`,
    "</D:activelock>",
    "</D:lockdiscovery>",
    "</D:prop>",
  ].join("");
}
