#!/usr/bin/env python3
"""
import_from_sheets.py — Import historical data from Google Sheets CSV export.

Usage:
  python import_from_sheets.py [CSV_FILE] --dry-run   # Validate only, show issues
  python import_from_sheets.py [CSV_FILE] --confirm   # Run full 6-step import

CSV columns expected (from Google Sheets export):
  date, type, bill_no, customer_name, customer_phone,
  product_name, qty, price_per_unit, total, payment_method,
  note, driver_name, expense_category, expense_amount, vat_type

Exit codes:
  0 = success
  1 = validation errors found (dry-run) or import failed
"""
import sys
import csv
import os
import uuid
import difflib
import sqlite3
import logging
from datetime import datetime, timezone, timedelta

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')

DB_PATH = os.getenv('DATABASE_PATH', 'gasshop.db')
BKK     = timezone(timedelta(hours=7))

# ─── Opening stock (full tanks) on import day ────────────────────────────────
OPENING_STOCK = {
    'PTT 4 กก.':  211,
    'PTT 7 กก.':  30,
    'PTT 15 กก.': 152,
    'PTT 48 กก.': 45,
}

# ─── Product name normalisation (CSV variant → canonical DB name) ─────────────
PRODUCT_MAP = {
    # PTT 4 kg
    'ปตท 4': 'PTT 4 กก.',
    'ปตท. 4': 'PTT 4 กก.',
    'PTT 4': 'PTT 4 กก.',
    'ptt4': 'PTT 4 กก.',
    # PTT 7 kg
    'ปตท 7': 'PTT 7 กก.',
    'ปตท. 7': 'PTT 7 กก.',
    'PTT 7': 'PTT 7 กก.',
    'ptt7': 'PTT 7 กก.',
    # PTT 15 kg
    'ปตท 15': 'PTT 15 กก.',
    'ปตท. 15': 'PTT 15 กก.',
    'PTT 15': 'PTT 15 กก.',
    'ptt15': 'PTT 15 กก.',
    'แก๊ส 15': 'PTT 15 กก.',
    # PTT 48 kg
    'ปตท 48': 'PTT 48 กก.',
    'ปตท. 48': 'PTT 48 กก.',
    'PTT 48': 'PTT 48 กก.',
    'ptt48': 'PTT 48 กก.',
    'ถัง 48': 'PTT 48 กก.',
    # Shell / others
    'shell 15': 'Shell 15 กก.',
    'เชลล์ 15': 'Shell 15 กก.',
    'shell15': 'Shell 15 กก.',
}

# Row types that count as sales orders
ORDER_TYPES  = {'ขาย', 'sale', 'order', 'sell'}
# Row types that count as purchases/restock
RESTOCK_TYPES = {'ซื้อ', 'purchase', 'restock', 'buy'}
# Row types that count as expenses
EXPENSE_TYPES = {'ค่าใช้จ่าย', 'expense', 'exp'}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    conn.execute('PRAGMA journal_mode = WAL')
    return conn


def bkk_now():
    return datetime.now(BKK).strftime('%Y-%m-%d %H:%M:%S')


def new_id():
    return str(uuid.uuid4())


def normalise_product(raw: str) -> str:
    """Return canonical product name from CSV raw string, or raw if no mapping."""
    s = (raw or '').strip()
    if s in PRODUCT_MAP:
        return PRODUCT_MAP[s]
    # try case-insensitive key lookup
    slow = s.lower().strip()
    for k, v in PRODUCT_MAP.items():
        if k.lower() == slow:
            return v
    return s


def fuzzy_customer(db, name: str):
    """Return (best_match_name, score) from existing customers or (None, 0)."""
    rows = db.execute("SELECT name FROM customers").fetchall()
    names = [r['name'] for r in rows]
    if not names:
        return None, 0.0
    matches = difflib.get_close_matches(name, names, n=1, cutoff=0.75)
    if matches:
        score = difflib.SequenceMatcher(None, name, matches[0]).ratio()
        return matches[0], score
    return None, 0.0


