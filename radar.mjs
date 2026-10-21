#!/usr/bin/env node
// radar.mjs —— GitHub 雷达
// 抓取 GitHub 上的「热门排行动态 / 高增长项目 / 有趣的新锐项目 / AI Skills 与 MCP 生态」，
// 生成 data/*.json 与单文件 index.html（全内联、无外部资源、朱橙品牌色、人话时间）。
// 用法：node radar.mjs --mode daily | weekly   （可选 GITHUB_TOKEN 提升速率上限）

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const ROOT = dirname(fileURLToPath(import.meta.url));
const API = "https://api.github.com";
const GH = "https://github.com";
const TOKEN = process.env.GITHUB_TOKEN || "";
const ACCENT = "#E8552D";
const PAGE = "https://radar.moniter.top";

// 重点追踪的 skills / MCP 生态仓库（保留原能力）
const WATCH = [
  "anthropics/skills",
  "modelcontextprotocol/servers",
  "punkpeye/awesome-mcp-servers",
  "ComposioHQ/awesome-claude-skills",
  "VoltAgent/awesome-agent-skills",
  "sickn33/antigravity-awesome-skills",
  "hesreallyhim/awesome-claude-code",
  "affaan-m/everything-claude-code",
  "obra/superpowers",
  "rohitg00/awesome-claude-code-toolkit",
];

// 生态热榜检索主题（GitHub topic）——聚焦 AI / Skills / MCP 细分赛道
const TOPICS = ["mcp", "agent-skills", "claude-skills", "ai-agents", "llm", "claude-code"];

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
function fmtFull(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    activeWatchCount: activeWatch.length,
    counts: { trending: trending.length, topicHot: topicHot.length, rising: rising.length, watch: watch.length },
  };

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data", `${MODE}-${TODAY}.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(ROOT, "data", `${MODE}-latest.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(ROOT, "index.html"), renderHtml(payload));

  console.log(`✔ 热榜 ${trending.length} | 生态热榜 ${topicHot.length} | 新锐 ${rising.length} | 活跃仓库 ${activeWatch.length}/${watch.length}`);
  console.log("—— 高增长 Top5 ——");
  growthRank.slice(0, 5).forEach((r, i) => console.log(`  ${i + 1}. ${r.full} +${r.starsToday.toLocaleString()}★/${r.starsPeriod} · ${r.desc.slice(0, 50)}`));
  return payload;
}

// ---------- 渲染（单文件 HTML，全内联，无外部资源）----------
function repoRow(r, i, withGrowth) {
  const growth = withGrowth && r.starsToday ? `<td class="num hot">▲ +${r.starsToday.toLocaleString()}<span class="per">/${r.starsPeriod}</span></td>` : "";
  return `
    <tr>
      <td class="idx">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a>${r.topics && r.topics.length ? `<span class="topics">${r.topics.slice(0, 4).map((t) => "#" + esc(t)).join(" ")}</span>` : ""}</td>
      <td class="desc">${esc(r.desc)}</td>
      <td class="num">⭐ ${r.stars.toLocaleString()}</td>
      ${withGrowth ? growth : ""}
      <td class="lang">${esc(r.lang)}</td>
      <td class="time">${human(r.pushed)}</td>
    </tr>`;
}

