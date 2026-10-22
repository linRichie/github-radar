#!/usr/bin/env node
// radar.mjs —— GitHub 雷达
// 抓取 GitHub 上的「热门排行动态 / 高增长项目 / 有趣的新锐项目 / AI Skills 与 MCP 生态」，
// 生成 data/*.json 与单文件 index.html（全内联、无外部资源、Swiss 数据报风格：白底/黑/瑞士红、人话时间）。
// 用法：node radar.mjs --mode daily | weekly   （可选 GITHUB_TOKEN 提升速率上限）

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const ROOT = dirname(fileURLToPath(import.meta.url));
const API = "https://api.github.com";
const GH = "https://github.com";
const TOKEN = process.env.GITHUB_TOKEN || "";
const PAGE = "https://radar.moniter.top";

// 重点追踪的 skills / MCP 生态仓库：收敛为 5 个代表性仓库（2 个 awesome 列表 + 3 个官方/框架本体），
// 避免 watch 区被 awesome 列表占满；watch 在页面上降为次要信息。
const WATCH = [
  "anthropics/skills",
  "modelcontextprotocol/servers",
  "obra/superpowers",
  "sickn33/antigravity-awesome-skills",
  "punkpeye/awesome-mcp-servers",
];

// 生态热榜检索主题（GitHub topic）——聚焦 AI / Skills / MCP 细分赛道
const TOPICS = ["mcp", "agent-skills", "claude-skills", "ai-agents", "llm", "claude-code"];

// 领域雷达：8 个业务领域，每领域三栏（Agent Skills / 可用工具 / 新项目）。
// 检索式依据 2026-10-21 实测：
//  - skills 用 `topic:agent-skills <领域词>` 最准（marketingskills 55k / pm-skills 27k 均命中）
//  - 新项目必须用 topic 而非关键词（关键词 + created: 会 0 结果；topic 式 PM 1301 / 运营 1267）
//  - design-system 被「系统设计面试题」污染，产品设计改用 ui-design；招聘用 hr 而非 recruiting（4 → 17）
const DOMAINS = [
  { slug: "growth", zh: "运营 / 增长", kw: "marketing", topic: "marketing" },
  { slug: "design", zh: "产品设计", kw: "design", topic: "ui-design" },
  { slug: "pm", zh: "产品经理", kw: "product management", topic: "product-management" },
  { slug: "data", zh: "数据分析", kw: "analytics", topic: "data-analysis" },
  { slug: "content", zh: "内容创作", kw: "writing", topic: "content-management" },
  { slug: "devops", zh: "研发效率 / DevOps", kw: "devops", topic: "devops" },
  { slug: "sales", zh: "销售 / 客户成功", kw: "sales", topic: "crm" },
  { slug: "hr", zh: "招聘 / HR", kw: "recruiting", topic: "hr" },
];
const FRESH_SINCE = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

const MODE = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "daily";
const IS_WEEKLY = MODE === "weekly";
const DAYS = IS_WEEKLY ? 7 : 2;
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const TREND_SINCE = IS_WEEKLY ? "weekly" : "daily";

// ---------- 工具 ----------
async function gh(path) {
  const res = await fetch(API + path, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "github-radar",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// 取 HTML：优先 node fetch；若超时失败且环境存在代理（本地沙箱常见），
// 回退 curl（零 npm 依赖，curl 始终可用）。GitHub Actions 无代理，走直连 fetch。
async function getHtml(url, ua) {
  const headers = { "User-Agent": ua || "Mozilla/5.0 (compatible; github-radar/1.0)", Accept: "text/html,application/xhtml+xml" };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.text();
  } catch (e) {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxy) {
      const { stdout } = await execFileP("curl", ["-sSL", "--max-time", "25", "-A", headers["User-Agent"], url], { maxBuffer: 50 * 1024 * 1024 });
      return stdout;
    }
    throw e;
  }
}

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function num(s) { const n = String(s).replace(/[^\d]/g, ""); return parseInt(n || "0", 10); }
function pad(n) { return String(n).padStart(2, "0"); }

