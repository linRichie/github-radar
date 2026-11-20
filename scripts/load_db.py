#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub 雷达 → 仓库内本地 SQLite 落盘

用法：
    python scripts/load_db.py --mode daily
    RADAR_DB=/path/to/custom.sqlite python scripts/load_db.py --mode daily

说明：
- 数据库为仓库内文件 data/backup/github_radar.sqlite（可用 RADAR_DB 覆盖），
  无凭据、无需第三方驱动；CI 写入后由工作流提交回仓库持久化。
- **只增不删（重要）**：本脚本**不执行任何 DELETE**。snapshots 以
  `(run_id, section, domain, column_type, rank_no)` 为唯一键做 UPSERT——同一时点重复导入只会
  更新数值，不会删除既有行；runs / projects 同样只 UPSERT。任何一次历史抓取的数据都完整保留，
  供后续「历史记录 / 趋势回放」功能使用。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# SQLite 方言建表（IF NOT EXISTS 兜底；已迁移库结构完整，不会重建）
DDL = [
    """
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      captured_date TEXT NOT NULL,
      trending_cnt INTEGER NOT NULL DEFAULT 0,
      growth_cnt INTEGER NOT NULL DEFAULT 0,
      topic_cnt INTEGER NOT NULL DEFAULT 0,
      rising_cnt INTEGER NOT NULL DEFAULT 0,
      watch_cnt INTEGER NOT NULL DEFAULT 0,
      enriched_cnt INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'github-actions',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (mode, generated_at)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_date ON runs (captured_date)
    """,
    """
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL DEFAULT '',
      description TEXT,
      desc_zh TEXT NOT NULL DEFAULT '',
      stars INTEGER NOT NULL DEFAULT 0,
      stars_delta INTEGER NOT NULL DEFAULT 0,
      stars_period TEXT NOT NULL DEFAULT '',
      topics TEXT,
      tagline TEXT NOT NULL DEFAULT '',
      core_value TEXT NOT NULL DEFAULT '',
      features TEXT,
      scenarios TEXT,
      inputs TEXT,
      caveats TEXT,
      enriched_at TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (full_name)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_stars ON projects (stars)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_last_seen ON projects (last_seen)
    """,
    """
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      mode TEXT NOT NULL,
      section TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT '',
      column_type TEXT NOT NULL DEFAULT '',
      rank_no INTEGER NOT NULL,
      full_name TEXT NOT NULL,
      stars INTEGER NOT NULL DEFAULT 0,
      stars_delta INTEGER NOT NULL DEFAULT 0,
      lang TEXT NOT NULL DEFAULT '',
      UNIQUE (run_id, section, domain, column_type, rank_no)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_run ON snapshots (run_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_proj_time ON snapshots (full_name, captured_at)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_section_time ON snapshots (mode, section, captured_at)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_domain ON snapshots (domain, column_type, captured_at)
    """,
]


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def bj_date(iso):
    """UTC ISO → 北京日期字符串 YYYY-MM-DD（SQLite TEXT，字典序即时间序）"""
    if not iso:
        return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (dt.astimezone(timezone(timedelta(hours=8)))).strftime("%Y-%m-%d")


