"""
helpers.py — Shared utilities imported by server.py and all routes.
Zero imports from project files (prevents circular imports).
"""
import os
import sqlite3
import json
import uuid
import hmac
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from functools import wraps

from flask import request, jsonify, g

DATABASE = os.getenv('DATABASE_PATH', 'gasshop.db')
SECRET   = os.getenv('SECRET_KEY', 'changeme-dev-replace-in-production')
BKK      = timezone(timedelta(hours=7))


# ─── DB ──────────────────────────────────────────────────────────────────────

def get_db():
    # Ensure parent directory exists (e.g. /data on Railway volume)
    db_dir = os.path.dirname(DATABASE)
    if db_dir and not os.path.exists(db_dir):
        try:
            os.makedirs(db_dir, exist_ok=True)
        except OSError as e:
            # Fallback: use current dir if volume not writable
            print(f"[WARN] Cannot create {db_dir}: {e}. Using current dir.")
            globals()['DATABASE'] = 'gasshop.db'
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    return db


# ─── Time ─────────────────────────────────────────────────────────────────────

def bkk_now():
    return datetime.now(BKK).strftime('%Y-%m-%d %H:%M:%S')


def bkk_today():
    return datetime.now(BKK).strftime('%Y-%m-%d')


# ─── IDs ─────────────────────────────────────────────────────────────────────

def new_id():
    return str(uuid.uuid4())[:8]


# ─── Finance ─────────────────────────────────────────────────────────────────

def calc_vat(total_incl_vat, rate=7):
    """Extract VAT from VAT-inclusive price. Returns (base, vat)."""
    vat  = round(total_incl_vat * rate / (100 + rate), 2)
    base = round(total_incl_vat - vat, 2)
    return base, vat


# ─── Order Number ─────────────────────────────────────────────────────────────

def generate_order_num(conn):
    """Format: YYMMDD-SEQ e.g. 260410-001 — resets daily, atomic within conn."""
    today = datetime.now(BKK).strftime('%y%m%d')
    row = conn.execute(
        "SELECT val FROM settings WHERE key='order_seq_date'"
    ).fetchone()
    last_date = row['val'] if row else ''
    if last_date != today:
        seq = 1
        conn.execute("UPDATE settings SET val=? WHERE key='order_seq_date'", (today,))
        conn.execute("UPDATE settings SET val='1' WHERE key='order_seq_num'")
    else:
        row2 = conn.execute("SELECT val FROM settings WHERE key='order_seq_num'").fetchone()
        seq = (int(row2['val']) if row2 else 0) + 1
        conn.execute("UPDATE settings SET val=? WHERE key='order_seq_num'", (str(seq),))
    return f"{today}-{seq:03d}"


# ─── Document Number ─────────────────────────────────────────────────────────

def generate_doc_num(conn, doc_type='dn'):
    """
    Generate delivery note (DN-YYMMDD-001) or tax invoice (INV-YYMMDD-001).
    Resets daily. Atomic within the calling connection.
    """
    today = datetime.now(BKK).strftime('%y%m%d')
    row = conn.execute("SELECT val FROM settings WHERE key='doc_seq_date'").fetchone()
    last_date = row['val'] if row else ''
    if last_date != today:
        conn.execute("UPDATE settings SET val=? WHERE key='doc_seq_date'", (today,))
        conn.execute("UPDATE settings SET val='0' WHERE key='doc_seq_dn'")
        conn.execute("UPDATE settings SET val='0' WHERE key='doc_seq_inv'")
    key = f'doc_seq_{doc_type}'
    row2 = conn.execute(f"SELECT val FROM settings WHERE key=?", (key,)).fetchone()
    seq = (int(row2['val']) if row2 else 0) + 1
    conn.execute(f"UPDATE settings SET val=? WHERE key=?", (str(seq), key))
    return f"{doc_type.upper()}-{today}-{seq:03d}"


# ─── Audit ────────────────────────────────────────────────────────────────────

