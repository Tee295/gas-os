"""
routes/auth.py — Unified authentication: login, logout, session check.

POST /api/auth/login   — supervisor/driver: {staff_id, pin} or admin: {pin}
POST /api/auth/logout  — clear session cookie
GET  /api/auth/me      — return current session info
GET  /api/auth/staff   — list staff for login dropdown (names only, no PINs)
"""
from datetime import datetime, timezone, timedelta
from flask import Blueprint, request, jsonify, make_response

from helpers import (
    get_db, bkk_now, new_id, audit,
    make_session_token, verify_session_token
)

auth_bp = Blueprint('auth', __name__)

# ─── In-memory lockout tracker ────────────────────────────────────────────────
# { staff_id: {'fails': N, 'locked_until': datetime or None} }
_lockout: dict = {}
MAX_FAILS    = 3
LOCK_MINUTES = 15
BKK = timezone(timedelta(hours=7))

COOKIE_NAME = 'gas_session'

# Per-role cookie names — allows multiple roles in same browser without conflict
COOKIE_NAMES_BY_ROLE = {
    'admin':      'gas_session_admin',
    'supervisor': 'gas_session_supervisor',
    'driver':     'gas_session_driver',
}

def _cookie_name_for(role):
    return COOKIE_NAMES_BY_ROLE.get(role, COOKIE_NAME)


def _is_locked(staff_id: str):
    """Returns (locked: bool, seconds_remaining: int)."""
    entry = _lockout.get(str(staff_id))
    if not entry or not entry.get('locked_until'):
        return False, 0
    now = datetime.now(BKK)
    if now < entry['locked_until']:
        remaining = int((entry['locked_until'] - now).total_seconds())
        return True, remaining
    # lock expired — reset
    _lockout[str(staff_id)] = {'fails': 0, 'locked_until': None}
    return False, 0


def _record_fail(staff_id: str):
    sid = str(staff_id)
    entry = _lockout.setdefault(sid, {'fails': 0, 'locked_until': None})
    entry['fails'] += 1
    if entry['fails'] >= MAX_FAILS:
        entry['locked_until'] = datetime.now(BKK) + timedelta(minutes=LOCK_MINUTES)
    return entry['fails']


def _reset_fails(staff_id: str):
    _lockout[str(staff_id)] = {'fails': 0, 'locked_until': None}


# ─── Routes ───────────────────────────────────────────────────────────────────

@auth_bp.route('/login', methods=['POST'])
def login():
    data = request.get_json(silent=True) or {}
    pin       = str(data.get('pin', '')).strip()
    staff_id  = str(data.get('staff_id', '')).strip()

    if not pin:
        return jsonify({'error': 'PIN required'}), 400

    db = get_db()

    # ── Admin login: PIN only (no staff_id required, finds by role+pin) ──────
    if not staff_id:
        locked, remaining = _is_locked('admin')
        if locked:
            db.close()
            return jsonify({
                'error': f'ล็อคอีก {remaining // 60 + 1} นาที',
                'locked_seconds': remaining,
            }), 423

        row = db.execute(
            "SELECT * FROM staff WHERE pin=? AND role='admin' AND active=1", (pin,)
        ).fetchone()
        if not row:
            fails = _record_fail('admin')
            audit(db, '', 'unknown', 'admin', 'login_fail',
                  'auth', 'admin', {'pin_len': len(pin), 'fails': fails})
            db.commit(); db.close()
            remaining_tries = MAX_FAILS - fails
            return jsonify({
                'error': f'PIN ไม่ถูกต้อง ({remaining_tries} ครั้งก่อนล็อค)' if remaining_tries > 0 else 'ล็อคแล้ว',
                'fails': fails,
            }), 401

        staff = dict(row)
        _reset_fails('admin')
        audit(db, staff['id'], staff['name'], staff['role'], 'login',
              'auth', staff['id'])
        db.commit(); db.close()
        token    = make_session_token(staff)
        response = make_response(jsonify({
            'staff': {'id': staff['id'], 'name': staff['name'], 'role': staff['role']}
        }))
        # Per-role cookie: avoids conflict if user has multiple roles in same browser
        response.set_cookie(_cookie_name_for(staff['role']), token, httponly=True,
                            samesite='Lax', max_age=86400 * 7, path='/')
        return response

    # ── Supervisor / Driver login: staff_id + PIN ────────────────────────────
    locked, remaining = _is_locked(staff_id)
    if locked:
        db.close()
        return jsonify({
            'error': f'ล็อคอีก {remaining // 60 + 1} นาที',
            'locked_seconds': remaining,
        }), 423

    row = db.execute(
        "SELECT * FROM staff WHERE id=? AND pin=? AND active=1", (staff_id, pin)
    ).fetchone()
    if not row:
        fails = _record_fail(staff_id)
        audit(db, staff_id, '', '', 'login_fail',
              'auth', staff_id, {'fails': fails})
        db.commit(); db.close()
        remaining_tries = MAX_FAILS - fails
        return jsonify({
            'error': f'PIN ไม่ถูกต้อง ({remaining_tries} ครั้งก่อนล็อค)' if remaining_tries > 0 else 'ล็อคแล้ว',
            'fails': fails,
        }), 401

    staff = dict(row)
    _reset_fails(staff_id)
    audit(db, staff['id'], staff['name'], staff['role'], 'login',
          'auth', staff['id'])
    db.commit(); db.close()
    token    = make_session_token(staff)
    response = make_response(jsonify({
        'staff': {'id': staff['id'], 'name': staff['name'], 'role': staff['role']}
    }))
    # Per-role cookie: avoids conflict if user has multiple roles in same browser
    response.set_cookie(_cookie_name_for(staff['role']), token, httponly=True,
                        samesite='Lax', max_age=86400 * 7, path='/')
    return response


@auth_bp.route('/logout', methods=['POST'])
def logout():
    # Try all cookie names to find the active session
    data = None
    for cookie_name in [*COOKIE_NAMES_BY_ROLE.values(), COOKIE_NAME]:
        token = request.cookies.get(cookie_name)
        if token:
            data = verify_session_token(token)
            if data:
                break
    if data:
        try:
            db = get_db()
            audit(db, data['id'], data['name'], data['role'], 'logout',
                  'auth', data['id'])
            db.commit(); db.close()
        except Exception:
            pass
    response = make_response(jsonify({'ok': True}))
    # Clear all possible cookies (including legacy unified one)
    for cookie_name in [*COOKIE_NAMES_BY_ROLE.values(), COOKIE_NAME]:
        response.delete_cookie(cookie_name, path='/')
    return response


@auth_bp.route('/me', methods=['GET'])
def me():
    # Check all role cookies — first valid one wins
    for cookie_name in [*COOKIE_NAMES_BY_ROLE.values(), COOKIE_NAME]:
        token = request.cookies.get(cookie_name)
        if token:
            data = verify_session_token(token)
            if data:
                return jsonify({'staff': data})
    # Return 200 with null staff to avoid console 401 noise on initial page load
    return jsonify({'staff': None})


@auth_bp.route('/staff', methods=['GET'])
def list_staff():
    """Return staff list for login dropdown. Role filter: ?role=supervisor,driver"""
    roles_param = request.args.get('role', 'supervisor,driver')
    roles = [r.strip() for r in roles_param.split(',')]
    db   = get_db()
    rows = db.execute(
        f"SELECT id, name, role FROM staff WHERE active=1 AND role IN ({','.join(['?']*len(roles))}) ORDER BY name",
        roles
    ).fetchall()
    db.close()
    return jsonify({'staff': [dict(r) for r in rows]})
