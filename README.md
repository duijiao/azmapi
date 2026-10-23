# 爱赞美歌谱 API（Cloudflare Workers）

将歌谱搜索接口和歌谱详情页中的图片直链整合成一个 Worker API。GitHub 用于保存源码，Cloudflare Workers 负责运行。

## API 调用

部署后把 `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev` 替换成你的 Worker 地址。

- 服务状态：`/health`
- 搜索歌谱并抓取图片：`/?q=奇妙作为&page=1`
- 仅搜索（更快）：`/?q=奇妙作为&page=1&include_images=0`
- 获取单个歌谱图片：`/?id=49795`

## GitHub + Cloudflare 部署（无需本地安装工具）

1. 在 GitHub 创建一个新仓库，例如 `zanmei-sheet-api`。
2. 上传 `worker.js` 和 `wrangler.toml`。
3. 登录 Cloudflare Dashboard，打开 **Workers & Pages**。
4. 选择 **Create** → **Worker**，创建 Worker，例如 `zanmei-sheet-api`。
5. 打开 Worker 的代码编辑器，把 `worker.js` 全部内容复制进去，然后保存并部署。
6. 打开 `https://<你的-worker>.<你的子域>.workers.dev/health` 测试；应返回 `success: true`。
7. 用上方 API 示例测试搜索和歌谱图片链接。

## 使用 GitHub 集成部署（可选）

也可以在 Cloudflare 的 Worker 项目设置中配置 Git 集成（若你的账户界面提供该选项），连接 GitHub 仓库并设置部署。不同账户/控制台界面可能略有变化。

## 注意事项

- 本 Worker 是 JavaScript 版本，不能把原 PHP 文件直接放进 Worker 执行。
- `worker.js` 不需要 npm 依赖。
- 当前已知上游搜索接口为 `https://api.xiaohai.org/search/sheet?f=json&page_no=...&q=...`，歌谱详情页形式为 `https://www.zanmei.ai/tab/<id>.html`。
- 上游接口/网页结构可能变化，需实际部署后验证。
- 图片是上游站点的原始直链，不会被 Worker 下载存储。
- 搜索默认抓取每条结果的详情页以提取图片，速度会慢一些；可以用 `include_images=0` 先搜索，再对选中的 `id` 单独请求 `/?id=<id>`。
- 请遵守上游网站条款、访问频率限制与版权要求。该 API 不提供完整歌词/和弦数据库。


## 新增：通过圣经经文查询诗歌及歌谱

新增功能保留原有搜索、歌谱详情和 `/health` 接口，不会替换原有逻辑。

- 中文经文：`/scripture?reference=约翰福音3:16&page=1`
- 经文标识：`/scripture?ref=gen-c1-v1&page=1`
- 经文范围：`/scripture?reference=创世记1:1-31&page=1`
- 仅查询经文关联歌曲（速度更快）：`/scripture?reference=创世记1:1&include_scores=0`
- 查询歌曲对应歌谱和图片：默认 `include_scores=1`

实现流程：
1. 读取 `https://www.izanmei.icu/song/bible/{经文标识}_{页码}.html`
2. 提取关联歌曲及歌曲 ID。
3. 读取每首歌的 `/song/{歌曲ID}/tab.html`，提取歌谱 ID。
4. 读取 `/tab/{歌谱ID}.html`，尝试提取歌谱图片直链。
5. 以 JSON 返回结果。

说明：
- 新功能的上游站点使用 `izanmei.icu`；原有搜索接口仍使用 `api.xiaohai.org`，原有详情接口仍保持原设置。
- 经文查询默认对当前页最多 20 首歌曲逐一请求歌谱详情，响应可能较慢。可先用 `include_scores=0` 查询歌曲列表，再单独查询歌谱。
- 图片解析依赖网页 HTML 结构，当前 Worker 会尽力提取图片 URL，但不保证每个歌谱页面都能解析成功；部署后请用实际响应验证。
- 经文中文名称映射涵盖常见圣经书卷别名。若不识别，请直接传网站使用的经文标识，例如 `gen-c1-v1`、`jhn-c3-v16`。
- 请遵守上游网站条款、访问频率限制和歌谱版权要求。