function renderHtml(p) {
  const badge = p.mode === "weekly" ? "周报" : "日报";
  const trendHead = p.trendPeriod === "weekly" ? "本周 star 增量" : "今日 star 增量";
  const trendRows = p.trending.map((r, i) => repoRow(r, i, true)).join("");
  const topicRows = p.topicHot.map((r, i) => repoRow(r, i, false)).join("");
  const risingRows = p.rising.map((r, i) => repoRow(r, i, false)).join("");

  const watchBlocks = p.watch.map((w) => {
    const rel = w.latestRelease
      ? `<span class="rel"><a href="${esc(w.latestRelease.url)}" target="_blank" rel="noopener">${esc(w.latestRelease.tag)}</a> · ${human(w.latestRelease.date)}</span>`
      : `<span class="rel muted">无新版本</span>`;
    const cs = (w.commits || []).slice(0, 5).map((c) => `<li><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.msg)}</a> <span class="cm">${esc(c.author)} · ${human(c.date)}</span></li>`).join("");
    return `
    <div class="wcard">
      <div class="whead"><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.repo)}</a> ${rel}</div>
      ${cs ? `<ul class="wcommits">${cs}</ul>` : `<div class="wcommits muted">本期无提交</div>`}
    </div>`;
  }).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub 雷达 · ${badge}</title>
</head>
<body>
<div class="wrap">
  <header>
    <div class="t1">GitHub 雷达</div>
    <div class="t2">追踪 GitHub 热门排行动态、高增长项目、有趣新锐与 AI Skills / MCP 生态</div>
    <div class="meta"><span class="badge">${badge}</span> 更新于 ${fmtFull(p.generatedAt)} · 窗口 ${p.windowDays} 天（自 ${p.since}）· 热榜周期 ${p.trendPeriod === "weekly" ? "本周" : "今日"}</div>
  </header>

  <section class="cards">
    <div class="card"><div class="cv">${p.counts.trending}</div><div class="ck">GitHub 热榜</div></div>
    <div class="card"><div class="cv">${p.counts.topicHot}</div><div class="ck">生态热榜</div></div>
    <div class="card"><div class="cv">${p.counts.rising}</div><div class="ck">新锐项目</div></div>
    <div class="card"><div class="cv">${p.activeWatchCount}/${p.watch.length}</div><div class="ck">生态活跃仓库</div></div>
  </section>

  <section>
    <h2>GitHub 热榜 <span class="sub">（${p.trendPeriod === "weekly" ? "本周" : "今日"}排行，含 ${trendHead}）</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th>star</th><th>${trendHead}</th><th>语言</th><th>更新</th></tr></thead>
      <tbody>${trendRows || `<tr><td colspan="7" class="empty">本周期未抓取到热榜数据</td></tr>`}</tbody>
    </table>
  </section>

  <section>
    <h2>高增长排行 <span class="sub">（按 ${trendHead} 降序 Top 10）</span></h2>
    <div class="growth">
      ${p.growthRank.map((r, i) => `<div class="gitem"><span class="grank">${i + 1}</span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a><span class="gval">▲ +${r.starsToday.toLocaleString()}★/${r.starsPeriod}</span></div>`).join("") || `<div class="empty">无数据</div>`}
    </div>
  </section>

  <section>
    <h2>AI / Skills / MCP 生态热榜 <span class="sub">（topic 检索，按 star 排序）</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th>star</th><th>语言</th><th>更新</th></tr></thead>
      <tbody>${topicRows || `<tr><td colspan="6" class="empty">本周期未检索到符合条件的项目</td></tr>`}</tbody>
    </table>
  </section>

  <section>
    <h2>新锐项目 <span class="sub">（窗口内新建且快速涨星）</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th>star</th><th>语言</th><th>更新</th></tr></thead>
      <tbody>${risingRows || `<tr><td colspan="6" class="empty">本周期未检索到新锐项目</td></tr>`}</tbody>
    </table>
  </section>

  <section>
    <h2>生态 watch 动态 <span class="sub">（${p.watch.length} 个重点仓库）</span></h2>
    <div class="wgrid">${watchBlocks}</div>
  </section>

  <footer>
    <div>数据来源：GitHub Trending 页面（热门/高增长排行）+ GitHub Search API（topic 检索 / 新锐项目）+ 各重点仓库 releases / commits。</div>
    <div>由 <code>radar.mjs</code> 自动生成 · 公网页面 <a href="${PAGE}" target="_blank" rel="noopener">${PAGE}</a> · 每日 / 每周自动更新并邮件推送。</div>
  </footer>
</div>
<style>
  :root{ --accent:${ACCENT}; --ink:#2c2c2a; --mut:#6b6b66; --line:#ececea; --bg:#faf9f7; --card:#fff; }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}
  .wrap{max-width:1000px;margin:0 auto;padding:28px 20px 56px;}
  header{border-left:5px solid var(--accent);padding:4px 0 4px 16px;margin-bottom:22px;}
  .t1{font-size:26px;font-weight:600;}
  .t2{color:var(--mut);margin-top:4px;}
  .meta{margin-top:10px;color:var(--mut);font-size:13px;}
  .badge{display:inline-block;background:var(--accent);color:#fff;border-radius:6px;padding:1px 9px;font-size:12px;font-weight:500;}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 30px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 12px;text-align:center;}
  .cv{font-size:24px;font-weight:600;color:var(--accent);}
  .ck{color:var(--mut);font-size:12px;margin-top:4px;}
  h2{font-size:18px;margin:26px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px;}
  .sub{font-size:13px;color:var(--mut);font-weight:400;}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px;}
  th{background:#f4f3f0;color:var(--mut);font-weight:500;font-size:13px;}
  tr:last-child td{border-bottom:none;}
  .idx{color:var(--mut);width:28px;}
  .repo a{color:var(--accent);text-decoration:none;font-weight:500;}
  .repo a:hover{text-decoration:underline;}
  .topics{display:block;color:var(--mut);font-size:12px;margin-top:2px;}
  .desc{color:var(--ink);}
  .num{white-space:nowrap;color:var(--accent);font-weight:500;}
  .num.hot{color:#1a8f4a;}
  .per{color:var(--mut);font-weight:400;font-size:12px;}
  .lang{color:var(--mut);white-space:nowrap;}
  .time{color:var(--mut);white-space:nowrap;font-size:13px;}
  .empty{text-align:center;color:var(--mut);padding:24px;}
  .growth{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;}
  .gitem{display:flex;align-items:center;gap:8px;font-size:14px;padding:3px 0;border-bottom:1px dashed var(--line);}
  .gitem:last-child,.gitem:nth-last-child(2){border-bottom:none;}
  .grank{display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;background:var(--accent);color:#fff;border-radius:50%;font-size:12px;font-weight:600;flex:none;}
  .gitem a{color:var(--ink);text-decoration:none;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .gitem a:hover{color:var(--accent);}
  .gval{color:#1a8f4a;font-size:12px;font-weight:500;flex:none;}
  .wgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
  .wcard{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;}
  .whead{font-weight:500;}
  .whead a{color:var(--accent);text-decoration:none;}
  .whead a:hover{text-decoration:underline;}
  .rel{margin-left:8px;font-size:12px;color:var(--mut);}
  .rel a{color:var(--accent);text-decoration:none;}
  .rel.muted{color:#9a9a95;}
  .wcommits{margin:8px 0 0;padding:0;list-style:none;}
  .wcommits li{font-size:13px;padding:3px 0;border-top:1px dashed var(--line);}
  .wcommits li a{color:var(--ink);text-decoration:none;}
  .wcommits li a:hover{color:var(--accent);}
  .cm{color:var(--mut);font-size:12px;margin-left:4px;}
  .wcommits.muted{color:var(--mut);font-size:13px;border-top:1px dashed var(--line);}
  footer{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);color:var(--mut);font-size:13px;line-height:1.8;}
  footer a{color:var(--accent);}
  code{background:#f0efec;padding:1px 5px;border-radius:4px;font-size:12px;}
  @media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr);}.wgrid,.growth{grid-template-columns:1fr;}.desc,.lang{display:none;}}
</style>
</body>
</html>`;
}

// 仅当以 `node radar.mjs` 直接运行时执行；被 import 时仅导出函数（便于单测）
const isSelf = process.argv[1] && process.argv[1].replace(/^.*\//, "") === "radar.mjs";
export { parseTrending, fetchTrending, renderHtml, main };

if (isSelf) {
  main().catch((e) => { console.error("FATAL", e); process.exit(1); });
}
