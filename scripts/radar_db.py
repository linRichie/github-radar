#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""雷达统一数据库入口：仓库内本地 SQLite（不再依赖云端 MySQL）。

用法：
    from radar_db import connect, DB_PATH

数据库文件默认 <repo>/data/backup/github_radar.sqlite，可用环境变量
RADAR_DB 覆盖（绝对路径或相对仓库根的路径）。SQLite 为文件数据库，
无任何凭据；CI 写入后由工作流的 git add/commit 持久化回仓库。
"""
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("RADAR_DB", "data/backup/github_radar.sqlite"))
if not DB_PATH.is_absolute():
    DB_PATH = ROOT / DB_PATH


def connect():
    """打开 SQLite 连接；返回 (conn, is_new)。row_factory 支持 dict 式访问。"""
    is_new = not DB_PATH.exists()
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    # 使用默认 DELETE journal：事务提交即落主文件，不产生 -wal/-shm 残留，
    # 便于 git 对单一 .sqlite 文件做版本化（CI 写入后直接提交该文件）。
    return conn, is_new