// 北京时间人话格式：不输出裸 ISO
function human(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const min = Math.floor((now - d) / 6e4);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
// 北京时间部件（generatedAt 为 UTC ISO）：输出 2026.10.21 / 10:53
function bjParts(iso) {
  const d = new Date(new Date(iso || Date.now()).getTime() + 8 * 3600e3);
  return { ymd: `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`, hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}

// ---------- 抓取：GitHub 官方热榜 ----------
// GitHub Trending 无官方 API，解析 github.com/trending 页面（含「今日/本周 star 增量」= 高增长信号）
function parseTrending(html) {
  const blocks = html.split('<article class="Box-row">').slice(1);
  const out = [];
  for (const b of blocks) {
    const fullM = b.match(/<h2[^>]*>[\s\S]*?<a\b[^>]*\shref="\/([^"]+)"/);
    if (!fullM) continue;
    let full = fullM[1].replace(/^\//, "");
    if (full.includes("/stargazers") || full.includes("/forks") || full.split("/").length !== 2) continue;
    const descM = b.match(/class="col-9[^"]*">([\s\S]*?)<\/p>/);
    const desc = descM ? descM[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
    const langM = b.match(/itemprop="programmingLanguage">([^<]+)</);
    const lang = langM ? langM[1].trim() : "";
    // star 总数：stargazers 链接内、紧邻 </a> 的数字（SVG 路径坐标不得计入）
    const starsM = b.match(/\/stargazers"[^>]*>[\s\S]*?(\d[\d,]*)\s*<\/a>/);
    const stars = starsM ? num(starsM[1]) : 0;
    const todayM = b.match(/([\d,]+)\s+stars\s+(today|this week)/i);
    const starsToday = todayM ? num(todayM[1]) : 0;
    const period = todayM ? (/week/i.test(todayM[2]) ? "week" : "day") : "day";
    out.push({
      full, name: full.split("/")[1], owner: full.split("/")[0],
      desc, lang, stars, starsToday, starsPeriod: period,
      url: `${GH}/${full}`, topics: [],
    });
  }
  return out;
}

async function fetchTrending(since) {
  const url = `${GH}/trending${since === "weekly" ? "?since=weekly" : since === "monthly" ? "?since=monthly" : ""}`;
  const html = await getHtml(url);
  return parseTrending(html);
}

// ---------- 抓取：生态热榜（topic 检索）+ 新锐项目 ----------
function normRepo(r) {
  return {
    full: r.full_name, name: r.name, owner: r.owner?.login || r.full_name.split("/")[0],
    desc: r.description || "", stars: r.stargazers_count || 0, lang: r.language || "",
    url: r.html_url, pushed: r.pushed_at, updated: r.updated_at, topics: r.topics || [],
    starsToday: 0, starsPeriod: "recent",
  };
}

async function searchTopic(topic) {
  const q = encodeURIComponent(`topic:${topic} pushed:>=${SINCE}`);
  const data = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=15`);
  return (data.items || []).map(normRepo);
}

// 新锐项目：近期（窗口内）新建、且已积累较高 star 的仓库 = 有趣的新项目
async function searchRising() {
  const q = encodeURIComponent(`created:>=${SINCE} stars:>200`);
  const data = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=15`);
  return (data.items || []).map(normRepo);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 读 README 前 3000 字符（走核心 API，配额 5000/h，不占 Search 的 30/min）
async function fetchReadme(full) {
  try {
    const res = await fetch(`${API}/repos/${full}/readme`, {
      headers: {
        Accept: "application/vnd.github.raw",
        "User-Agent": "github-radar",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return "";
    return (await res.text()).slice(0, 3000);
  } catch {
    return "";
  }
}

// 泛用技能库信号：出现这些词说明是「大而全的集市」，不是领域专属
const GENERIC_HINTS = [
  "marketplace", "all skills", "skills marketplace", "collection of", "tons of",
  "1178", "380 skills", "200+ skills", "1000+ skills", "skill packs",
];

// 判定一个 skills 仓库与该领域的相关度
// dedicated = 领域专属（名字含领域词，如 marketing-skills / pm-skills）
// related   = 含该领域技能，但定位更宽（如「200+ skills 覆盖 marketing/design/…」）
// weak      = 只是 README/描述里偶然出现该词 → 剔除
function judgeSkill(r, readme, kw) {
  const text = `${readme || ""} ${r.desc || ""}`.toLowerCase();
  const words = kw.toLowerCase().split(/[\s/]+/).filter(Boolean);
  const nameLow = (r.name || "").toLowerCase();
  const descLow = (r.desc || "").toLowerCase();
  const kwInName = words.some((w) => nameLow.includes(w));
  const kwInDesc = words.some((w) => descLow.includes(w));
  const hits = words.reduce((n, w) => n + Math.max(0, text.split(w).length - 1), 0);
  const generic = GENERIC_HINTS.some((h) => text.includes(h));
  let score = 0;
  if (kwInName) score += 3;
  if (kwInDesc) score += 2;
  score += Math.min(hits, 8) * 0.4;
  if (generic) score -= 2;
  const level = score >= 5 ? "dedicated" : score >= 2 ? "related" : "weak";
  return { level, score: Math.round(score * 10) / 10, hits, generic };
}

// 领域三栏检索：串行 + 间隔 2.2 秒，避免撞 GitHub Search 的 30 次/分钟限流
// （8 领域 × 3 栏 = 24 次，均匀分布在约 60 秒内）
async function fetchDomains() {
  const out = [];
  for (const d of DOMAINS) {
    const queries = {
      skills: `topic:agent-skills ${d.kw} stars:>10 pushed:>=${SINCE}`,
      repos: `topic:${d.topic} stars:>100 pushed:>=${SINCE}`,
      fresh: `topic:${d.topic} created:>=${FRESH_SINCE}`,
    };
    const item = { slug: d.slug, zh: d.zh, queries, skills: [], repos: [], fresh: [] };
    for (const key of ["skills", "repos", "fresh"]) {
      try {
        // skills 栏多召回一些（12 个），再用 README 校验筛掉泛用库
        const per = key === "skills" ? 12 : 5;
        const q = encodeURIComponent(queries[key]);
        const data = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=${per}`);
        let list = (data.items || []).map(normRepo);
        if (key === "skills") {
          const judged = [];
          for (const r of list) {
            const readme = await fetchReadme(r.full);
            const m = judgeSkill(r, readme, d.kw);
            if (m.level !== "weak") judged.push({ ...r, match: m });
            await sleep(160);
          }
          judged.sort((a, b) => {
            const ded = (b.match.level === "dedicated") - (a.match.level === "dedicated");
            return ded !== 0 ? ded : b.stars - a.stars;
          });
          list = judged.slice(0, 5);
        }
        item[key] = list;
      } catch (e) {
        console.warn(`  ! 领域 ${d.zh}/${key}: ${e.message}`);
      }
      await sleep(2000);
    }
    out.push(item);
    const m = (arr) => arr.map((r) => (r.match ? `${r.match.level[0]}` : "-")).join("");
    console.log(`  · ${d.zh}：skills ${item.skills.length}（${m(item.skills)}）/ 工具 ${item.repos.length} / 新项目 ${item.fresh.length}`);
  }
  return out;
}

async function watchRepo(repo) {
  const [rels, commits] = await Promise.all([
    gh(`/repos/${repo}/releases?per_page=3`).catch(() => []),
    gh(`/repos/${repo}/commits?since=${SINCE}T00:00:00Z&per_page=12`).catch(() => []),
  ]);
  return {
    repo, url: `${GH}/${repo}`,
    latestRelease: rels[0] ? { tag: rels[0].tag_name, date: rels[0].published_at, url: rels[0].html_url } : null,
    commits: commits.map((c) => ({
      msg: c.commit.message.split("\n")[0].slice(0, 90),
      date: c.commit.author?.date, url: c.html_url,
      author: c.author?.login || c.commit.author?.name || "",
    })),
  };
}

// ---------- 主流程 ----------
async function main() {
  console.log(`▶ 模式=${MODE} 窗口=${DAYS}天 自=${SINCE} 热榜周期=${TREND_SINCE}`);
  const [trending, topicGroups, rising, watch] = await Promise.all([
    fetchTrending(TREND_SINCE).catch((e) => { console.warn(`  ! trending: ${e.message}`); return []; }),
    Promise.all(TOPICS.map((t) => searchTopic(t).catch((e) => { console.warn(`  ! topic ${t}: ${e.message}`); return []; }))),
    searchRising().catch((e) => { console.warn(`  ! rising: ${e.message}`); return []; }),
    Promise.all(WATCH.map((r) => watchRepo(r).catch((e) => { console.warn(`  ! watch ${r}: ${e.message}`); return { repo: r, error: e.message, commits: [] }; }))),
  ]);

  // 生态热榜去重（同一仓库可能命中多个 topic），按 star 排序
  const byFull = new Map();
  for (const g of topicGroups) for (const r of g) if (!byFull.has(r.full) || byFull.get(r.full).stars < r.stars) byFull.set(r.full, r);
  const topicHot = [...byFull.values()].sort((a, b) => b.stars - a.stars).slice(0, IS_WEEKLY ? 20 : 12);

  // 高增长排行：按「今日/本周 star 增量」降序
  const growthRank = [...trending].sort((a, b) => b.starsToday - a.starsToday).slice(0, 10);

  // 有更新的 watch 仓库
  const activeWatch = watch.filter((w) => (w.latestRelease || (w.commits && w.commits.length)));

  // 领域雷达（串行抓取，约 60 秒；失败不阻断主流程）
  console.log("· 抓取领域雷达（8 领域 × 3 栏，限流保护中）...");
  const domains = await fetchDomains().catch((e) => {
    console.warn(`  ! domains: ${e.message}`);
    return [];
  });

  const payload = {
    mode: MODE,
    generatedAt: new Date().toISOString(),
    windowDays: DAYS,
    since: SINCE,
    trendPeriod: TREND_SINCE,
    sources: { topics: TOPICS, watch: WATCH, trending: `${GH}/trending${TREND_SINCE === "daily" ? "" : "?since=" + TREND_SINCE}` },
    trending,
    growthRank,
    topicHot,
    rising,
    watch,
    domains,
    activeWatchCount: activeWatch.length,
    counts: { trending: trending.length, topicHot: topicHot.length, rising: rising.length, watch: watch.length, domains: domains.length },
  };

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data", `${MODE}-${TODAY}.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(ROOT, "data", `${MODE}-latest.json`), JSON.stringify(payload, null, 2));

  // 上榜项目结构化解读（由 WorkBuddy 定时任务生成并提交；仅当日数据才会渲染成卡片）
  let enriched = null;
  try {
    const ep = join(ROOT, "data", `enriched-${MODE}.json`);
    if (existsSync(ep)) {
      const e = JSON.parse(readFileSync(ep, "utf8"));
      if (e.date === TODAY) enriched = e;
    }
  } catch (err) {
    console.warn(`  ! enriched: ${err.message}`);
  }
  payload.enriched = enriched;

  // 中文简介缓存（跨天累积，不按日过期；由 WorkBuddy 定时任务维护）
  let zh = {};
  try {
    const zp = join(ROOT, "data", "zh-cache.json");
    if (existsSync(zp)) zh = JSON.parse(readFileSync(zp, "utf8")).zh || {};
  } catch (err) {
    console.warn(`  ! zh-cache: ${err.message}`);
  }
  payload.zh = zh;

  writeFileSync(join(ROOT, "index.html"), renderIndex(payload));
  writeFileSync(join(ROOT, "cards.html"), renderCards(payload));
  writeFileSync(join(ROOT, "domains.html"), renderDomains(payload));
  console.log(`✔ 中文简介缓存 ${Object.keys(zh).length} 条`);
  console.log(enriched ? `✔ 已注入 ${Object.keys(enriched.projects || {}).length} 个上榜项目解读（cards.html）` : "· 无当日解读数据，cards.html 为空态");

  console.log(`✔ 热榜 ${trending.length} | 生态热榜 ${topicHot.length} | 新锐 ${rising.length} | 活跃仓库 ${activeWatch.length}/${watch.length}`);
  console.log("—— 高增长 Top5 ——");
  growthRank.slice(0, 5).forEach((r, i) => console.log(`  ${i + 1}. ${r.full} +${r.starsToday.toLocaleString()}★/${r.starsPeriod} · ${r.desc.slice(0, 50)}`));
  return payload;
}

// ---------- 渲染（双页：index.html 首页 + cards.html 上榜项目详解）----------
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23111'/%3E%3Ctext x='34' y='45' font-family='Helvetica,Arial,sans-serif' font-size='36' font-weight='900' fill='%23fff' text-anchor='middle'%3ER%3C/text%3E%3Ccircle cx='47' cy='17' r='5' fill='%23E30613'/%3E%3C/svg%3E";
const AUTHOR = "老王";
const AUTHOR_MAIL = "wlh.richard@gmail.com";

const CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#e8e8e6;color:#111;font-family:"Helvetica Neue",Helvetica,Arial,"PingFang SC","Noto Sans SC","Source Han Sans SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;padding:36px 16px}
  .page{max-width:1080px;margin:0 auto;background:#fff;border:1px solid #111}
  .masthead{display:flex;justify-content:space-between;align-items:flex-start;padding:30px 36px 24px;border-bottom:3px solid #111}
  .mh-left h1{font-size:44px;font-weight:900;letter-spacing:-.03em;line-height:1.02}
  .mh-left h1 em{font-style:normal;color:#e30613}
  .mh-left .sub{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#555;margin-top:8px;font-weight:600}
  .mh-right{text-align:right;font-size:12px;line-height:1.8}
  .mh-right .date{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
  .mh-right a{color:#111;font-weight:700}
  .badge{display:inline-block;background:#111;color:#fff;font-size:11px;font-weight:800;letter-spacing:.12em;padding:3px 10px;text-transform:uppercase}
  .nav{display:flex;align-items:stretch;border-bottom:3px solid #111}
  .nav a{padding:10px 20px;font-size:12.5px;font-weight:800;letter-spacing:.06em;color:#111;text-decoration:none;border-right:1px solid #ddd}
  .nav a.on{background:#111;color:#fff}
  .nav a:hover{background:#e30613;color:#fff}
  .nav .navwriter{margin-left:auto;display:flex;align-items:center;padding:0 20px;font-size:11px;color:#666;letter-spacing:.02em}
  .nav .navwriter b{color:#111;margin-left:4px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:3px solid #111}
  .metric{padding:18px 22px;border-right:1px solid #ddd}
  .metric:last-child{border-right:none}
  .metric .k{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#666;font-weight:700}
  .metric .v{font-size:36px;font-weight:900;letter-spacing:-.03em;margin-top:4px;font-variant-numeric:tabular-nums;line-height:1}
  .metric .v em{font-style:normal;font-size:12px;font-weight:700;color:#666;margin-left:4px;letter-spacing:0}
  .metric.hot .v{color:#e30613}
  section{padding:24px 36px;border-bottom:1px solid #111}
  section:last-of-type{border-bottom:3px solid #111}
  h2{font-size:15px;font-weight:900;letter-spacing:.02em;margin-bottom:14px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  h2 .no{color:#e30613;font-size:13px;font-weight:900;font-variant-numeric:tabular-nums}
  h2 .en{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#6b6b6b;font-weight:700}
  h2 .hint{font-size:11px;color:#6b6b6b;font-weight:400;letter-spacing:0}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#666;font-weight:700;padding:5px 10px 7px;border-bottom:1px solid #111}
  th.r{text-align:right}
  td{padding:8px 10px;border-bottom:1px solid #e4e4e4;vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  .rk{font-weight:900;font-size:15px;font-variant-numeric:tabular-nums;width:32px;color:#111}
  tbody tr:nth-child(-n+3) .rk{color:#e30613}
  .repo a{color:#111;text-decoration:none;font-weight:700;border-bottom:1px solid #111}
  .repo a:hover{background:#e30613;color:#fff;border-color:#e30613}
  .dz{display:block;color:#2b2b2b}
  .de{display:block;color:#6b6b6b;font-size:11.5px;line-height:1.45;margin-top:2px}
  .num{text-align:right;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
  .inc{text-align:right;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap;color:#e30613}
  .per{color:#6b6b6b;font-size:11px;font-weight:700}
  .lang{color:#666;font-size:12px;white-space:nowrap}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid #111}
  .cards a{display:block;padding:16px 18px;text-decoration:none;border-right:1px solid #ddd;border-bottom:1px solid #ddd}
  .cards a:nth-child(3n){border-right:none}
  .cards a:nth-last-child(-n+3){border-bottom:none}
  .cname{color:#111;font-weight:800;font-size:12.5px;word-break:break-all;border-bottom:1px solid #111;display:inline-block}
  .cdesc{color:#555;font-size:12px;margin:6px 0 8px;line-height:1.55}
  .cmeta{display:flex;justify-content:space-between;font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums}
  .cmeta .s{color:#111}
  .cmeta .l{color:#6b6b6b}
  .tag{display:inline-block;background:#111;color:#fff;font-size:11px;font-weight:800;padding:1px 7px;margin-right:8px;letter-spacing:.04em}
  .tag a{color:#fff;text-decoration:none}
  .reltime{color:#6b6b6b;font-size:11.5px}
  .cmsg a{color:#111;text-decoration:none;font-weight:600;border-bottom:1px solid #ddd}
  .cmsg a:hover{color:#e30613;border-color:#e30613}
  .muted{color:#767676}
  .empty{text-align:center;color:#6b6b6b;padding:24px}
  .lead{padding:18px 36px;background:#f6f6f4;border-bottom:1px solid #111;font-size:12.5px;color:#555}
  .lead b{color:#111}
  .dgrid{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #111}
  .dcol{padding:14px 16px;border-right:1px solid #ddd}
  .dcol:last-child{border-right:none}
  .dcol h3{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#111;font-weight:800;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #111}
  .ditem{padding:7px 0;border-bottom:1px solid #eee;font-size:12.5px;overflow:hidden}
  .ditem:last-child{border-bottom:none}
  .ditem .nm{display:block;font-weight:700;word-break:break-all;line-height:1.4}
  .ditem .nm a{color:#111;text-decoration:none;border-bottom:1px solid #111}
  .ditem .nm a:hover{background:#e30613;color:#fff;border-color:#e30613}
  .ditem .st{float:right;margin-left:8px;font-weight:800;color:#6b6b6b;font-variant-numeric:tabular-nums;font-size:11.5px}
  .mtag{display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.08em;padding:1px 5px;margin-right:6px;vertical-align:1px}
  .mtag.dedicated{background:#111;color:#fff}
  .mtag.related{background:#eee;color:#333;border:1px solid #ccc}
  .ditem .dz2{display:block;color:#666;font-size:11.5px;margin-top:3px;line-height:1.45}
  .dq{font-size:10.5px;color:#6b6b6b;margin-top:10px;letter-spacing:.02em;line-height:1.7}
  .dq code{background:#f4f4f2;padding:1px 5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px}
  .proj{border:1px solid #111;margin-bottom:22px}
  .proj:last-child{margin-bottom:0}
  .proj-head{padding:22px 26px 18px;border-bottom:1px solid #111}
  .proj-kind{display:flex;align-items:baseline;gap:12px;margin-bottom:8px;flex-wrap:wrap}
  .proj-kind .no{color:#e30613;font-size:13px;font-weight:900;font-variant-numeric:tabular-nums}
  .proj-kind .kind{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b6b6b;font-weight:700}
  .proj-name{font-size:34px;font-weight:900;letter-spacing:-.02em;line-height:1.1;word-break:break-all}
  .proj-name a{color:#111;text-decoration:none;border-bottom:2px solid #e30613}
  .proj-name a:hover{background:#e30613;color:#fff}
  .proj-tagline{font-size:15px;color:#111;margin-top:8px;font-weight:600}
  .proj-owner{font-size:12px;color:#6b6b6b;margin-top:4px}
  .proj-owner a{color:#111;font-weight:700}
  .value{margin:14px 26px 0;border-left:5px solid #e30613;background:#fafafa;padding:12px 16px}
  .value .k{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#e30613;font-weight:800;margin-bottom:4px}
  .value .v{font-size:14px;font-weight:700;color:#111}
  .proj-grid{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #111}
  .proj-cell{padding:16px 26px;border-right:1px solid #ddd}
  .proj-cell:nth-child(2n){border-right:none}
  .proj-cell:nth-child(-n+2){border-bottom:1px solid #ddd}
  .proj-cell .k{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#6b6b6b;font-weight:800;margin-bottom:8px}
  .proj-cell ul{margin:0;padding:0;list-style:none}
  .proj-cell li{font-size:13px;padding:4px 0 4px 14px;position:relative;color:#2b2b2b;line-height:1.55}
  .proj-cell li::before{content:"—";position:absolute;left:0;color:#e30613;font-weight:700}
  .proj-stats{display:grid;grid-template-columns:repeat(3,1fr)}
  .proj-stat{padding:14px 26px;border-right:1px solid #ddd}
  .proj-stat:last-child{border-right:none}
  .proj-stat .k{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#6b6b6b;font-weight:700}
  .proj-stat .v{font-size:26px;font-weight:900;letter-spacing:-.02em;margin-top:2px;font-variant-numeric:tabular-nums}
  .proj-stat.hot .v{color:#e30613}
  .proj-stat .v em{font-style:normal;font-size:12px;font-weight:700;color:#6b6b6b;margin-left:2px;letter-spacing:0}
  .proj-foot{padding:8px 26px;font-size:10.5px;color:#6b6b6b;letter-spacing:.04em;border-top:1px solid #111}
  footer{padding:16px 36px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:11px;color:#666;letter-spacing:.04em;border-top:3px solid #111}
  footer a{color:#111;font-weight:700}
  footer .by b{color:#111}
  @media(max-width:760px){.metrics{grid-template-columns:repeat(2,1fr)}.cards{grid-template-columns:1fr}.cards a{border-right:none}.mh-left h1{font-size:32px}.masthead{flex-direction:column;gap:14px}.mh-right{text-align:left}.desc,.lang{display:none}table{display:block;overflow-x:auto}.repo a{word-break:break-all}.proj-grid{grid-template-columns:1fr}.proj-cell{border-right:none;border-bottom:1px solid #ddd}.proj-cell:last-child{border-bottom:none}.proj-name{font-size:26px}.proj-head,.proj-cell,.proj-stat{padding-left:18px;padding-right:18px}.value{margin-left:18px;margin-right:18px}.proj-stats{grid-template-columns:1fr}.proj-stat{border-right:none;border-bottom:1px solid #ddd}.proj-stat:last-child{border-bottom:none}.nav .navwriter{display:none}.nav a{padding:10px 14px;font-size:12px}.dgrid{grid-template-columns:1fr}.dcol{border-right:none;border-bottom:1px solid #ddd}.dcol:last-child{border-bottom:none}}
`;

function cut(s, n) {
  s = s || "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// 中文优先的简介：中文主行 + 英文原文小字。原描述本身是中文时只显示一行。
function descHtml(r, p, limit) {
  const zh = (p.zh && p.zh[r.full]) || "";
  const raw = (r.desc || "").trim();
  const lim = limit || 60;
  const rawIsZh = /[\u4e00-\u9fa5]/.test(raw);
  if (!raw && !zh) return `<span class="muted">暂无简介</span>`;
  if (rawIsZh && !zh) return `<span class="dz">${esc(cut(raw, lim))}</span>`;
  const z = zh || `（英文简介待翻译）`;
  const e = raw && !rawIsZh ? `<span class="de">${esc(cut(raw, lim + 30))}</span>` : "";
  return `<span class="dz">${esc(cut(z, lim + 8))}</span>${e}`;
}

function rowTrend(r, i, p) {
  return `<tr>
      <td class="rk">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a></td>
      <td class="desc">${descHtml(r, p, 62)}</td>
      <td class="num">${r.stars.toLocaleString()}</td>
      <td class="inc">▲ +${r.starsToday.toLocaleString()}</td>
      <td class="lang">${esc(r.lang) || "—"}</td>
    </tr>`;
}

function rowGrowth(r, i, p) {
  return `<tr>
      <td class="rk">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a></td>
      <td class="desc">${descHtml(r, p, 48)}</td>
      <td class="num">${r.stars.toLocaleString()}</td>
      <td class="inc">▲ +${r.starsToday.toLocaleString()}<span class="per">/${r.starsPeriod === "week" ? "week" : "day"}</span></td>
    </tr>`;
}

function rowTopic(r, i, p) {
  return `<tr>
      <td class="rk">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a></td>
      <td class="desc">${descHtml(r, p, 56)}</td>
      <td class="num">${r.stars.toLocaleString()}</td>
      <td class="lang">${esc(r.lang) || "—"}</td>
    </tr>`;
}

function risingCard(r, p) {
  const zh = (p.zh && p.zh[r.full]) || "";
  const raw = (r.desc || "").trim();
  const rawIsZh = /[\u4e00-\u9fa5]/.test(raw);
  const text = zh || (rawIsZh ? raw : raw) || "";
  return `<a href="${esc(r.url)}" target="_blank" rel="noopener">
      <div class="cname">${esc(r.full)}</div>
      <div class="cdesc">${text ? esc(cut(text, 56)) : `<span class="muted">暂无简介</span>`}</div>
      <div class="cmeta"><span class="s">★ ${r.stars.toLocaleString()}</span><span class="l">${esc(r.lang) || "—"}</span></div>
    </a>`;
}

function watchRow(w) {
  const rel = w.latestRelease
    ? `<span class="tag"><a href="${esc(w.latestRelease.url)}" target="_blank" rel="noopener">${esc(w.latestRelease.tag)}</a></span><span class="reltime">${human(w.latestRelease.date)}</span>`
    : `<span class="reltime muted">无新版本</span>`;
  const cm = (w.commits || [])[0];
  const cmHtml = cm
    ? `<a href="${esc(cm.url)}" target="_blank" rel="noopener">${esc(cut(cm.msg, 42))}</a> <span class="reltime">${human(cm.date)}</span>`
    : `<span class="muted">本期无提交</span>`;
  return `<tr>
      <td class="repo"><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.repo)}</a></td>
      <td class="rel">${rel}</td>
      <td class="cmsg">${cmHtml}</td>
    </tr>`;
}

// 上榜项目详解卡片（数据来自 data/enriched-<mode>.json，由 WorkBuddy 定时任务生成）
function renderProjectCards(p) {
  const e = p.enriched;
  if (!e || !e.projects) return "";
  const periodWord = p.trendPeriod === "weekly" ? "本周" : "今日";
  const items = [];
  const seen = new Set();
  p.trending.slice(0, 10).forEach((r, i) => {
    if (e.projects[r.full] && !seen.has(r.full)) {
      items.push({ r, kind: `${periodWord}热榜第 ${i + 1} · TRENDING · ${(r.lang || "—").toUpperCase()}` });
      seen.add(r.full);
    }
  });
  p.growthRank.slice(0, 10).forEach((r, i) => {
    if (e.projects[r.full] && !seen.has(r.full)) {
      items.push({ r, kind: `高增长第 ${i + 1} · GROWTH · ${(r.lang || "—").toUpperCase()}` });
      seen.add(r.full);
    }
  });
  if (!items.length) return "";
  const li = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
  return items
    .map((it, i) => {
      const d = e.projects[it.r.full];
      const base = it.r.stars - it.r.starsToday;
      const gain = base > 0 && it.r.starsToday ? ((it.r.starsToday / base) * 100).toFixed(1) : "0";
      return `
    <div class="proj">
      <div class="proj-head">
        <div class="proj-kind"><span class="no">${String(i + 1).padStart(2, "0")}</span><span class="kind">${esc(it.kind)}</span></div>
        <div class="proj-name"><a href="${esc(it.r.url)}" target="_blank" rel="noopener">${esc(it.r.full)}</a></div>
        <div class="proj-tagline">${esc(d.tagline)}</div>
        <div class="proj-owner"><a href="${esc(GH + "/" + it.r.owner)}" target="_blank" rel="noopener">${esc(it.r.owner)}</a> / ${esc(it.r.name)}</div>
      </div>
      <div class="value"><div class="k">核心价值</div><div class="v">${esc(d.value)}</div></div>
      <div class="proj-grid">
        <div class="proj-cell"><div class="k">主要功能</div><ul>${li(d.features)}</ul></div>
        <div class="proj-cell"><div class="k">应用场景</div><ul>${li(d.scenarios)}</ul></div>
        <div class="proj-cell"><div class="k">输入建议</div><ul>${li(d.inputs)}</ul></div>
        <div class="proj-cell"><div class="k">使用提醒</div><ul>${li(d.caveats)}</ul></div>
      </div>
      <div class="proj-stats">
        <div class="proj-stat"><div class="k">总 Star</div><div class="v">${it.r.stars.toLocaleString()}</div></div>
        <div class="proj-stat hot"><div class="k">${periodWord}新增</div><div class="v">+${it.r.starsToday.toLocaleString()}</div></div>
        <div class="proj-stat hot"><div class="k">获星增幅</div><div class="v">+${gain}<em>%</em></div></div>
      </div>
      <div class="proj-foot">解读由 AI 基于公开信息生成，仅供参考 · 增幅=期内新增÷期初累计获星，非净增</div>
    </div>`;
    })
    .join("");
}

// 页面骨架：masthead + 导航 + 正文 + 页脚（两页共用）
function pageShell(p, { title, navActive, metrics, body }) {
  const badge = p.mode === "weekly" ? "WEEKLY 周报" : "DAILY 日报";
  const { ymd, hm } = bjParts(p.generatedAt);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${ICON}">
<title>${esc(title)}</title>
</head>
<body>
<div class="page">
  <div class="masthead">
    <div class="mh-left">
      <h1>GitHub<br>雷达<em>.</em></h1>
      <div class="sub">GITHUB RADAR — TRENDING / GROWTH / AI SKILLS &amp; MCP</div>
    </div>
    <div class="mh-right">
      <span class="badge">${badge}</span>
      <div class="date">${ymd}</div>
      <div>北京时间 ${hm} 更新</div>
      <a href="${PAGE}" target="_blank" rel="noopener">${PAGE}</a>
    </div>
  </div>
  <nav class="nav">
    <a href="./" class="${navActive === "index" ? "on" : ""}">首页</a>
    <a href="./domains.html" class="${navActive === "domains" ? "on" : ""}">领域雷达</a>
    <a href="./cards.html" class="${navActive === "cards" ? "on" : ""}">上榜项目详解</a>
    <span class="navwriter">撰稿<b>${AUTHOR}</b> · ${AUTHOR_MAIL}</span>
  </nav>
  ${metrics || ""}
  ${body}
  <footer>
    <span>数据抓取：${ymd} ${hm}（北京时间）· 来源 GitHub Trending / GitHub API · 检索窗口：最近 ${p.windowDays} 天内有活跃更新的项目</span>
    <span class="by">撰稿：<b>${AUTHOR}</b> · <a href="mailto:${AUTHOR_MAIL}">${AUTHOR_MAIL}</a> · <a href="${PAGE}" target="_blank" rel="noopener">${PAGE} ↗</a></span>
  </footer>
</div>
<style>${CSS}</style>
</body>
</html>`;
}

function renderIndex(p) {
  const periodWord = p.trendPeriod === "weekly" ? "本周" : "今日";
  const top1 = p.growthRank[0];
  const trendRows = p.trending.map((r, i) => rowTrend(r, i, p)).join("");
  const growthRows = p.growthRank.map((r, i) => rowGrowth(r, i, p)).join("");
  const topicRows = p.topicHot.map((r, i) => rowTopic(r, i, p)).join("");
  const risingCards = p.rising.map((r) => risingCard(r, p)).join("");
  const watchRows = p.watch.map(watchRow).join("");
  const cardCount = renderProjectCards(p) ? Object.keys(p.enriched.projects || {}).length : 0;

  let n = 0;
  const no = () => `<span class="no">${String(++n).padStart(2, "0")}</span>`;
  const metrics = `<div class="metrics">
    <div class="metric"><div class="k">${periodWord}热榜</div><div class="v">${p.counts.trending}<em>repos</em></div></div>
    <div class="metric hot"><div class="k">高增长 Top 1</div><div class="v">${top1 ? "+" + top1.starsToday.toLocaleString() : "—"}<em>/${top1 ? (top1.starsPeriod === "week" ? "week" : "day") : ""}</em></div></div>
    <div class="metric"><div class="k">生态热榜</div><div class="v">${p.counts.topicHot}<em>repos</em></div></div>
    <div class="metric"><div class="k">新锐项目</div><div class="v">${p.counts.rising}<em>new</em></div></div>
  </div>`;

  const body = `
  <section>
    <h2>${no()}GitHub ${periodWord}热榜<span class="en">Trending</span><span class="hint">中文简介在上，英文原文在下</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th class="r">star</th><th class="r">${periodWord}增量</th><th>语言</th></tr></thead>
      <tbody>${trendRows || `<tr><td colspan="6" class="empty">本周期未抓取到热榜数据</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>${no()}高增长排行<span class="en">Growth</span><span class="hint">按${periodWord} star 增量降序</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th class="r">总 star</th><th class="r">增量</th></tr></thead>
      <tbody>${growthRows || `<tr><td colspan="5" class="empty">本周期无热榜增量数据</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>${no()}AI / Skills / MCP 生态热榜<span class="en">Ecosystem</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th class="r">star</th><th>语言</th></tr></thead>
      <tbody>${topicRows || `<tr><td colspan="5" class="empty">本周期未检索到符合条件的项目</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>${no()}新锐项目<span class="en">Rising</span><span class="hint">窗口内新建、快速涨星</span></h2>
    <div class="cards">${risingCards || `<div class="empty">本周期未检索到新锐项目</div>`}</div>
  </section>
  <section>
    <h2>${no()}生态 watch 动态<span class="en">Watchlist</span><span class="hint">次要信息 · 仅保留 5 个代表性仓库，只列有更新的</span></h2>
    <table>
      <thead><tr><th>仓库</th><th>最新 release</th><th>最近提交</th></tr></thead>
      <tbody>${watchRows || `<tr><td colspan="3" class="empty">本周期无 watch 数据</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2>${no()}上榜项目详解<span class="en">Project Cards</span></h2>
    <p style="font-size:13px;color:#555">${cardCount ? `已为 ${cardCount} 个上榜项目撰写结构化解读（一句话定位 / 核心价值 / 主要功能 / 应用场景 / 输入建议 / 使用提醒），为避免首页过长已移至独立页面。` : `解读将在每日 09:00 生成后上线。`}</p>
    <p style="margin-top:10px"><a href="./cards.html" style="display:inline-block;background:#111;color:#fff;padding:8px 18px;font-size:13px;font-weight:800;text-decoration:none;letter-spacing:.04em">查看上榜项目详解 →</a></p>
  </section>`;

  return pageShell(p, { title: `GitHub 雷达 · ${p.mode === "weekly" ? "周报" : "日报"}`, navActive: "index", metrics, body });
}

// 领域页简介：中文优先，无译时直接显示英文原文（不显示「待翻译」占位）
function descPlain(r, p) {
  const zh = (p.zh && p.zh[r.full]) || "";
  const raw = (r.desc || "").trim();
  if (zh) return esc(cut(zh, 66));
  if (!raw) return "暂无简介";
  return esc(cut(raw, 90));
}

// 领域雷达页：8 个领域 × 三栏（Agent Skills / 可用工具 / 新项目）
function renderDomains(p) {
  const domains = p.domains || [];
  const cell = (title, arr, empty, p, isSkill) => `<div class="dcol"><h3>${title}</h3>${
    arr.length
      ? arr
          .map(
            (r) =>
              `<div class="ditem">${isSkill && r.match ? `<span class="mtag ${r.match.level}">${r.match.level === "dedicated" ? "专属" : "相关"}</span>` : ""}<span class="st">★ ${r.stars.toLocaleString()}</span><span class="nm"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a></span><span class="dz2">${descPlain(r, p)}</span></div>`,
          )
          .join("")
      : `<div class="ditem"><span class="dz2">${empty}</span></div>`
  }</div>`;

  const body = domains.length
    ? `<div class="lead"><b>领域雷达</b> · ${domains.length} 个业务领域 · 每领域三栏：<b>Agent Skills</b>（已抓取 README 校验：<span class="mtag dedicated">专属</span>=名字即该领域技能库 <span class="mtag related">相关</span>=含该领域技能但定位更宽）/ <b>可用工具</b>（成熟项目）/ <b>新项目</b>（近 90 天新建）· 每栏 Top 5 · 检索式公开可审计</div>
  ${domains
    .map(
      (d, i) => `
  <section>
    <h2><span class="no">${String(i + 1).padStart(2, "0")}</span>${esc(d.zh)}<span class="en">${esc(d.slug)}</span></h2>
    <div class="dgrid">
      ${cell("Agent Skills · README 已校验", d.skills, "暂无该领域技能", p, true)}
      ${cell("可用工具", d.repos, "暂无", p, false)}
      ${cell("新项目 · 近 90 天", d.fresh, "暂无新建项目", p, false)}
    </div>
    <div class="dq">检索式：<code>${esc(d.queries.skills)}</code> · <code>${esc(d.queries.repos)}</code> · <code>${esc(d.queries.fresh)}</code></div>
  </section>`,
    )
    .join("")}`
    : `<div class="lead"><b>领域雷达</b> · 本次未抓取到领域数据（GitHub API 限流或网络异常），下次运行会重试</div>
  <section><p class="empty">暂无领域数据。</p></section>`;

  return pageShell(p, { title: `GitHub 雷达 · 领域雷达 · ${p.mode === "weekly" ? "周报" : "日报"}`, navActive: "domains", body });
}

function renderCards(p) {
  const periodWord = p.trendPeriod === "weekly" ? "本周" : "今日";
  const cards = renderProjectCards(p);
  const count = p.enriched ? Object.keys(p.enriched.projects || {}).length : 0;
  const body = cards
    ? `<div class="lead"><b>${periodWord}上榜项目详解</b> · 共 ${count} 个项目 · 覆盖${periodWord}热榜与高增长排行 Top 10 · 解读由 AI 基于公开信息生成，仅供参考</div>
  <section>
    <h2><span class="no">01</span>项目卡片<span class="en">Project Cards</span></h2>
    ${cards}
  </section>`
    : `<div class="lead">${periodWord}的上榜项目解读将在每日 09:00 生成后上线</div>
  <section><p class="empty">暂无解读数据，请稍后访问。</p></section>`;
  return pageShell(p, { title: `GitHub 雷达 · 上榜项目详解 · ${p.mode === "weekly" ? "周报" : "日报"}`, navActive: "cards", body });
}

// 仅当以 `node radar.mjs` 直接运行时执行；被 import 时仅导出函数（便于单测）
const isSelf = process.argv[1] && process.argv[1].replace(/^.*\//, "") === "radar.mjs";
export { parseTrending, fetchTrending, renderIndex, renderCards, renderDomains, main };

if (isSelf) {
  main().catch((e) => { console.error("FATAL", e); process.exit(1); });
}
