#!/usr/bin/env node
// radar.mjs —— GitHub 雷达
// 抓取 GitHub 上的「热门排行动态 / 高增长项目 / 有趣的新锐项目 / AI Skills 与 MCP 生态」，
// 生成 data/*.json 与单文件 index.html（全内联、无外部资源、Swiss 数据报风格：白底/黑/瑞士红、人话时间）。
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

// ---------- 渲染（单文件 HTML，全内联，无外部资源 · Swiss 数据报风格：白底/黑/瑞士红）----------
function cut(s, n) {
  s = s || "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function rowTrend(r, i) {
  return `<tr>
      <td class="rk">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a></td>
      <td class="desc">${esc(r.desc)}</td>
      <td class="num">${r.stars.toLocaleString()}</td>
      <td class="inc">▲ +${r.starsToday.toLocaleString()}</td>
      <td class="lang">${esc(r.lang) || "—"}</td>
    </tr>`;
}

function rowGrowth(r, i) {
  return `<tr>
      <td class="rk">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a></td>
      <td class="num">${r.stars.toLocaleString()}</td>
      <td class="inc">▲ +${r.starsToday.toLocaleString()}<span class="per">/${r.starsPeriod === "week" ? "week" : "day"}</span></td>
    </tr>`;
}

function rowTopic(r, i) {
  return `<tr>
      <td class="rk">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a></td>
      <td class="desc">${esc(r.desc)}</td>
      <td class="num">${r.stars.toLocaleString()}</td>
      <td class="lang">${esc(r.lang) || "—"}</td>
    </tr>`;
}

function risingCard(r) {
  return `<a href="${esc(r.url)}" target="_blank" rel="noopener">
      <div class="cname">${esc(r.full)}</div>
      <div class="cdesc">${esc(cut(r.desc, 56))}</div>
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

function renderHtml(p) {
  const badge = p.mode === "weekly" ? "WEEKLY 周报" : "DAILY 日报";
  const periodWord = p.trendPeriod === "weekly" ? "本周" : "今日";
  const trendRows = p.trending.map(rowTrend).join("");
  const growthRows = p.growthRank.map(rowGrowth).join("");
  const topicRows = p.topicHot.map(rowTopic).join("");
  const risingCards = p.rising.map(risingCard).join("");
  const watchRows = p.watch.map(watchRow).join("");
  const top1 = p.growthRank[0];
  const { ymd, hm } = bjParts(p.generatedAt);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23111'/%3E%3Ctext x='34' y='45' font-family='Helvetica,Arial,sans-serif' font-size='36' font-weight='900' fill='%23fff' text-anchor='middle'%3ER%3C/text%3E%3Ccircle cx='47' cy='17' r='5' fill='%23E30613'/%3E%3C/svg%3E">
<title>GitHub 雷达 · ${badge}</title>
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
  <div class="metrics">
    <div class="metric"><div class="k">${periodWord}热榜</div><div class="v">${p.counts.trending}<em>repos</em></div></div>
    <div class="metric hot"><div class="k">高增长 Top 1</div><div class="v">${top1 ? "+" + top1.starsToday.toLocaleString() : "—"}<em>/${top1 ? (top1.starsPeriod === "week" ? "week" : "day") : ""}</em></div></div>
    <div class="metric"><div class="k">生态热榜</div><div class="v">${p.counts.topicHot}<em>repos</em></div></div>
    <div class="metric"><div class="k">新锐项目</div><div class="v">${p.counts.rising}<em>new</em></div></div>
  </div>
  <section>
    <h2><span class="no">01</span>GitHub ${periodWord}热榜<span class="en">Trending</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th class="r">star</th><th class="r">${periodWord}增量</th><th>语言</th></tr></thead>
      <tbody>${trendRows || `<tr><td colspan="6" class="empty">本周期未抓取到热榜数据</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2><span class="no">02</span>高增长排行<span class="en">Growth</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th class="r">总 star</th><th class="r">增量</th></tr></thead>
      <tbody>${growthRows || `<tr><td colspan="4" class="empty">本周期无热榜增量数据</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2><span class="no">03</span>AI / Skills / MCP 生态热榜<span class="en">Ecosystem</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th class="r">star</th><th>语言</th></tr></thead>
      <tbody>${topicRows || `<tr><td colspan="5" class="empty">本周期未检索到符合条件的项目</td></tr>`}</tbody>
    </table>
  </section>
  <section>
    <h2><span class="no">04</span>新锐项目<span class="en">Rising</span></h2>
    <div class="cards">${risingCards || `<div class="empty">本周期未检索到新锐项目</div>`}</div>
  </section>
  <section>
    <h2><span class="no">05</span>生态 watch 动态<span class="en">Watchlist</span></h2>
    <table>
      <thead><tr><th>仓库</th><th>最新 release</th><th>最近提交</th></tr></thead>
      <tbody>${watchRows || `<tr><td colspan="3" class="empty">本周期无 watch 数据</td></tr>`}</tbody>
    </table>
  </section>
  <footer>
    <span>数据来源：GitHub Trending / GitHub API · radar.mjs 自动抓取 · 窗口 ${p.windowDays} 天（自 ${p.since}）</span>
    <a href="${PAGE}" target="_blank" rel="noopener">${PAGE} ↗</a>
  </footer>
</div>
<style>
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
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:3px solid #111}
  .metric{padding:18px 22px;border-right:1px solid #ddd}
  .metric:last-child{border-right:none}
  .metric .k{font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:#666;font-weight:700}
  .metric .v{font-size:36px;font-weight:900;letter-spacing:-.03em;margin-top:4px;font-variant-numeric:tabular-nums;line-height:1}
  .metric .v em{font-style:normal;font-size:12px;font-weight:700;color:#666;margin-left:4px;letter-spacing:0}
  .metric.hot .v{color:#e30613}
  section{padding:24px 36px;border-bottom:1px solid #111}
  section:last-of-type{border-bottom:3px solid #111}
  h2{font-size:15px;font-weight:900;letter-spacing:.02em;margin-bottom:14px;display:flex;align-items:baseline;gap:12px}
  h2 .no{color:#e30613;font-size:13px;font-weight:900;font-variant-numeric:tabular-nums}
  h2 .en{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#6b6b6b;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#666;font-weight:700;padding:5px 10px 7px;border-bottom:1px solid #111}
  th.r{text-align:right}
  td{padding:8px 10px;border-bottom:1px solid #e4e4e4;vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  .rk{font-weight:900;font-size:15px;font-variant-numeric:tabular-nums;width:32px;color:#111}
  tbody tr:nth-child(-n+3) .rk{color:#e30613}
  .repo a{color:#111;text-decoration:none;font-weight:700;border-bottom:1px solid #111}
  .repo a:hover{background:#e30613;color:#fff;border-color:#e30613}
  .desc{color:#555}
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
  footer{padding:16px 36px;display:flex;justify-content:space-between;font-size:11px;color:#666;letter-spacing:.04em}
  footer a{color:#111;font-weight:700}
  @media(max-width:760px){.metrics{grid-template-columns:repeat(2,1fr)}.cards{grid-template-columns:1fr}.cards a{border-right:none}.mh-left h1{font-size:32px}.masthead{flex-direction:column;gap:14px}.mh-right{text-align:left}.desc,.lang{display:none}table{display:block;overflow-x:auto}.repo a{word-break:break-all}}
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
