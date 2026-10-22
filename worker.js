/**
 * 爱赞美歌谱 API — Cloudflare Workers 版
 * Endpoints:
 *   GET /?q=奇妙作为&page=1
 *   GET /?q=奇妙作为&page=1&include_images=0
 *   GET /?id=49795
 *   GET /health
 *
 * No API key is required by this Worker itself. It proxies public upstream pages.
 * Please respect upstream terms, rate limits, and copyright.
 */
const SEARCH_BASE = "https://api.xiaohai.org/search/sheet";
const DETAIL_BASE = "https://www.zanmei.ai/tab/";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=60",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders(),
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function absoluteUrl(raw, base) {
  const value = decodeHtml(raw).trim();
  if (!value || value.startsWith("data:") || value.startsWith("javascript:")) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function getTabId(item) {
  const candidates = [item?.mTabId, item?.tab_id, item?.id, item?.mId];
  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      const id = String(value).trim();
      if (/^[a-zA-Z0-9_-]+$/.test(id)) return id;
    }
  }
  return null;
}

function parseImages(html, pageUrl) {
  // Restrict extraction to the .img_tab section when it exists.
  const marker = html.search(/class\s*=\s*["'][^"']*\bimg_tab\b/i);
  let region = marker >= 0 ? html.slice(marker) : html;
  if (marker >= 0) {
    // Bound the region to a reasonable size, avoiding unrelated page assets.
    region = region.slice(0, 250000);
    const nextSection = region.search(/<\/(?:div|section|article)\s*>/i);
    if (nextSection > 0) region = region.slice(0, nextSection + 6);
  }

  const found = [];
  const seen = new Set();
  const add = (raw, alt = "") => {
    const url = absoluteUrl(raw, pageUrl);
    if (!url || seen.has(url)) return;
    // Only return plausible image files or image CDN paths.
    if (!/\.(?:jpe?g|png|webp|gif|bmp)(?:[?#].*)?$/i.test(url) &&
        !/\/(?:image|img|photo|picture)\//i.test(new URL(url).pathname)) return;
    seen.add(url);
    found.push({ url, direct_url: url, alt: decodeHtml(alt) });
  };

  // Images within the sheet-image area.
  for (const match of region.matchAll(/<img\b([^>]*?)>/gi)) {
    const attrs = match[1];
    const src = attrs.match(/\b(?:src|data-src|data-original)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const alt = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (src) add(src[1] || src[2] || src[3], alt ? (alt[1] || alt[2] || alt[3]) : "");
  }
  for (const match of region.matchAll(/<a\b([^>]*?)>/gi)) {
    const attrs = match[1];
    const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (href) add(href[1] || href[2] || href[3], "");
  }
  return found;
}

async function fetchDetail(id) {
  const pageUrl = `${DETAIL_BASE}${encodeURIComponent(id)}.html`;
  const response = await fetch(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ZanmeiSheetAPI/1.0)",
      "Accept": "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    return { id, detail_url: pageUrl, images: [], error: `详情页请求失败：HTTP ${response.status}` };
  }
  const html = await response.text();
  return { id, detail_url: response.url || pageUrl, images: parseImages(html, response.url || pageUrl) };
}

async function searchSheets(q, page) {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set("f", "json");
  url.searchParams.set("page_no", String(page));
  url.searchParams.set("q", q);

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ZanmeiSheetAPI/1.0)",
      "Accept": "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) throw new Error(`搜索接口请求失败：HTTP ${response.status}`);

  const rawText = await response.text();
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error("上游搜索接口没有返回有效 JSON");
  }

  const rows = Array.isArray(payload?.mItems) ? payload.mItems
    : Array.isArray(payload?.data?.mItems) ? payload.data.mItems
    : Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload?.data) ? payload.data
    : [];

  return {
    upstream: payload,
    rows,
    url: url.toString(),
  };
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ success: false, error: "仅支持 GET 请求" }, 405);
    }

    const path = requestUrl.pathname;
    if (path === "/health") {
      return json({ success: true, service: "zanmei-sheet-api", runtime: "Cloudflare Workers" });
    }

    const id = requestUrl.searchParams.get("id") || "";
    const action = (requestUrl.searchParams.get("action") || "").toLowerCase();
    const q = (requestUrl.searchParams.get("q") || requestUrl.searchParams.get("wd") || "").trim();
    const page = Math.max(1, Math.min(1000, Number.parseInt(requestUrl.searchParams.get("page") || "1", 10) || 1));
    const includeImages = !["0", "false", "no"].includes(
      (requestUrl.searchParams.get("include_images") || "1").toLowerCase()
    );

    try {
      if (id || action === "detail") {
        const targetId = id.trim();
        if (!targetId || !/^[a-zA-Z0-9_-]+$/.test(targetId)) {
          return json({ success: false, error: "请提供有效的歌谱 id，例如 ?id=49795" }, 400);
        }
        const detail = await fetchDetail(targetId);
        return json({
          success: !detail.error,
          action: "detail",
          id: targetId,
          detail_url: detail.detail_url,
          count: detail.images.length,
          images: detail.images,
          ...(detail.error ? { error: detail.error } : {}),
          source: "zanmei.ai",
        }, detail.error ? 502 : 200);
      }

      if (!q) {
        return json({
          success: true,
          service: "zanmei-sheet-api",
          usage: {
            search: "/?q=奇妙作为&page=1",
            searchWithoutImages: "/?q=奇妙作为&page=1&include_images=0",
            detail: "/?id=49795",
            health: "/health",
          },
          note: "这是歌谱搜索和歌谱图片直链接口；不提供完整歌词/和弦数据库。",
        });
      }

      const result = await searchSheets(q, page);
      const items = [];
      for (const row of result.rows) {
        const tabId = getTabId(row);
        let imageData = { images: [] };
        if (includeImages && tabId) {
          try {
            imageData = await fetchDetail(tabId);
          } catch (error) {
            imageData = { images: [], error: String(error?.message || error) };
          }
        }
        items.push({
          ...row,
          id: tabId,
          detail_url: tabId ? `${DETAIL_BASE}${encodeURIComponent(tabId)}.html` : null,
          images: imageData.images || [],
          ...(imageData.error ? { image_error: imageData.error } : {}),
        });
      }

      const totalPages = result.upstream?.mTotalPage ?? result.upstream?.total_pages ??
        result.upstream?.totalPages ?? result.upstream?.page_count ?? null;

      return json({
        success: true,
        action: "search",
        query: q,
        page,
        total_pages: totalPages,
        count: items.length,
        items,
        source: {
          search_api: result.url,
          detail_base: DETAIL_BASE,
        },
        note: includeImages
          ? "每条结果会额外请求详情页提取歌谱图片，响应较慢；图片是上游直链。"
          : "已关闭逐条详情页抓取；items[].images 将为空数组。",
      });
    } catch (error) {
      return json({
        success: false,
        error: String(error?.message || error),
        hint: "请稍后重试，并确认上游 API 可访问。",
      }, 502);
    }
  },
};