def audit(conn, actor_id, actor_name, actor_role, action,
          target_type='', target_id='', detail=None, lat=None, lng=None):
    conn.execute(
        """INSERT INTO audit_log
           (id, timestamp, actor_id, actor_name, actor_role,
            action, target_type, target_id, detail_json, location_lat, location_lng)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (new_id(), bkk_now(), actor_id, actor_name, actor_role,
         action, target_type, str(target_id),
         json.dumps(detail, ensure_ascii=False) if detail else None,
         lat, lng)
    )


# ─── Stock Invariant ──────────────────────────────────────────────────────────

def verify_stock_invariant(conn, product_id):
    """Log a warning if full+empty+customer is inconsistent (for monitoring)."""
    row = conn.execute(
        "SELECT full_qty, empty_qty, customer_qty FROM tank_stock WHERE product_id=?",
        (product_id,)
    ).fetchone()
    if row:
        total = row['full_qty'] + row['empty_qty'] + row['customer_qty']
        logging.info(
            f"Stock invariant product={product_id}: "
            f"full={row['full_qty']} empty={row['empty_qty']} "
            f"customer={row['customer_qty']} total={total}"
        )


# ─── LINE Notify ──────────────────────────────────────────────────────────────

def notify_line(message, token=None):
    """Send LINE Notify. Uses token arg or fetches from settings table."""
    if not token:
        try:
            db = get_db()
            row = db.execute("SELECT val FROM settings WHERE key='line_token_order'").fetchone()
            db.close()
            token = (row['val'] or '') if row else ''
        except Exception:
            token = ''
    if not token:
        return
    try:
        import requests as req
        req.post(
            'https://notify-api.line.me/api/notify',
            headers={'Authorization': f'Bearer {token}'},
            data={'message': message},
            timeout=5
        )
    except Exception:
        pass


# ─── Session Tokens ───────────────────────────────────────────────────────────

def _sign(payload_str: str) -> str:
    return hmac.new(SECRET.encode(), payload_str.encode(), hashlib.sha256).hexdigest()


def make_session_token(staff_dict: dict) -> str:
    """Sign a minimal staff payload as a cookie value."""
    payload = json.dumps({
        'id':   staff_dict['id'],
        'name': staff_dict['name'],
        'role': staff_dict['role'],
    }, ensure_ascii=False, separators=(',', ':'))
    return payload + '.' + _sign(payload)


def verify_session_token(token: str):
    """Returns decoded dict or None if invalid/tampered."""
    if not token or '.' not in token:
        return None
    try:
        # split on last dot
        dot = token.rfind('.')
        payload, sig = token[:dot], token[dot + 1:]
        if not hmac.compare_digest(sig, _sign(payload)):
            return None
        return json.loads(payload)
    except Exception:
        return None


# ─── require_auth decorator ───────────────────────────────────────────────────

def require_auth(roles=None):
    """
    @require_auth()                  — any authenticated staff
    @require_auth(['supervisor','admin'])  — specific roles only
    Sets g.actor = {id, name, role}
    """
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            token = request.cookies.get('gas_session')
            data  = verify_session_token(token)
            if not data:
                return jsonify({'error': 'Unauthorized'}), 401
            if roles and data['role'] not in roles:
                return jsonify({'error': 'Forbidden'}), 403
            g.actor = data
            return f(*args, **kwargs)
        return wrapped
    return decorator


# ─── Legacy: require_shop_key (kept for backwards compat on admin API calls) ──

def require_shop_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        key = (request.headers.get('X-Shop-Key') or
               (request.get_json(silent=True) or {}).get('shop_key', ''))
        db  = get_db()
        row = db.execute("SELECT val FROM settings WHERE key='api_key'").fetchone()
        db.close()
        if not row or not key or key != row['val']:
            return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    return decorated


# ─── PIN verification (used by auth route only) ───────────────────────────────

def verify_pin(pin, roles=None):
    """Returns staff row dict or None. Used internally by auth.py."""
    if not pin:
        return None
    db  = get_db()
    row = db.execute(
        "SELECT * FROM staff WHERE pin=? AND active=1", (pin,)
    ).fetchone()
    db.close()
    if not row:
        return None
    if roles and row['role'] not in roles:
        return None
    return dict(row)
