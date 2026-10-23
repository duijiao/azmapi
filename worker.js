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


const IZANMEI_BASE = "https://www.izanmei.icu";

function htmlText(value) {
  return decodeHtml(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attrValue(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = attrs.match(new RegExp("\\b" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return m ? (m[1] || m[2] || m[3] || "") : "";
}

function parseAnchors(html, baseUrl) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = m[1];
    const rawHref = attrValue(attrs, "href");
    const href = absoluteUrl(rawHref, baseUrl);
    if (!href) continue;
    out.push({ href, text: htmlText(m[2]), attrs, raw: m[0] });
  }
  return out;
}

function normalizeScriptureReference(input) {
  const raw = String(input || "").trim();
  // Accept a website reference slug directly, e.g. gen-c1-v1 or gen-c1-v1-v31.
  if (/^[a-z]{3}-c\d+-v\d+(?:-v\d+)?$/i.test(raw)) return raw.toLowerCase();

  const match = raw.match(/^(.+?)\s*(\d+)\s*[:：章]\s*(\d+)(?:\s*[-–—至到]\s*(\d+))?\s*(?:节)?$/);
  if (!match) return null;
  const bookRaw = match[1].replace(/\s+/g, "").replace(/卷$/, "");
  const bookMap = {
    "创世记":"gen","创":"gen","出埃及记":"exo","出":"exo","利未记":"lev","利":"lev","民数记":"num","民":"num","申命记":"deu","申":"deu",
    "约书亚记":"jos","书":"jos","士师记":"jdg","士":"jdg","路得记":"rut","得":"rut","撒母耳记上":"1sa","撒上":"1sa","撒母耳记下":"2sa","撒下":"2sa",
    "列王纪上":"1ki","王上":"1ki","列王纪下":"2ki","王下":"2ki","历代志上":"1ch","代上":"1ch","历代志下":"2ch","代下":"2ch",
    "以斯拉记":"ezr","拉":"ezr","尼希米记":"neh","尼":"neh","以斯帖记":"est","斯":"est","约伯记":"job","伯":"job","诗篇":"psa","诗":"psa",
    "箴言":"pro","箴":"pro","传道书":"ecc","传":"ecc","雅歌":"sng","赛":"isa","以赛亚书":"isa","耶利米书":"jer","耶":"jer","耶利米哀歌":"lam","哀":"lam",
    "以西结书":"ezk","结":"ezk","但以理书":"dan","但":"dan","何西阿书":"hos","珥":"joe","约珥书":"joe","阿摩司书":"amo","摩":"amo",
    "俄巴底亚书":"oba","俄":"oba","约拿书":"jon","拿":"jon","弥迦书":"mic","弥":"mic","那鸿书":"nam","鸿":"nam","哈巴谷书":"hab","哈":"hab",
    "西番雅书":"zep","番":"zep","哈该书":"hag","该":"hag","撒迦利亚书":"zec","亚":"zec","玛拉基书":"mal","玛":"mal",
    "马太福音":"mat","太":"mat","马可福音":"mrk","可":"mrk","路加福音":"luk","路":"luk","约翰福音":"jhn","约":"jhn",
    "使徒行传":"act","徒":"act","罗马书":"rom","罗":"rom","哥林多前书":"1co","林前":"1co","哥林多后书":"2co","林后":"2co",
    "加拉太书":"gal","加":"gal","以弗所书":"eph","弗":"eph","腓立比书":"php","腓":"php","歌罗西书":"col","西":"col",
    "帖撒罗尼迦前书":"1th","帖前":"1th","帖撒罗尼迦后书":"2th","帖后":"2th","提摩太前书":"1ti","提前":"1ti","提摩太后书":"2ti","提后":"2ti",
    "提多书":"tit","多":"tit","腓利门书":"phm","门":"phm","希伯来书":"heb","来":"heb","雅各书":"jas","雅":"jas",
    "彼得前书":"1pe","彼前":"1pe","彼得后书":"2pe","彼后":"2pe","约翰一书":"1jn","约一":"1jn","约翰二书":"2jn","约二":"2jn","约翰三书":"3jn","约三":"3jn",
    "犹大书":"jud","犹":"jud","启示录":"rev","启":"rev"
  };
  const book = bookMap[bookRaw];
  if (!book) return null;
  const chapter = Number(match[2]), verseStart = Number(match[3]), verseEnd = match[4] ? Number(match[4]) : null;
  if (!chapter || !verseStart || (verseEnd && verseEnd < verseStart)) return null;
  return `${book}-c${chapter}-v${verseStart}${verseEnd ? `-v${verseEnd}` : ""}`;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ZanmeiSheetAPI/1.0)",
      "Accept": "text/html,application/xhtml+xml",
      "Referer": IZANMEI_BASE + "/"
    },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`上游页面请求失败：HTTP ${response.status} (${url})`);
  return { html: await response.text(), url: response.url || url };
}

