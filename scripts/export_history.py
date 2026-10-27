#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""导出历史查询所需的静态数据（供 history.html 使用）。

输出三份数据：
  1. data/history/daily/<date>.json   —— 每天「最后一次抓取」的完整榜单（永久保留，单份约 10KB）
  2. data/history-trend.json          —— 出现 ≥2 天的项目曲线，最近 90 天（每天重写，约 200KB）
  3. data/history/index.json          —— 可用日期列表 + 当天项目数

设计要点：
  - 同一天多次抓取时，取「当天最后一次快照」的 star/rank（最接近当天收盘状态，不取最大值以免虚高）
  - 项目分区（section）单独去重聚合，避免同天跨分区时只留一个
  - 数据库始终全量保留，本脚本只生成「站点导出视图」，不删除任何 DB 数据

用法：MYSQL_HOST=... python scripts/export_history.py [--days 90]
未设置 MYSQL_HOST 时静默跳过（exit 0），不阻断 CI。
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BJ = timezone(timedelta(hours=8))

SECTION_ORDER = ["trending", "growth", "topic_hot", "rising"]


def ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def dump(path, obj, indent=None):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=indent, separators=(",", ":") if not indent else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90, help="趋势文件保留窗口（天）")
    args = ap.parse_args()

    if not os.environ.get("MYSQL_HOST"):
        print("· 未配置 MYSQL_HOST，跳过历史导出")
        return 0

    import pymysql

    conn = pymysql.connect(
        host=os.environ["MYSQL_HOST"],
        port=int(os.environ.get("MYSQL_PORT", 3306)),
        user=os.environ["MYSQL_USER"],
        password=os.environ["MYSQL_PASSWORD"],
        database=os.environ.get("MYSQL_DB", "github_radar"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=10,
        read_timeout=60,
    )

    try:
        cur = conn.cursor()

        # ---------- 中文简介映射 ----------
        cur.execute("SELECT full_name, desc_zh FROM projects")
        zh = {r["full_name"]: r["desc_zh"] or "" for r in cur.fetchall()}

        # ---------- 1) 每天最后一次抓取的完整榜单 ----------
        cur.execute(
            """
            SELECT DATE(r.generated_at) d, r.id, r.generated_at
            FROM runs r
            JOIN (SELECT DATE(generated_at) dd, MAX(generated_at) mx FROM runs GROUP BY DATE(generated_at)) t
              ON t.dd = DATE(r.generated_at) AND t.mx = r.generated_at
            ORDER BY r.generated_at
            """
        )
        last_runs = cur.fetchall()

        daily_dir = os.path.join(ROOT, "data", "history", "daily")
        ensure_dir(daily_dir)
        index_dates = []
        written = 0

        for lr in last_runs:
            date_str = lr["d"].strftime("%Y-%m-%d")
            cur.execute(
                """
                SELECT section, domain, column_type, rank_no, full_name, stars, stars_delta, lang
                FROM snapshots WHERE run_id=%s
                ORDER BY section, domain, column_type, rank_no
                """,
                (lr["id"],),
            )
            rows = cur.fetchall()
            if not rows:
                continue

            sections = defaultdict(list)
            domain = defaultdict(lambda: defaultdict(list))
            for r in rows:
                item = {
                    "r": r["rank_no"],
                    "f": r["full_name"],
                    "s": int(r["stars"] or 0),
                    "l": r["lang"] or "",
                }
                d = (zh.get(r["full_name"]) or "")[:70]
                if d:
                    item["d"] = d
                if r["section"] == "domain":
                    domain[r["domain"]][r["column_type"]].append(item)
                else:
                    sections[r["section"]].append(item)

            payload = {
                "date": date_str,
                "at": lr["generated_at"].strftime("%H:%M"),
                "sections": {k: sections.get(k, []) for k in SECTION_ORDER},
                "domains": {k: dict(v) for k, v in domain.items()},
            }
            dump(os.path.join(daily_dir, f"{date_str}.json"), payload)
            total = sum(len(v) for v in sections.values()) + sum(
                len(x) for v in domain.values() for x in v.values()
            )
            index_dates.append({"d": date_str, "n": total, "t": lr["generated_at"].strftime("%H:%M")})
            written += 1

        # ---------- 2) 趋势文件（出现 ≥2 天的项目，最近 N 天） ----------
        cutoff = (datetime.now(BJ) - timedelta(days=args.days)).date()
        cur.execute(
            """
            SELECT s.full_name, DATE(s.captured_at) d, s.stars, s.stars_delta, s.rank_no, s.captured_at
            FROM snapshots s
            WHERE s.captured_at >= %s
            ORDER BY s.full_name, s.captured_at
            """,
            (f"{cutoff} 00:00:00",),
        )
        raw = cur.fetchall()

        # 同一天同项目：保留当天最后一条（按 captured_at 升序遍历，后者覆盖前者）
        per_proj = defaultdict(dict)
        for r in raw:
            d = r["d"].strftime("%Y-%m-%d")
            per_proj[r["full_name"]][d] = {
                "s": int(r["stars"] or 0),
                "r": int(r["rank_no"] or 0),
            }

        # 分区归属（单独聚合，同天跨分区都能记下）
        cur.execute(
            """
            SELECT s.full_name, s.section, s.domain, COUNT(*) n
            FROM snapshots s WHERE s.captured_at >= %s
            GROUP BY s.full_name, s.section, s.domain
            """,
            (f"{cutoff} 00:00:00",),
        )
        sec_map = defaultdict(set)
        for r in cur.fetchall():
            label = r["section"] if r["section"] != "domain" else f"domain:{r['domain']}"
            sec_map[r["full_name"]].add(label)

        projects = []
        for full, days_map in per_proj.items():
            if len(days_map) < 2:
                continue  # 只出现 1 天 → 画不出趋势
            ds = sorted(days_map.keys())
            series = [{"d": d, "s": days_map[d]["s"], "r": days_map[d]["r"]} for d in ds]
            first_s = series[0]["s"]
            last_s = series[-1]["s"]
            projects.append(
                {
                    "f": full,
                    "d": (zh.get(full) or "")[:80],
                    "n": len(ds),
                    "a": ds[0],
                    "b": ds[-1],
                    "s": last_s,
                    "g": last_s - first_s,
                    "p": round((last_s - first_s) * 100.0 / first_s, 1) if first_s else 0,
                    "br": min(x["r"] for x in series if x["r"]),
                    "wr": max(x["r"] for x in series if x["r"]),
                    "sec": sorted(sec_map.get(full, set())),
                    "x": series,
                }
            )
        projects.sort(key=lambda x: -x["g"])

        trend = {
            "updated": datetime.now(BJ).isoformat(timespec="seconds"),
            "window_days": args.days,
            "since": str(cutoff),
            "count": len(projects),
            "projects": projects,
        }
        dump(os.path.join(ROOT, "data", "history-trend.json"), trend)

        # ---------- 3) 日期索引 ----------
        index_dates.sort(key=lambda x: x["d"], reverse=True)
        dump(
            os.path.join(ROOT, "data", "history", "index.json"),
            {"updated": datetime.now(BJ).isoformat(timespec="seconds"), "dates": index_dates},
        )

        print(f"✔ 历史导出完成：回放 {written} 天（{daily_dir}）| 趋势 {len(projects)} 个项目（≥2 天）")
        if projects:
            print("   趋势 Top3：" + " · ".join(f"{p['f']} {p['g']:+d}★" for p in projects[:3]))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
