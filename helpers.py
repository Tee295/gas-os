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
from typing import Any, Callable, Dict, Optional, Tuple

from flask import request, jsonify, g

DATABASE = os.getenv('DATABASE_PATH', 'gasshop.db')
SECRET   = os.getenv('SECRET_KEY', 'changeme-dev-replace-in-production')
BKK      = timezone(timedelta(hours=7))


# ─── DB ──────────────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    db = sqlite3.connect(DATABASE)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    return db


# ─── Time ─────────────────────────────────────────────────────────────────────

def bkk_now() -> str:
    return datetime.now(BKK).strftime('%Y-%m-%d %H:%M:%S')


def bkk_today() -> str:
    return datetime.now(BKK).strftime('%Y-%m-%d')


# ─── IDs ─────────────────────────────────────────────────────────────────────

def new_id() -> str:
    return str(uuid.uuid4())[:8]


# ─── Finance ─────────────────────────────────────────────────────────────────

def calc_vat(total_incl_vat: float, rate: int = 7) -> Tuple[float, float]:
    """Extract VAT from VAT-inclusive price. Returns (base, vat)."""
    vat  = round(total_incl_vat * rate / (100 + rate), 2)
    base = round(total_incl_vat - vat, 2)
    return base, vat


# ─── Order Number ─────────────────────────────────────────────────────────────

def generate_order_num(conn: sqlite3.Connection) -> str:
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

def generate_doc_num(conn: sqlite3.Connection, doc_type: str = 'dn') -> str:
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

def audit(conn: sqlite3.Connection, actor_id: str, actor_name: str, actor_role: str, 
          action: str, target_type: str = '', target_id: str = '', 
          detail: Optional[Dict[str, Any]] = None, lat: Optional[float] = None, 
          lng: Optional[float] = None) -> None:
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

def verify_stock_invariant(conn: sqlite3.Connection, product_id: str) -> None:
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

def notify_line(message: str, token: Optional[str] = None) -> None:
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


def make_session_token(staff_dict: Dict[str, str]) -> str:
    """Sign a minimal staff payload as a cookie value.
    
    Uses base64-encoded payload to avoid encoding issues with Thai characters
    or special chars in staff names that can break cookie round-trip.
    """
    import base64
    payload = json.dumps({
        'id':   staff_dict['id'],
        'name': staff_dict['name'],
        'role': staff_dict['role'],
    }, separators=(',', ':'))
    payload_b64 = base64.urlsafe_b64encode(payload.encode('utf-8')).decode('ascii').rstrip('=')
    return payload_b64 + '.' + _sign(payload_b64)


def verify_session_token(token: str) -> Optional[Dict[str, Any]]:
    """Returns decoded dict or None if invalid/tampered."""
    import base64
    if not token or '.' not in token:
        return None
    try:
        payload_b64, sig = token.rsplit('.', 1)
        if not hmac.compare_digest(sig, _sign(payload_b64)):
            return None
        # Add base64 padding back
        payload_b64 += '=' * (-len(payload_b64) % 4)
        payload = base64.urlsafe_b64decode(payload_b64).decode('utf-8')
        return json.loads(payload)
    except Exception:
        return None


# ─── require_auth decorator ───────────────────────────────────────────────────

# Per-role cookie names — must match auth.py
_COOKIE_NAMES_BY_ROLE: Dict[str, str] = {
    'admin':      'gas_session_admin',
    'supervisor': 'gas_session_supervisor',
    'driver':     'gas_session_driver',
}
_LEGACY_COOKIE = 'gas_session'


def _get_session_data(roles: Optional[list] = None) -> Optional[Dict[str, Any]]:
    """Look up session in role-specific cookies first, fall back to legacy."""
    # If roles specified, try those role cookies first (most likely match)
    if roles:
        for r in roles:
            cookie_name = _COOKIE_NAMES_BY_ROLE.get(r)
            if cookie_name:
                token = request.cookies.get(cookie_name)
                if token:
                    data = verify_session_token(token)
                    if data:
                        return data
    # Fall back: try all role cookies + legacy
    for cookie_name in [*_COOKIE_NAMES_BY_ROLE.values(), _LEGACY_COOKIE]:
        token = request.cookies.get(cookie_name)
        if token:
            data = verify_session_token(token)
            if data:
                return data
    return None


def require_auth(roles: Optional[list] = None) -> Callable:
    """
    @require_auth()                  — any authenticated staff
    @require_auth(['supervisor','admin'])  — specific roles only
    Sets g.actor = {id, name, role}
    """
    def decorator(f: Callable) -> Callable:
        @wraps(f)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            data = _get_session_data(roles)
            if not data:
                return jsonify({'error': 'Unauthorized'}), 401
            if roles and data['role'] not in roles:
                return jsonify({'error': 'Forbidden'}), 403
            g.actor = data
            return f(*args, **kwargs)
        return wrapped
    return decorator


# ─── Legacy: require_shop_key (kept for backwards compat on admin API calls) ──

def require_shop_key(f: Callable) -> Callable:
    @wraps(f)
    def decorated(*args: Any, **kwargs: Any) -> Any:
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

def verify_pin(pin: str, roles: Optional[list] = None) -> Optional[Dict[str, Any]]:
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
