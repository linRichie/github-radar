# GitHub 雷达

追踪 **GitHub 热门排行动态、高增长项目、有趣的新锐项目**，以及 **AI Skills 与 MCP 工具链** 的生态更新，自动生成公网页面并邮件推送。

- 公网页面：<https://radar.moniter.top>
- 数据来源：GitHub Trending 页面（热门 / 高增长排行）+ GitHub Search API（topic 检索 / 新锐项目）+ 重点仓库的 releases / commits

## 抓取什么

1. **GitHub 热榜**：解析 `github.com/trending`（日榜 / 周榜），含「今日 / 本周 star 增量」——这就是**最新排行动态**与**高增长排行榜**的最真实信号。
2. **高增长排行**：从热榜中按 star 增量降序取 Top 10，附中文简介，一眼看清本周 / 今日涨得最猛的项目。
3. **AI / Skills / MCP 生态热榜**：按 `mcp` / `agent-skills` / `claude-skills` / `ai-agents` / `llm` / `claude-code` 等 topic 检索近 1–7 天有更新的仓库（保留原能力，聚焦细分赛道）。
4. **新锐项目**：检索窗口内**新建**且已积累较高 star 的仓库——发现**有趣的新项目**。
5. **生态 watch 动态**：收敛为 5 个代表性仓库（anthropics/skills、modelcontextprotocol/servers、obra/superpowers 等），页面上降为次要信息，只列有更新的。

## 中文简介与上榜项目详解

- `data/zh-cache.json`：**跨天累积**的榜单项目中文简介缓存（key = `owner/repo`）。页面简介优先显示中文，英文原文以小字附在下面；原描述本身是中文时只显示一行。新上榜项目由 WorkBuddy 定时任务补译。
- `data/enriched-<mode>.json`：上榜项目结构化解读（`tagline` 一句话定位 / `value` 核心价值 / `features` 主要功能 / `scenarios` 应用场景 / `inputs` 输入建议 / `caveats` 使用提醒），仅 `date` 为当日时渲染。
- **双页结构**：`index.html` 首页（榜单速览 + 详解入口）、`cards.html` 上榜项目详解（10 张卡片）。顶部导航互相跳转。

## 运行

```bash
export GITHUB_TOKEN=$(gh auth token)   # 可选，提升速率上限（趋势页无需 token）
node radar.mjs --mode daily             # 日报（近 2 天，日榜）
node radar.mjs --mode weekly            # 周报（近 7 天，周榜）
```

产物：

- `data/<mode>-<日期>.json` / `data/<mode>-latest.json`：原始数据
- `index.html`：首页仪表盘（单文件、全内联、无外部资源）
- `cards.html`：上榜项目详解页（同上，独立页面）

## 自动化

- GitHub Actions：`radar-daily`（每日 北京时间 08:00）、`radar-weekly`（每周一 08:00）自动抓取并提交。
- WorkBuddy 定时任务：每日 / 每周 `git pull` 同步 CI 产物 → **为当日榜单补写中文简介（zh-cache）与新上榜项目的结构化解读（enriched）** → 重渲染 `index.html` + `cards.html` 并推送 → `scripts/shoot.mjs` 渲染**长文图（PNG）** → 邮件推送「文字摘要 + 长图附件 + 两个真实链接」到 `wlh_richard@163.com`（**不附 HTML 文件**）。
- 撰稿：老王 · `wlh.richard@gmail.com`（页脚与导航栏标注）。
- 自定义域名：`radar.moniter.top` → `linRichie.github.io`（CNAME，于阿里云解析添加主机记录 `radar`）。

## 维护

- 调整重点仓库 / 生态热榜主题：编辑 `radar.mjs` 顶部的 `WATCH` 与 `TOPICS`。
- 热榜周期：日榜（`daily`）/ 周榜（`weekly`）由 `--mode` 决定；趋势页解析逻辑见 `parseTrending()`。
- 页面结构：`renderIndex()` 首页 / `renderCards()` 详解页，共用 `pageShell()` 与 `CSS` 常量；简介渲染见 `descHtml()`。
- 长文图渲染：`node scripts/shoot.mjs [输入.html|URL] [输出.png]`（全局 puppeteer，离屏渲染整页 PNG，供邮件内嵌）。
