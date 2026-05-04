#!/usr/bin/env python3
"""
inspect_db.py — Print all tables, row counts, and sample rows from gasshop.db

Usage:
  python inspect_db.py
  python inspect_db.py orders          # show only orders table
  python inspect_db.py --sample 5      # show 5 sample rows per table
"""
import sys
import sqlite3
import os

DB_PATH = os.getenv('DATABASE_PATH', 'gasshop.db')
DEFAULT_SAMPLE = 3


def main():
    if not os.path.exists(DB_PATH):
        print(f'Database not found: {DB_PATH}')
        sys.exit(1)

    filter_table = None
    sample_n = DEFAULT_SAMPLE
    args = sys.argv[1:]

    for i, arg in enumerate(args):
        if arg == '--sample' and i + 1 < len(args):
            sample_n = int(args[i + 1])
        elif not arg.startswith('--'):
            filter_table = arg.lower()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    tables = [
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    ]

    if filter_table:
        tables = [t for t in tables if filter_table in t.lower()]

    print(f'Database: {DB_PATH}')
    print(f'Tables: {len(tables)}\n')
    print('=' * 60)

    for table in tables:
        count = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        print(f'\n📋 {table}  ({count} rows)')
        print('-' * 40)

        if count == 0:
            print('  (empty)')
            continue

        rows = conn.execute(f'SELECT * FROM "{table}" LIMIT {sample_n}').fetchall()
        if not rows:
            continue

        cols = rows[0].keys()
        col_widths = {c: max(len(c), 10) for c in cols}
        for row in rows:
            for c in cols:
                val = str(row[c] or '')
                col_widths[c] = min(max(col_widths[c], len(val)), 30)

        header = '  ' + ' | '.join(c.ljust(col_widths[c]) for c in cols)
        print(header)
        print('  ' + '-+-'.join('-' * col_widths[c] for c in cols))

        for row in rows:
            line = '  ' + ' | '.join(str(row[c] or '').ljust(col_widths[c])[:col_widths[c]] for c in cols)
            print(line)

        if count > sample_n:
            print(f'  ... ({count - sample_n} more rows)')

    print('\n' + '=' * 60)
    conn.close()


if __name__ == '__main__':
    main()