async function fetchScriptureSongs(referenceSlug, page) {
  const url = `${IZANMEI_BASE}/song/bible/${encodeURIComponent(referenceSlug)}_${page}.html`;
  const { html, url: finalUrl } = await fetchHtml(url);
  const anchors = parseAnchors(html, finalUrl);
  const songs = [];
  const seen = new Set();
  for (const a of anchors) {
    const m = new URL(a.href).pathname.match(/\/song\/(\d+)(?:\/[^/]*)?\.html$/i);
    if (!m || !a.text) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    songs.push({ song_id: id, title: a.text, song_url: `${IZANMEI_BASE}/song/${id}.html` });
  }
  const titleMatch = html.match(/与\s*['"’]?([^'”’]+)['"’]?\s*相关的歌曲/);
  const verseMatch = html.match(/<div[^>]*>\s*([^<]{3,300})\s*<\/div>/i);
  return {
    url: finalUrl,
    title: titleMatch ? htmlText(titleMatch[1]) : null,
    verse_text: verseMatch ? htmlText(verseMatch[1]) : null,
    songs
  };
}

async function fetchSongScores(songId, includeImages = true) {
  const songUrl = `${IZANMEI_BASE}/song/${encodeURIComponent(songId)}/tab.html`;
  const { html, url: finalUrl } = await fetchHtml(songUrl);
  const anchors = parseAnchors(html, finalUrl);
  const scores = [];
  const seen = new Set();
  for (const a of anchors) {
    const m = new URL(a.href).pathname.match(/\/tab\/(\d+)\.html$/i);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const scoreId = m[1];
    const rowStart = Math.max(0, html.lastIndexOf("<", html.indexOf(a.raw)));
    const around = html.slice(Math.max(0, rowStart - 600), Math.min(html.length, html.indexOf(a.raw) + 1800));
    const bookMatch = around.match(/(?:歌本|书名)\s*[:：]\s*<\/?[^>]*>*\s*(?:<[^>]+>\s*)*([^<]{1,100})/i);
    const keyMatch = around.match(/(?:选项\s*[:：][\s\S]{0,300}?|调号\s*[:：]\s*)(?:<[^>]+>\s*)*([A-G](?:#|b)?)(?:\s*<\/a>)?/i);
    const timeMatch = around.match(/(\d+\s*\/\s*\d+)/);
    const score = {
      score_id: scoreId,
      title: a.text || null,
      score_url: `${IZANMEI_BASE}/tab/${scoreId}.html`,
      songbook: bookMatch ? htmlText(bookMatch[1]) : null,
      key: keyMatch ? keyMatch[1] : null,
      time_signature: timeMatch ? timeMatch[1].replace(/\s/g, "") : null,
      images: []
    };
    if (includeImages) {
      try {
        const detail = await fetchHtml(score.score_url);
        score.score_url = detail.url;
        score.images = parseImages(detail.html, detail.url);
      } catch (e) {
        score.image_error = String(e?.message || e);
      }
    }
    scores.push(score);
  }
  return { song_url: finalUrl, scores };
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
      const referenceInput = requestUrl.searchParams.get("ref") ||
        requestUrl.searchParams.get("reference") || requestUrl.searchParams.get("scripture") || "";
      if (referenceInput || path === "/scripture") {
        const refSlug = normalizeScriptureReference(referenceInput);
        if (!refSlug) {
          return json({
            success: false,
            error: "无法识别经文格式。请使用 ?ref=gen-c1-v1 或 ?reference=创世记1:1",
            examples: [
              "/scripture?reference=创世记1:1",
              "/scripture?reference=约翰福音3:16",
              "/scripture?reference=创世记1:1-31&page=1",
              "/scripture?ref=gen-c1-v1&page=1&include_scores=1"
            ]
          }, 400);
        }
        const includeScores = !["0", "false", "no"].includes(
          (requestUrl.searchParams.get("include_scores") || "1").toLowerCase()
        );
        const songResult = await fetchScriptureSongs(refSlug, page);
        const songs = [];
        // Limit the number of per-song follow-up requests to keep one call bounded.
        for (const song of songResult.songs.slice(0, 20)) {
          const item = { ...song, scores: [], score_count: null };
          if (includeScores) {
            try {
              const result = await fetchSongScores(song.song_id, true);
              item.song_url = result.song_url;
              item.scores = result.scores;
              item.score_count = result.scores.length;
            } catch (e) {
              item.score_error = String(e?.message || e);
            }
          }
          songs.push(item);
        }
        return json({
          success: true,
          action: "scripture_songs",
          reference: referenceInput,
          reference_id: refSlug,
          page,
          count: songs.length,
          total_on_page: songResult.songs.length,
          songs,
          source: {
            scripture_page: songResult.url,
            site: IZANMEI_BASE
          },
          note: includeScores
            ? "已尝试逐首获取相关歌谱及图片直链；部分歌曲可能没有歌谱，图片也可能受上游页面结构或访问限制影响。"
            : "已获取经文关联歌曲；使用 include_scores=1 可继续查询每首歌的歌谱及图片。"
        });
      }

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
            scripture: "/scripture?reference=约翰福音3:16&page=1",
            scriptureBySlug: "/scripture?ref=gen-c1-v1&page=1",
            scriptureWithoutScores: "/scripture?reference=创世记1:1&include_scores=0",
            health: "/health",
          },
          note: "保留原有歌谱搜索/详情接口，并新增经文 -> 歌曲 -> 歌谱/图片查询。上游图片地址需以实际抓取结果为准。",
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
