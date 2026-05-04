#!/usr/bin/env python3
"""
backup.py — Copy gasshop.db to a timestamped backup file. Keeps last 7.

Usage:
  python backup.py               # manual backup
  # Or add to cron: 0 2 * * * cd /app && python backup.py
"""
import os
import shutil
import glob
import sys
from datetime import datetime

DB_PATH = os.getenv('DATABASE_PATH', 'gasshop.db')
BACKUP_DIR = os.getenv('BACKUP_DIR', 'backups')
KEEP = 7


def main():
    if not os.path.exists(DB_PATH):
        print(f'ERROR: database not found: {DB_PATH}')
        sys.exit(1)

    os.makedirs(BACKUP_DIR, exist_ok=True)

    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    dest = os.path.join(BACKUP_DIR, f'gasshop_{ts}.db')

    shutil.copy2(DB_PATH, dest)
    size_kb = os.path.getsize(dest) // 1024
    print(f'Backup saved: {dest} ({size_kb} KB)')

    # Keep only last KEEP backups
    pattern = os.path.join(BACKUP_DIR, 'gasshop_*.db')
    existing = sorted(glob.glob(pattern))
    while len(existing) > KEEP:
        old = existing.pop(0)
        os.remove(old)
        print(f'Removed old backup: {old}')

    print(f'Backups retained: {len(existing)}')


if __name__ == '__main__':
    main()
