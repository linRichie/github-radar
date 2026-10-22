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

## 领域雷达（按业务领域找项目）

`domains.html`：8 个业务领域的项目发现页，每领域三栏，每栏 Top 5。

| 领域 | slug | Agent Skills 检索 | 可用工具 / 新项目 topic |
|---|---|---|---|
| 运营 / 增长 | `growth` | `topic:agent-skills marketing` | `marketing` |
| 产品设计 | `design` | `topic:agent-skills design` | `ui-design` |
| 产品经理 | `pm` | `topic:agent-skills product management` | `product-management` |
| 数据分析 | `data` | `topic:agent-skills analytics` | `data-analysis` |
| 内容创作 | `content` | `topic:agent-skills writing` | `content-management` |
| 研发效率 / DevOps | `devops` | `topic:agent-skills devops` | `devops` |
| 销售 / 客户成功 | `sales` | `topic:agent-skills sales` | `crm` |
| 招聘 / HR | `hr` | `topic:agent-skills recruiting` | `hr` |

三栏查询式（页面上会明文展示，便于审计）：

- **Agent Skills**：`topic:agent-skills <领域词> stars:>10 pushed:>=<窗口>` 召回 12 个 → **抓 README 校验后取 5 个**
- **可用工具**：`topic:<topic> stars:>100 pushed:>=<窗口>`
- **新项目**：`topic:<topic> created:>=<90 天前>`

### Agent Skills 的 README 校验（为什么需要）

`topic:agent-skills <领域词>` 的关键词是**全文匹配**，会把「描述里偶然提到该领域」的泛用技能库也召回——实测数据分析栏曾混入 `sentdm/sent-plugin`（发短信插件）、视频剪辑技能包等完全不相关的项目。

因此 skills 栏做了二次校验：对召回结果逐个抓取 README 前 3000 字符，按下面规则打分并打标签：

| 信号 | 分值 |
|---|---|
| 仓库名含领域词（如 `marketing-skills`） | +3 |
| description 含领域词 | +2 |
| README + description 中领域词出现次数（上限 8 次） | 每次 +0.4 |
| 出现「泛用集市」信号（`marketplace` / `all skills` / `380 skills` / `200+ skills` 等） | −2 |

- `score >= 5` → 标 **专属**（名字即该领域技能库）
- `score >= 2` → 标 **相关**（含该领域技能但定位更宽）
- `< 2` → **剔除**，不上榜

README 请求走 GitHub 核心 API（配额 5000/h），**不占用 Search API 的 30 次/分钟限流**；8 领域 × 12 个 README 约增加 20 秒。

> 已知现实：HR / 销售 / DevOps 的 agent skills 生态本身较稀薄，过滤后可能只剩 1–2 个甚至空栏——这比塞入不相关的仓库更诚实。

**设计依据（2026-10-21 实测 32 次查询）**：
- skills 用 `topic:agent-skills <领域词>` 最准（命中 marketingskills ⭐55k、pm-skills ⭐27k 等领域技能集市）
- 新项目**必须用 topic 而非关键词**：`product management created:>=90d` 是 0 结果，`topic:product-management created:>=90d` 是 1301
- `design-system` 被「系统设计面试题」污染（`donnemartin/system-design-primer` ⭐375k），产品设计改用 `ui-design`
- 招聘用 `topic:hr`（17）而非 `topic:recruiting`（4）
- 24 次查询串行 + 每次间隔 2.2 秒，避免撞 GitHub Search 的 30 次/分钟限流（CI 整体约 90 秒）

调整领域或检索式：编辑 `radar.mjs` 顶部的 `DOMAINS` 数组即可。

## 数据落盘（阿里云 MySQL）

每次抓取后，CI 会调用 `scripts/load_db.py` 把数据写入阿里云 RDS（MySQL 8），便于长期趋势分析。

- **凭据**：全部通过仓库 Secrets 注入（`MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DB`），**代码中不含任何连接信息**；脚本检测到未设置 `MYSQL_HOST` 时自动跳过，不影响页面发布。
- **表结构**（库 `github_radar`）：
  - `runs`：每次运行一行（模式、抓取时间、各分区数量、解读数量），`(mode, generated_at)` 唯一。
  - `projects`：项目主表（`full_name` 唯一），含 `stars`、`desc_zh`（中文简介）、`tagline` / `core_value` / `features` / `scenarios` / `inputs` / `caveats`（解读六字段，JSON）、`first_seen` / `last_seen`。
  - `snapshots`：榜单快照（`run_id` + 分区 + 排名 + star + 增量），用于回溯任何一天的榜单位置与涨星曲线。
- **幂等**：`runs` 按唯一键 UPSERT；同一 `run_id` 的 `snapshots` 先删后插；`projects` 按 `full_name` UPSERT。
- **本地手动落库**：
  ```bash
  export MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DB=github_radar
  pip install pymysql && python scripts/load_db.py --mode daily
  ```

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
