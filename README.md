# GitHub 雷达

追踪 **GitHub 热门排行动态、高增长项目、有趣的新锐项目**，以及 **AI Skills 与 MCP 工具链** 的生态更新，自动生成公网页面并邮件推送。

- 公网页面：<https://radar.moniter.top>
- 数据来源：GitHub Trending 页面（热门 / 高增长排行）+ GitHub Search API（topic 检索 / 新锐项目）+ 重点仓库的 releases / commits

## 抓取什么

1. **GitHub 热榜**：解析 `github.com/trending`（日榜 / 周榜），含「今日 / 本周 star 增量」——这就是**最新排行动态**与**高增长排行榜**的最真实信号。
2. **高增长排行**：从热榜中按 star 增量降序取 Top 10，一眼看清本周 / 今日涨得最猛的项目。
3. **AI / Skills / MCP 生态热榜**：按 `mcp` / `agent-skills` / `claude-skills` / `ai-agents` / `llm` / `claude-code` 等 topic 检索近 1–7 天有更新的仓库（保留原能力，聚焦细分赛道）。
4. **新锐项目**：检索窗口内**新建**且已积累较高 star 的仓库——发现**有趣的新项目**。
5. **生态 watch 动态**：10 个重点仓库（anthropics/skills、modelcontextprotocol/servers、punkpeye/awesome-mcp-servers、ComposioHQ/awesome-claude-skills、VoltAgent/awesome-agent-skills、obra/superpowers 等）的新版本与近期提交。

## 运行

```bash
export GITHUB_TOKEN=$(gh auth token)   # 可选，提升速率上限（趋势页无需 token）
node radar.mjs --mode daily             # 日报（近 2 天，日榜）
node radar.mjs --mode weekly            # 周报（近 7 天，周榜）
```

产物：

- `data/<mode>-<日期>.json` / `data/<mode>-latest.json`：原始数据
- `index.html`：单文件仪表盘（全内联、无外部资源，GitHub Pages 直接托管）

## 自动化

- GitHub Actions：`radar-daily`（每日 北京时间 08:00`）、`radar-weekly`（每周一 08:00）自动抓取并提交。
- WorkBuddy 定时任务：每日 / 每周 `git pull` 同步 CI 产物 → `scripts/shoot.mjs` 渲染整页**长文图（PNG）** → 邮件推送「文字摘要 + 长图附件 + 真实链接」到 `wlh_richard@163.com`（**不再附 HTML 文件**）。
- 自定义域名：`radar.moniter.top` → `linRichie.github.io`（CNAME，于阿里云解析添加主机记录 `radar`）。

## 维护

- 调整重点仓库 / 生态热榜主题：编辑 `radar.mjs` 顶部的 `WATCH` 与 `TOPICS`。
- 热榜周期：日榜（`daily`）/ 周榜（`weekly`）由 `--mode` 决定；趋势页解析逻辑见 `parseTrending()`。
- 长文图渲染：`node scripts/shoot.mjs [输入.html|URL] [输出.png]`（全局 puppeteer，离屏渲染整页 PNG，供邮件内嵌）。
