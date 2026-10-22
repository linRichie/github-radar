#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GitHub 雷达 → 阿里云 MySQL 落盘

用法：
    MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DB=github_radar \
        python scripts/load_db.py --mode daily

说明：
- 凭据**只从环境变量读取**，脚本本身不含任何密钥（可安全入公开仓库）。
- 幂等：runs 按 (mode, generated_at) 唯一；同一 run 的 snapshots 先删后插；
  projects 按 full_name UPSERT。
- 未设置 MYSQL_HOST 时静默跳过（exit 0），便于在无 Secrets 的环境里跑 CI。
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

DDL = [
    """
    CREATE TABLE IF NOT EXISTS runs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      mode VARCHAR(10) NOT NULL,
      generated_at DATETIME NOT NULL,
      captured_date DATE NOT NULL,
      trending_cnt SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      growth_cnt SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      topic_cnt SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      rising_cnt SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      watch_cnt SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      enriched_cnt SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      source VARCHAR(30) NOT NULL DEFAULT 'github-actions',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_mode_gen (mode, generated_at),
      KEY idx_date (captured_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS projects (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(200) NOT NULL,
      owner VARCHAR(100) NOT NULL DEFAULT '',
      repo VARCHAR(100) NOT NULL DEFAULT '',
      url VARCHAR(300) NOT NULL DEFAULT '',
      lang VARCHAR(50) NOT NULL DEFAULT '',
      description TEXT,
      desc_zh VARCHAR(600) NOT NULL DEFAULT '',
      stars INT UNSIGNED NOT NULL DEFAULT 0,
      stars_delta INT NOT NULL DEFAULT 0,
      stars_period VARCHAR(20) NOT NULL DEFAULT '',
      topics JSON NULL,
      tagline VARCHAR(600) NOT NULL DEFAULT '',
      core_value VARCHAR(600) NOT NULL DEFAULT '',
      features JSON NULL,
      scenarios JSON NULL,
      inputs JSON NULL,
      caveats JSON NULL,
      enriched_at DATE NULL,
      first_seen DATE NOT NULL,
      last_seen DATE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_full (full_name),
      KEY idx_stars (stars),
      KEY idx_last_seen (last_seen)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
    """
    CREATE TABLE IF NOT EXISTS snapshots (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      run_id BIGINT UNSIGNED NOT NULL,
      captured_at DATETIME NOT NULL,
      mode VARCHAR(10) NOT NULL,
      section VARCHAR(20) NOT NULL,
      domain VARCHAR(30) NOT NULL DEFAULT '',
      column_type VARCHAR(20) NOT NULL DEFAULT '',
      rank_no SMALLINT UNSIGNED NOT NULL,
      full_name VARCHAR(200) NOT NULL,
      stars INT UNSIGNED NOT NULL DEFAULT 0,
      stars_delta INT NOT NULL DEFAULT 0,
      lang VARCHAR(50) NOT NULL DEFAULT '',
      KEY idx_run (run_id),
      KEY idx_proj_time (full_name, captured_at),
      KEY idx_section_time (mode, section, captured_at),
      KEY idx_domain (domain, column_type, captured_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """,
]

# 老库升级：给已存在的 snapshots 补领域维度字段（已存在则忽略）
ALTERS = [
    "ALTER TABLE snapshots ADD COLUMN domain VARCHAR(30) NOT NULL DEFAULT '' AFTER section",
    "ALTER TABLE snapshots ADD COLUMN column_type VARCHAR(20) NOT NULL DEFAULT '' AFTER domain",
    "ALTER TABLE snapshots ADD KEY idx_domain (domain, column_type, captured_at)",
]


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def bj_date(iso):
    """UTC ISO → 北京时间的 date 对象"""
    if not iso:
        return datetime.now(timezone(timedelta(hours=8))).date()
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (dt.astimezone(timezone(timedelta(hours=8)))).date()


def bj_dt(iso):
    """UTC ISO → 北京时间 naive datetime（MySQL DATETIME 精度 0，抹掉微秒保证回查一致）"""
    if not iso:
        return datetime.now(timezone(timedelta(hours=8))).replace(tzinfo=None, microsecond=0)
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return dt.astimezone(timezone(timedelta(hours=8))).replace(tzinfo=None, microsecond=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="daily", choices=["daily", "weekly"])
    ap.add_argument("--source", default="github-actions")
    args = ap.parse_args()

    host = os.getenv("MYSQL_HOST")
    if not host:
        print("· 未设置 MYSQL_HOST，跳过落库（本地/无 Secrets 环境）")
        return 0

    payload = load_json(DATA / f"{args.mode}-latest.json")
    if not payload:
        print(f"! 找不到 data/{args.mode}-latest.json，跳过")
        return 0
    enriched = load_json(DATA / f"enriched-{args.mode}.json", {}) or {}
    zh = (load_json(DATA / "zh-cache.json", {}) or {}).get("zh", {})

    try:
        import pymysql
    except ImportError:
        print("! 缺少 pymysql：pip install pymysql")
        return 1

    conn = pymysql.connect(
        host=host,
        port=int(os.getenv("MYSQL_PORT", "3306")),
        user=os.getenv("MYSQL_USER", "root"),
        password=os.getenv("MYSQL_PASSWORD", ""),
        database=os.getenv("MYSQL_DB", "github_radar"),
        charset="utf8mb4",
        connect_timeout=10,
        autocommit=False,
        cursorclass=pymysql.cursors.DictCursor,
    )
    cur = conn.cursor()
    for ddl in DDL:
        cur.execute(ddl)
    for alt in ALTERS:
        try:
            cur.execute(alt)
        except Exception:
            pass  # 字段/索引已存在
    conn.commit()

    gen_at = bj_dt(payload.get("generatedAt"))
    cap_date = bj_date(payload.get("generatedAt"))
    enriched_projects = enriched.get("projects", {}) or {}
    enriched_date = enriched.get("date", "")

    # ---------- runs ----------
    cur.execute(
        """INSERT INTO runs (mode, generated_at, captured_date, trending_cnt, growth_cnt,
                             topic_cnt, rising_cnt, watch_cnt, enriched_cnt, source)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON DUPLICATE KEY UPDATE trending_cnt=VALUES(trending_cnt), growth_cnt=VALUES(growth_cnt),
               topic_cnt=VALUES(topic_cnt), rising_cnt=VALUES(rising_cnt),
               watch_cnt=VALUES(watch_cnt), enriched_cnt=VALUES(enriched_cnt), source=VALUES(source)""",
        (
            args.mode, gen_at, cap_date,
            len(payload.get("trending", [])), len(payload.get("growthRank", [])),
            len(payload.get("topicHot", [])), len(payload.get("rising", [])),
            len(payload.get("watch", [])), len(enriched_projects), args.source,
        ),
    )
    cur.execute("SELECT id FROM runs WHERE mode=%s AND generated_at=%s", (args.mode, gen_at))
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
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
            owner=VALUES(owner), repo=VALUES(repo), url=VALUES(url), lang=VALUES(lang),
            description=VALUES(description), desc_zh=VALUES(desc_zh), stars=VALUES(stars),
            stars_delta=VALUES(stars_delta), stars_period=VALUES(stars_period),
            topics=VALUES(topics), last_seen=VALUES(last_seen)"""
    enriched_sql = """UPDATE projects SET tagline=%s, core_value=%s, features=%s, scenarios=%s,
        inputs=%s, caveats=%s, enriched_at=%s WHERE full_name=%s"""

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

    # ---------- snapshots（先删同一 run 再插，保证幂等） ----------
    cur.execute("DELETE FROM snapshots WHERE run_id=%s", (run_id,))
    snap_sql = """INSERT INTO snapshots
        (run_id, captured_at, mode, section, domain, column_type, rank_no, full_name, stars, stars_delta, lang)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"""
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
    cur.execute("SELECT COUNT(*) c FROM snapshots WHERE run_id=%s", (run_id,))
    total_snap = cur.fetchone()["c"]
    conn.close()

    print(f"✔ 落库完成 run_id={run_id} | 本次项目 {n_proj}（含解读 {n_enrich}）| 快照 {total_snap} 行")
    print(f"  累计：projects {total_proj} 条（其中已解读 {total_enr}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
