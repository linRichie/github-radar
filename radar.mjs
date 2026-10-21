#!/usr/bin/env node
// radar.mjs —— Skills / MCP 生态雷达
// 抓取 GitHub 上的 skills/MCP 生态更新，生成 data/*.json 与单文件 index.html（全内联、无外部资源）。
// 用法：node radar.mjs --mode daily | weekly   （可选 GITHUB_TOKEN 提升速率上限）

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN || "";
const ACCENT = "#E8552D";

// 重点追踪的 skills / MCP 生态仓库
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

// 热门项目检索主题（GitHub topic）
const TOPICS = ["mcp", "agent-skills", "claude-skills", "ai-agents", "llm", "claude-code"];

const MODE = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "daily";
const IS_WEEKLY = MODE === "weekly";
const DAYS = IS_WEEKLY ? 7 : 2;
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- 工具 ----------
async function gh(path) {
  const res = await fetch(API + path, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "skills-mcp-radar",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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

// ---------- 抓取 ----------
function normRepo(r) {
  return {
    full: r.full_name,
    name: r.name,
    owner: r.owner?.login || r.full_name.split("/")[0],
    desc: r.description || "",
    stars: r.stargazers_count || 0,
    lang: r.language || "",
    url: r.html_url,
    pushed: r.pushed_at,
    updated: r.updated_at,
    topics: r.topics || [],
  };
}

async function searchTopic(topic) {
  const q = encodeURIComponent(`topic:${topic} pushed:>=${SINCE}`);
  const data = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=15`);
  return (data.items || []).map(normRepo);
}

async function watchRepo(repo) {
  const [rels, commits] = await Promise.all([
    gh(`/repos/${repo}/releases?per_page=3`).catch(() => []),
    gh(`/repos/${repo}/commits?since=${SINCE}T00:00:00Z&per_page=12`).catch(() => []),
  ]);
  return {
    repo,
    url: `https://github.com/${repo}`,
    latestRelease: rels[0] ? { tag: rels[0].tag_name, date: rels[0].published_at, url: rels[0].html_url } : null,
    commits: commits.map((c) => ({
      msg: c.commit.message.split("\n")[0].slice(0, 90),
      date: c.commit.author?.date,
      url: c.html_url,
      author: c.author?.login || c.commit.author?.name || "",
    })),
  };
}

async function main() {
  console.log(`▶ 模式=${MODE} 窗口=${DAYS}天 自=${SINCE}`);
  const [topicGroups, watch] = await Promise.all([
    Promise.all(TOPICS.map((t) => searchTopic(t).catch((e) => { console.warn(`  ! topic ${t}: ${e.message}`); return []; }))),
    Promise.all(WATCH.map((r) => watchRepo(r).catch((e) => { console.warn(`  ! watch ${r}: ${e.message}`); return { repo: r, error: e.message, commits: [] }; }))),
  ]);

  // 热门去重（同一仓库可能命中多个 topic），按 star 排序
  const byFull = new Map();
  for (const g of topicGroups) for (const r of g) if (!byFull.has(r.full) || byFull.get(r.full).stars < r.stars) byFull.set(r.full, r);
  const trending = [...byFull.values()].sort((a, b) => b.stars - a.stars).slice(0, IS_WEEKLY ? 20 : 12);

  // 有更新的 watch 仓库
  const activeWatch = watch.filter((w) => (w.latestRelease || (w.commits && w.commits.length)));

  const payload = {
    mode: MODE,
    generatedAt: new Date().toISOString(),
    windowDays: DAYS,
    since: SINCE,
    sources: { topics: TOPICS, watch: WATCH },
    trending,
    watch,
    activeWatchCount: activeWatch.length,
  };

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data", `${MODE}-${TODAY}.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(ROOT, "data", `${MODE}-latest.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(ROOT, "index.html"), renderHtml(payload));

  console.log(`✔ 热门 ${trending.length} 项 | 生态活跃仓库 ${activeWatch.length}/${WATCH.length}`);
  console.log("—— 本周/本日 Top5 ——");
  trending.slice(0, 5).forEach((r, i) => console.log(`  ${i + 1}. ${r.full} ⭐${r.stars} · ${r.desc.slice(0, 60)}`));
  return payload;
}

// ---------- 渲染（单文件 HTML，全内联，无外部资源）----------
function renderHtml(p) {
  const badge = p.mode === "weekly" ? "周报" : "日报";
  const trendRows = p.trending.map((r, i) => `
    <tr>
      <td class="idx">${i + 1}</td>
      <td class="repo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.full)}</a>${r.topics.length ? `<span class="topics">${r.topics.slice(0, 4).map((t) => `#${esc(t)}`).join(" ")}</span>` : ""}</td>
      <td class="desc">${esc(r.desc)}</td>
      <td class="num">⭐ ${r.stars.toLocaleString()}</td>
      <td class="lang">${esc(r.lang)}</td>
      <td class="time">${human(r.pushed)}</td>
    </tr>`).join("");

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
<title>Skills / MCP 生态雷达 · ${badge}</title>
</head>
<body>
<div class="wrap">
  <header>
    <div class="t1">Skills / MCP 生态雷达</div>
    <div class="t2">持续追踪 AI Skills 与 MCP 工具链的开源动态</div>
    <div class="meta"><span class="badge">${badge}</span> 更新于 ${fmtFull(p.generatedAt)} · 窗口 ${p.windowDays} 天（自 ${p.since}）</div>
  </header>

  <section class="cards">
    <div class="card"><div class="cv">${p.trending.length}</div><div class="ck">新晋热门项目</div></div>
    <div class="card"><div class="cv">${p.activeWatchCount}/${p.watch.length}</div><div class="ck">生态活跃仓库</div></div>
    <div class="card"><div class="cv">${p.sources.topics.length}</div><div class="ck">检索主题</div></div>
    <div class="card"><div class="cv">${p.sources.watch.length}</div><div class="ck">重点追踪仓库</div></div>
  </section>

  <section>
    <h2>新晋热门项目 <span class="sub">（按 star 排序）</span></h2>
    <table>
      <thead><tr><th>#</th><th>仓库</th><th>简介</th><th>star</th><th>语言</th><th>更新</th></tr></thead>
      <tbody>${trendRows || `<tr><td colspan="6" class="empty">本周期未检索到符合条件的项目</td></tr>`}</tbody>
    </table>
  </section>

  <section>
    <h2>生态 watch 动态 <span class="sub">（${p.sources.watch.length} 个重点仓库）</span></h2>
    <div class="wgrid">${watchBlocks}</div>
  </section>

  <footer>
    <div>数据来源：GitHub Search API（topic 过滤）+ 各重点仓库 releases / commits。</div>
    <div>由 <code>radar.mjs</code> 自动生成 · 公网页面 <a href="https://skills.moniter.top" target="_blank" rel="noopener">skills.moniter.top</a> · 每日 / 每周自动更新并邮件推送。</div>
  </footer>
</div>
<style>
  :root{ --accent:${ACCENT}; --ink:#2c2c2a; --mut:#6b6b66; --line:#ececea; --bg:#faf9f7; --card:#fff; }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}
  .wrap{max-width:980px;margin:0 auto;padding:28px 20px 56px;}
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
  .lang{color:var(--mut);white-space:nowrap;}
  .time{color:var(--mut);white-space:nowrap;font-size:13px;}
  .empty{text-align:center;color:var(--mut);padding:24px;}
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
  @media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr);}.wgrid{grid-template-columns:1fr;}.desc,.lang{display:none;}}
</style>
</body>
</html>`;
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
