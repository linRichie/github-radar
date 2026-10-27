#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""计算生态榜候选项目的「近 N 日 star 增量」，供 radar.mjs --render-only 重排 03 区。

原理：GitHub Search API 不提供 star 历史，但本地库的 snapshots 表按 run 全量留存，
     因此可以用「当前 star - N 天前 star」得到真实涨星速度。

流程（在 load_db.py 之后运行）：
  1. 读 data/<mode>-latest.json 的 topicPool（03 区候选池，含当前 star）
  2. 查 MySQL：窗口内（N 天前 ~ 昨天）每个项目最早的一条 star 作为基准
  3. 输出 data/delta-<mode>.json

用法：
  MYSQL_HOST=... python scripts/delta_rank.py --mode daily [--days 3]
未设置 MYSQL_HOST 时静默跳过（exit 0），不阻断 CI。
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BJ = timezone(timedelta(hours=8))


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["daily", "weekly"], default="daily")
    ap.add_argument("--days", type=int, default=3, help="增量窗口天数（不含今天）")
    args = ap.parse_args()

    if not os.environ.get("MYSQL_HOST"):
        print("· 未配置 MYSQL_HOST，跳过涨星增量计算")
        return 0

    latest_path = os.path.join(ROOT, "data", f"{args.mode}-latest.json")
    payload = load_json(latest_path, {})
    pool = payload.get("topicPool") or payload.get("topicHot") or []
    if not pool:
        print("· latest.json 无 topicPool，跳过")
        return 0

    current = {r["full"]: int(r.get("stars") or 0) for r in pool if r.get("full")}
    names = list(current.keys())
    print(f"· 候选 {len(names)} 个，窗口 {args.days} 天（不含今天）")

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
        read_timeout=30,
    )
    try:
        today = datetime.now(BJ).date()
        window_start = today - timedelta(days=args.days)
        # 基准取「窗口内、今天之前」最早的一条快照
        placeholders = ",".join(["%s"] * len(names))
        sql = f"""
            SELECT s.full_name, s.stars, s.captured_at
            FROM snapshots s
            JOIN (
                SELECT s2.full_name, MIN(s2.captured_at) AS first_at
                FROM snapshots s2
                WHERE s2.full_name IN ({placeholders})
                  AND s2.captured_at >= %s
                  AND s2.captured_at < %s
                  AND s2.section <> 'domain'
                GROUP BY s2.full_name
            ) t ON t.full_name = s.full_name AND t.first_at = s.captured_at
            WHERE s.section <> 'domain'
            GROUP BY s.full_name, s.stars, s.captured_at
        """
        params = names + [f"{window_start} 00:00:00", f"{today} 00:00:00"]
        with conn.cursor() as cur:
            cur.execute(sql, params)
            base = {r["full_name"]: r for r in cur.fetchall()}
    finally:
        conn.close()

    items = []
    for full, stars_now in current.items():
        b = base.get(full)
        if not b:
            continue  # 窗口内无历史基准（首次出现）→ 不参与涨星排序
        then = int(b["stars"] or 0)
        delta = stars_now - then
        if delta <= 0:
            continue
        items.append(
            {
                "full": full,
                "stars": stars_now,
                "stars_then": then,
                "delta": delta,
                "delta_pct": round(delta * 100.0 / then, 1) if then else None,
                "since": b["captured_at"].strftime("%Y-%m-%d %H:%M"),
            }
        )
    items.sort(key=lambda x: -x["delta"])

    out = {
        "generated_at": datetime.now(BJ).isoformat(timespec="seconds"),
        "mode": args.mode,
        "window_days": args.days,
        "window_start": str(window_start),
        "candidates": len(names),
        "matched": len(base),
        "items": items,
    }
    out_path = os.path.join(ROOT, "data", f"delta-{args.mode}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"✔ 涨星增量已写入 {os.path.relpath(out_path, ROOT)}：{len(items)} 个在涨（有基准 {len(base)}/{len(names)}）")
    for x in items[:5]:
        print(f"   +{x['delta']:>6,} ★  {x['full']}  ({x['stars_then']:,} → {x['stars']:,})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