def bj_dt(iso):
    """UTC ISO → 北京时间字符串 YYYY-MM-DD HH:MM:SS（SQLite TEXT，抹掉微秒保证回查一致）"""
    if not iso:
        return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return dt.astimezone(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="daily", choices=["daily", "weekly"])
    ap.add_argument("--source", default="github-actions")
    args = ap.parse_args()

    payload = load_json(DATA / f"{args.mode}-latest.json")
    if not payload:
        print(f"! 找不到 data/{args.mode}-latest.json，跳过")
        return 0
    enriched = load_json(DATA / f"enriched-{args.mode}.json", {}) or {}
    zh = (load_json(DATA / "zh-cache.json", {}) or {}).get("zh", {})

    from radar_db import connect, DB_PATH

    conn, is_new = connect()
    try:
        db_label = str(DB_PATH.relative_to(ROOT))
    except ValueError:
        db_label = str(DB_PATH)
    print(f"· SQLite 数据库：{db_label}{'（新建）' if is_new else ''}")
    cur = conn.cursor()
    for ddl in DDL:
        cur.execute(ddl)
    conn.commit()

    gen_at = bj_dt(payload.get("generatedAt"))
    cap_date = bj_date(payload.get("generatedAt"))
    enriched_projects = enriched.get("projects", {}) or {}
    enriched_date = enriched.get("date", "")

    # ---------- runs ----------
    cur.execute(
        """INSERT INTO runs (mode, generated_at, captured_date, trending_cnt, growth_cnt,
                             topic_cnt, rising_cnt, watch_cnt, enriched_cnt, source)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(mode, generated_at) DO UPDATE SET
               trending_cnt=excluded.trending_cnt, growth_cnt=excluded.growth_cnt,
               topic_cnt=excluded.topic_cnt, rising_cnt=excluded.rising_cnt,
               watch_cnt=excluded.watch_cnt, enriched_cnt=excluded.enriched_cnt, source=excluded.source""",
        (
            args.mode, gen_at, cap_date,
            len(payload.get("trending", [])), len(payload.get("growthRank", [])),
            len(payload.get("topicHot", [])), len(payload.get("rising", [])),
            len(payload.get("watch", [])), len(enriched_projects), args.source,
        ),
    )
    cur.execute("SELECT id FROM runs WHERE mode=? AND generated_at=?", (args.mode, gen_at))
    run_id = cur.fetchone()["id"]

    # ---------- projects（四分区 + 领域三栏并集） ----------
    # 每项：(section, domain, column_type, 数组)
    sections = [
        ("trending", "", "", payload.get("trending", [])),
        ("growth", "", "", payload.get("growthRank", [])),
        ("topic_hot", "", "", payload.get("topicHot", [])),
        ("rising", "", "", payload.get("rising", [])),
    ]
    for d in payload.get("domains", []) or []:
        for key in ("skills", "repos", "fresh"):
            sections.append(("domain", d.get("slug", ""), key, d.get(key) or []))

    merged = {}
    for sec, dom, col, arr in sections:
        for i, r in enumerate(arr):
            full = r.get("full")
            if not full:
                continue
            prev = merged.get(full)
            delta = int(r.get("starsToday") or 0)
            if prev is None:
                merged[full] = {
                    "full_name": full,
                    "owner": r.get("owner") or full.split("/")[0],
                    "repo": r.get("name") or full.split("/")[1],
                    "url": r.get("url") or f"https://github.com/{full}",
                    "lang": (r.get("lang") or "")[:50],
                    "description": r.get("desc") or "",
                    "stars": int(r.get("stars") or 0),
                    "stars_delta": delta,
                    "stars_period": (r.get("starsPeriod") or "")[:20],
                    "topics": r.get("topics") or [],
                }
            else:
                prev["stars"] = max(prev["stars"], int(r.get("stars") or 0))
                prev["stars_delta"] = max(prev["stars_delta"], delta)
                if not prev["description"] and r.get("desc"):
                    prev["description"] = r["desc"]
                if not prev["lang"] and r.get("lang"):
                    prev["lang"] = (r["lang"] or "")[:50]

    proj_sql = """INSERT INTO projects
        (full_name, owner, repo, url, lang, description, desc_zh, stars, stars_delta, stars_period,
         topics, first_seen, last_seen)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(full_name) DO UPDATE SET
            owner=excluded.owner, repo=excluded.repo, url=excluded.url, lang=excluded.lang,
            description=excluded.description, desc_zh=excluded.desc_zh, stars=excluded.stars,
            stars_delta=excluded.stars_delta, stars_period=excluded.stars_period,
            topics=excluded.topics, last_seen=excluded.last_seen"""
    enriched_sql = """UPDATE projects SET tagline=?, core_value=?, features=?, scenarios=?,
        inputs=?, caveats=?, enriched_at=? WHERE full_name=?"""

    n_proj = n_enrich = 0
    for full, r in merged.items():
        cur.execute(
            proj_sql,
            (
                r["full_name"], r["owner"], r["repo"], r["url"], r["lang"],
                r["description"][:4000], (zh.get(full) or "")[:600],
                r["stars"], r["stars_delta"], r["stars_period"],
                json.dumps(r["topics"], ensure_ascii=False),
                cap_date, cap_date,
            ),
        )
        n_proj += 1
        e = enriched_projects.get(full)
        if e:
            cur.execute(
                enriched_sql,
                (
                    (e.get("tagline") or "")[:600],
                    (e.get("value") or "")[:600],
                    json.dumps(e.get("features") or [], ensure_ascii=False),
                    json.dumps(e.get("scenarios") or [], ensure_ascii=False),
                    json.dumps(e.get("inputs") or [], ensure_ascii=False),
                    json.dumps(e.get("caveats") or [], ensure_ascii=False),
                    bj_date(enriched_date or payload.get("generatedAt")),
                    full,
                ),
            )
            n_enrich += 1

    # ---------- snapshots（只增不删：唯一键 UPSERT，绝不 DELETE 历史数据） ----------
    snap_sql = """INSERT INTO snapshots
        (run_id, captured_at, mode, section, domain, column_type, rank_no, full_name, stars, stars_delta, lang)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_id, section, domain, column_type, rank_no) DO UPDATE SET
            full_name=excluded.full_name, stars=excluded.stars,
            stars_delta=excluded.stars_delta, lang=excluded.lang, captured_at=excluded.captured_at"""
    rows = []
    for sec, dom, col, arr in sections:
        for i, r in enumerate(arr, 1):
            if not r.get("full"):
                continue
            rows.append(
                (run_id, gen_at, args.mode, sec, dom, col, i, r["full"],
                 int(r.get("stars") or 0), int(r.get("starsToday") or 0), (r.get("lang") or "")[:50])
            )
    if rows:
        cur.executemany(snap_sql, rows)

    conn.commit()

    # ---------- 回读校验 ----------
    cur.execute("SELECT COUNT(*) c FROM projects")
    total_proj = cur.fetchone()["c"]
    cur.execute("SELECT COUNT(*) c FROM projects WHERE enriched_at IS NOT NULL")
    total_enr = cur.fetchone()["c"]
    cur.execute("SELECT COUNT(*) c FROM snapshots WHERE run_id=?", (run_id,))
    total_snap = cur.fetchone()["c"]
    conn.close()

    print(f"✔ 落库完成 run_id={run_id} | 本次项目 {n_proj}（含解读 {n_enrich}）| 快照 {total_snap} 行")
    print(f"  累计：projects {total_proj} 条（其中已解读 {total_enr}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