def parse_float(val, default=0.0):
    try:
        return float(str(val).replace(',', '').strip() or default)
    except (ValueError, TypeError):
        return default


def parse_int(val, default=0):
    try:
        return int(str(val).replace(',', '').strip() or default)
    except (ValueError, TypeError):
        return default


def parse_date(val: str) -> str:
    """Parse date string to YYYY-MM-DD, best effort."""
    s = (val or '').strip()
    for fmt in ('%d/%m/%Y', '%Y-%m-%d', '%d-%m-%Y', '%d/%m/%y'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return s  # return as-is if unrecognised


# ─── Issue tracker ────────────────────────────────────────────────────────────

class Issue:
    def __init__(self, level: str, row: int, msg: str):
        self.level = level  # ERROR | WARNING | INFO
        self.row   = row
        self.msg   = msg

    def __str__(self):
        return f'{self.level:<8} row {self.row:>4}: {self.msg}'


# ─── Validation ───────────────────────────────────────────────────────────────

def load_csv(csv_path: str):
    with open(csv_path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    return rows


def validate(rows: list, db=None) -> list:
    issues = []
    bill_type_map = {}   # bill_no → first type seen

    for i, row in enumerate(rows, 2):  # row 1 = header
        row_type     = (row.get('type') or '').strip().lower()
        bill_no      = (row.get('bill_no') or '').strip()
        product_raw  = (row.get('product_name') or '').strip()
        qty_raw      = (row.get('qty') or '').strip()
        price_raw    = (row.get('price_per_unit') or '').strip()
        total_raw    = (row.get('total') or '').strip()
        cust_name    = (row.get('customer_name') or '').strip()

        # Skip completely blank rows
        if not row_type and not bill_no and not product_raw:
            continue

        # Determine normalised type
        if row_type in ORDER_TYPES:
            norm_type = 'sale'
        elif row_type in RESTOCK_TYPES:
            norm_type = 'restock'
        elif row_type in EXPENSE_TYPES:
            norm_type = 'expense'
        else:
            issues.append(Issue('ERROR', i, f'Unknown type "{row_type}" — expected ขาย/ซื้อ/ค่าใช้จ่าย'))
            continue

        # Duplicate bill with different type
        if bill_no:
            if bill_no in bill_type_map:
                if bill_type_map[bill_no] != norm_type:
                    issues.append(Issue('ERROR', i,
                        f'Bill {bill_no} already seen as "{bill_type_map[bill_no]}" but this row is "{norm_type}"'))
            else:
                bill_type_map[bill_no] = norm_type

        if norm_type in ('sale', 'restock'):
            qty   = parse_int(qty_raw)
            price = parse_float(price_raw)

            # qty = 0 with items listed
            if product_raw and qty == 0:
                issues.append(Issue('ERROR', i, f'Product "{product_raw}" has qty=0'))

            # price = 0 with items listed
            if product_raw and price == 0 and norm_type == 'sale':
                issues.append(Issue('ERROR', i, f'Product "{product_raw}" has price=0 (sale row)'))

            # Product name mapping applied
            canonical = normalise_product(product_raw)
            if canonical != product_raw and product_raw:
                issues.append(Issue('INFO', i,
                    f'Product "{product_raw}" mapped → "{canonical}"'))

        # Fuzzy customer name match
        if cust_name and db:
            match, score = fuzzy_customer(db, cust_name)
            if match and match != cust_name and score > 0.80:
                issues.append(Issue('WARNING', i,
                    f'Customer "{cust_name}" is {score:.0%} similar to existing "{match}"'))

    return issues


# ─── Import steps ─────────────────────────────────────────────────────────────

def step1_opening_stock(db):
    """Insert opening stock (full tanks) for known products."""
    logging.info('Step 1: Opening stock')
    count = 0
    for name, qty in OPENING_STOCK.items():
        prod = db.execute("SELECT id FROM products WHERE name=?", (name,)).fetchone()
        if not prod:
            logging.warning(f'  Product "{name}" not in DB — skip')
            continue
        pid = prod['id']
        existing = db.execute("SELECT product_id FROM tank_stock WHERE product_id=?", (pid,)).fetchone()
        if existing:
            db.execute("UPDATE tank_stock SET full_qty=? WHERE product_id=?", (qty, pid))
        else:
            db.execute(
                "INSERT INTO tank_stock (product_id, full_qty, empty_qty, customer_qty) VALUES (?,?,0,0)",
                (pid, qty)
            )
        logging.info(f'  {name}: full_qty={qty}')
        count += 1
    return count


def step2_customers(db, rows):
    """Upsert customers from sale rows."""
    logging.info('Step 2: Customers')
    seen   = set()
    count  = 0
    now    = bkk_now()

    for row in rows:
        row_type = (row.get('type') or '').strip().lower()
        if row_type not in ORDER_TYPES:
            continue
        phone = (row.get('customer_phone') or '').strip()
        name  = (row.get('customer_name') or '').strip()
        if not phone or not name:
            continue
        if phone in seen:
            continue
        seen.add(phone)

        existing = db.execute("SELECT id FROM customers WHERE phone=?", (phone,)).fetchone()
        if existing:
            continue

        cust_id = new_id()
        db.execute(
            """INSERT INTO customers
               (id,name,phone,address,lat,lng,tier,lang,
                credit_limit,credit_days,credit_bal,
                need_invoice,tax_id,total_orders,total_spent,
                last_order_items,created_at)
               VALUES (?,?,?,?,?,?,?,?,0,30,0,'no','',0,0,'[]',?)""",
            (cust_id, name, phone, '', None, None, 'retail', 'th', now)
        )
        count += 1

    logging.info(f'  {count} customers inserted')
    return count


def step3_products(db, rows):
    """Upsert products from restock/sale rows."""
    logging.info('Step 3: Products')
    seen  = set()
    count = 0
    now   = bkk_now()

    for row in rows:
        product_raw = (row.get('product_name') or '').strip()
        if not product_raw:
            continue
        canonical = normalise_product(product_raw)
        if canonical in seen:
            continue
        seen.add(canonical)

        existing = db.execute("SELECT id FROM products WHERE name=?", (canonical,)).fetchone()
        if existing:
            continue

        price = parse_float(row.get('price_per_unit'))
        if not price:
            price = parse_float(row.get('total', 0)) / max(parse_int(row.get('qty', 1)), 1)

        # Guess size_kg from name
        size_kg = 0.0
        for part in canonical.split():
            try:
                size_kg = float(part)
                break
            except ValueError:
                continue

        pid = new_id()
        db.execute(
            """INSERT INTO products
               (id,brand,name,name_en,ico,image_url,size_kg,
                price,price_transfer,cost,status,sort_order,
                reorder_point,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,99,0,?)""",
            (pid, '', canonical, '', '🔴', '', size_kg,
             price, price, 0.0, 'available', now)
        )
        # Ensure tank_stock row exists
        db.execute(
            "INSERT OR IGNORE INTO tank_stock (product_id,full_qty,empty_qty,customer_qty) VALUES (?,0,0,0)",
            (pid,)
        )
        count += 1

    logging.info(f'  {count} products inserted')
    return count


def step4_orders_expenses(db, rows):
    """Import sale rows as orders and expense rows."""
    logging.info('Step 4: Orders and expenses')
    order_count   = 0
    expense_count = 0
    now           = bkk_now()

    # Build order_num from bill_no or generate
    existing_bills = set()

    for row in rows:
        row_type = (row.get('type') or '').strip().lower()
        date_raw = (row.get('date') or '').strip()
        date_str = parse_date(date_raw) if date_raw else now[:10]

        if row_type in ORDER_TYPES:
            phone    = (row.get('customer_phone') or '').strip()
            name     = (row.get('customer_name') or '').strip()
            bill_no  = (row.get('bill_no') or '').strip()
            prod_raw = (row.get('product_name') or '').strip()
            qty      = parse_int(row.get('qty', 0))
            price    = parse_float(row.get('price_per_unit', 0))
            total    = parse_float(row.get('total', 0))
            method   = (row.get('payment_method') or 'เงินสด').strip() or 'เงินสด'
            note     = (row.get('note') or '').strip()
            driver   = (row.get('driver_name') or '').strip()

            if not total and qty and price:
                total = qty * price

            canonical = normalise_product(prod_raw) if prod_raw else ''

            # Use bill_no as order_num if unique
            order_num = bill_no if bill_no and bill_no not in existing_bills else new_id()[:8].upper()
            existing_bills.add(order_num)

            # Resolve customer_id
            cust_row = db.execute("SELECT id FROM customers WHERE phone=?", (phone,)).fetchone()
            cust_id  = cust_row['id'] if cust_row else ''

            items_json = '[]'
            items_summary = ''
            if canonical and qty:
                prod_row = db.execute("SELECT id FROM products WHERE name=?", (canonical,)).fetchone()
                if prod_row:
                    import json
                    items = [{'product_id': prod_row['id'], 'name': canonical, 'qty': qty, 'price': price}]
                    items_json    = json.dumps(items, ensure_ascii=False)
                    items_summary = f'{canonical} x{qty}'

            oid = new_id()
            db.execute(
                """INSERT OR IGNORE INTO orders
                   (id,order_num,date,cust_id,cust_name,cust_phone,
                    address,lat,lng,items_json,items_summary,
                    subtotal,fees_json,vat,total,payment_method,
                    awaiting_payment,cash_collected,order_type,service_type,
                    status,driver_name,note,created_at,updated_at)
                   VALUES
                   (?,?,?,?,?,?,
                    ?,?,?,?,?,
                    ?,?,?,?,?,
                    0,?,?,?,
                    'completed',?,?,?,?)""",
                (oid, order_num, date_str, cust_id, name, phone,
                 '', None, None, items_json, items_summary,
                 total, '[]', round(total * 7 / 107, 2), total, method,
                 total if method == 'เงินสด' else 0, 'delivery', 'exchange',
                 driver, note, now, now)
            )
            order_count += 1

        elif row_type in EXPENSE_TYPES:
            category = (row.get('expense_category') or 'other').strip() or 'other'
            amount   = parse_float(row.get('expense_amount', 0)) or parse_float(row.get('total', 0))
            note_e   = (row.get('note') or '').strip()
            if not amount:
                continue
            db.execute(
                """INSERT INTO expenses
                   (id,date,category,description,amount,vat_eligible,created_at)
                   VALUES (?,?,?,?,?,0,?)""",
                (new_id(), date_str, category, note_e, amount, now)
            )
            expense_count += 1

    logging.info(f'  {order_count} orders, {expense_count} expenses inserted')
    return order_count, expense_count


def step5_customer_prices(db, rows):
    """Import customer-specific prices from rows where price differs from product default."""
    logging.info('Step 5: Customer prices')
    count = 0

    for row in rows:
        row_type = (row.get('type') or '').strip().lower()
        if row_type not in ORDER_TYPES:
            continue

        phone    = (row.get('customer_phone') or '').strip()
        prod_raw = (row.get('product_name') or '').strip()
        price    = parse_float(row.get('price_per_unit', 0))

        if not phone or not prod_raw or not price:
            continue

        canonical = normalise_product(prod_raw)
        prod_row  = db.execute("SELECT id, price FROM products WHERE name=?", (canonical,)).fetchone()
        cust_row  = db.execute("SELECT id FROM customers WHERE phone=?", (phone,)).fetchone()

        if not prod_row or not cust_row:
            continue

        # Only insert if price differs from default by > 1 baht
        if abs(price - prod_row['price']) < 1.0:
            continue

        existing = db.execute(
            "SELECT id FROM customer_prices WHERE customer_id=? AND product_id=?",
            (cust_row['id'], prod_row['id'])
        ).fetchone()
        if existing:
            continue

        db.execute(
            "INSERT INTO customer_prices (id,customer_id,product_id,price,updated_at) VALUES (?,?,?,?,?)",
            (new_id(), cust_row['id'], prod_row['id'], price, bkk_now())
        )
        count += 1

    logging.info(f'  {count} custom prices inserted')
    return count


def step6_vat(db, rows):
    """Backfill vat_output for imported orders."""
    logging.info('Step 6: VAT output')
    count = 0
    now   = bkk_now()

    for row in rows:
        row_type = (row.get('type') or '').strip().lower()
        if row_type not in ORDER_TYPES:
            continue

        bill_no = (row.get('bill_no') or '').strip()
        total   = parse_float(row.get('total', 0))
        date_raw = parse_date((row.get('date') or '').strip())

        if not total:
            continue

        base = round(total * 100 / 107, 2)
        vat  = round(total - base, 2)

        vat_type = (row.get('vat_type') or 'output').strip().lower()
        if vat_type not in ('output', 'input'):
            vat_type = 'output'

        table = 'vat_output' if vat_type == 'output' else 'vat_input'
        db.execute(
            f"""INSERT OR IGNORE INTO {table}
                (id,order_num,date,base_amount,vat_amount,total_amount,created_at)
                VALUES (?,?,?,?,?,?,?)""",
            (new_id(), bill_no or new_id()[:8], date_raw, base, vat, total, now)
        )
        count += 1

    logging.info(f'  {count} VAT records inserted')
    return count


# ─── Commands ─────────────────────────────────────────────────────────────────

def cmd_dry_run(csv_path: str):
    """Validate CSV and print all issues. Exit 1 if any ERROR."""
    rows = load_csv(csv_path)
    print(f'Loaded {len(rows)} rows from {csv_path}')

    db = None
    if os.path.exists(DB_PATH):
        db = get_db()

    issues = validate(rows, db=db)
    if db:
        db.close()

    if not issues:
        print('\n✅ No issues found — ready for --confirm')
        return

    errors = warnings = infos = 0
    for iss in issues:
        print(iss)
        if iss.level == 'ERROR':
            errors += 1
        elif iss.level == 'WARNING':
            warnings += 1
        else:
            infos += 1

    print(f'\nSummary: {errors} ERROR(s), {warnings} WARNING(s), {infos} INFO(s)')

    if errors:
        print('\n❌ Fix all ERRORs before running --confirm')
        sys.exit(1)
    else:
        print('\n⚠️  Warnings found — review above, then run --confirm to proceed')


def cmd_confirm(csv_path: str):
    """Run full 6-step transactional import. Aborts if validation errors exist."""
    rows = load_csv(csv_path)
    print(f'Loaded {len(rows)} rows from {csv_path}')

    db = get_db()
    issues = validate(rows, db=db)

    errors = [i for i in issues if i.level == 'ERROR']
    if errors:
        print(f'\n❌ {len(errors)} validation error(s) — aborting import:')
        for e in errors:
            print(e)
        db.close()
        sys.exit(1)

    warnings = [i for i in issues if i.level == 'WARNING']
    if warnings:
        print(f'\n⚠️  {len(warnings)} warning(s) (proceeding):')
        for w in warnings:
            print(w)

    print('\nRunning 6-step import...')
    try:
        with db:
            step1_opening_stock(db)
            step2_customers(db, rows)
            step3_products(db, rows)
            step4_orders_expenses(db, rows)
            step5_customer_prices(db, rows)
            step6_vat(db, rows)
    except Exception as exc:
        print(f'\n❌ Import failed: {exc}')
        db.close()
        sys.exit(1)

    db.close()
    print('\n✅ Import completed successfully')


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    if '--help' in args or '-h' in args or not args:
        print(__doc__)
        sys.exit(0)

    csv_path = next((a for a in args if not a.startswith('--')), None)
    if not csv_path:
        print('ERROR: CSV file path required')
        sys.exit(1)

    if not os.path.exists(csv_path):
        print(f'ERROR: file not found: {csv_path}')
        sys.exit(1)

    if not os.path.exists(DB_PATH):
        print(f'ERROR: database not found: {DB_PATH} — run server.py first')
        sys.exit(1)

    if '--dry-run' in args:
        cmd_dry_run(csv_path)
    elif '--confirm' in args:
        cmd_confirm(csv_path)
    else:
        print('ERROR: specify --dry-run or --confirm')
        sys.exit(1)


if __name__ == '__main__':
    main()
