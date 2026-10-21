# Skills / MCP 生态雷达

持续追踪 **AI Skills 与 MCP 工具链** 的开源动态，自动生成公网页面并邮件推送。

- 公网页面：<https://skills.moniter.top>
- 数据来源：GitHub Search API（topic 过滤）+ 重点仓库的 releases / commits

## 抓取什么

1. **新晋热门项目**：按 `mcp` / `agent-skills` / `claude-skills` / `ai-agents` / `llm` / `claude-code` 等 topic 检索近 1–7 天有更新的仓库，按 star 排序。
2. **生态 watch 动态**：10 个重点仓库（anthropics/skills、modelcontextprotocol/servers、punkpeye/awesome-mcp-servers、ComposioHQ/awesome-claude-skills、VoltAgent/awesome-agent-skills、obra/superpowers 等）的新版本与近期提交。

## 运行

```bash
export GITHUB_TOKEN=$(gh auth token)   # 可选，提升速率上限
node radar.mjs --mode daily             # 日报（近 2 天）
node radar.mjs --mode weekly            # 周报（近 7 天）
```

产物：

- `data/<mode>-<日期>.json` / `data/<mode>-latest.json`：原始数据
- `index.html`：单文件仪表盘（全内联、无外部资源，GitHub Pages 直接托管）

## 自动化

- GitHub Actions：`radar-daily`（每日 北京时间 08:00`）、`radar-weekly`（每周一 08:00）自动抓取并提交。
- WorkBuddy 定时任务：每日 / 每周生成中文摘要并经邮件推送。
- 自定义域名：`skills.moniter.top` → `linRichie.github.io`（CNAME，于阿里云解析添加）。

## 维护

新增/调整追踪对象，编辑 `radar.mjs` 顶部的 `WATCH`（重点仓库）与 `TOPICS`（检索主题）即可。
