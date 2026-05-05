"""
routes/driver.py — Driver mobile app endpoints (session-cookie auth)
"""
import json
from flask import Blueprint, jsonify, request, g

from helpers import (
    get_db, bkk_now, new_id, audit,
    require_auth, verify_stock_invariant, notify_line
)

driver_bp = Blueprint('driver', __name__)

DRIVER_ROLES = ['driver']


# ─── Orders ───────────────────────────────────────────────────────────────────

@driver_bp.route('/orders')
@require_auth(DRIVER_ROLES)
def get_orders():
    staff = g.actor
    db    = get_db()
    today = bkk_now()[:10]
    rows  = db.execute(
        """SELECT id,order_num,date,cust_name,cust_phone,
                  address,lat,lng,items_json,items_summary,
                  total,payment_method,awaiting_payment,
                  service_type,order_type,status,
                  cash_collected,note
           FROM orders
           WHERE driver_id=? AND date=? AND status NOT IN ('cancelled')
           ORDER BY created_at""",
        (staff['id'], today)
    ).fetchall()
    db.close()
    result = []
    for r in rows:
        o = dict(r)
        try:
            o['items'] = json.loads(o.pop('items_json') or '[]')
        except Exception:
            o['items'] = []
        # Never expose driver phone — only customer name
        result.append(o)
    return jsonify({'orders': result})


@driver_bp.route('/orders/<order_num>/pickup', methods=['POST'])
@require_auth(DRIVER_ROLES)
def pickup_order(order_num):
    staff = g.actor
    d     = request.get_json() or {}
    db    = get_db()
    order = db.execute(
        "SELECT * FROM orders WHERE order_num=? AND driver_id=?",
        (order_num, staff['id'])
    ).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    if order['status'] != 'preparing':
        db.close(); return jsonify({'error': 'Not in preparing status'}), 400
    now = bkk_now()
    with db:
        db.execute(
            "UPDATE orders SET status='delivering', started_at=?, updated_at=? WHERE order_num=?",
            (now, now, order_num)
        )
        audit(db, staff['id'], staff['name'], 'driver',
              'status_delivering', 'order', order['id'],
              {'order_num': order_num},
              d.get('lat'), d.get('lng'))
    db.close()
    return jsonify({'ok': True})


@driver_bp.route('/orders/<order_num>/deliver', methods=['POST'])
@require_auth(DRIVER_ROLES)
def deliver_order(order_num):
    staff = g.actor
    d     = request.get_json() or {}
    db    = get_db()
    order = db.execute(
        "SELECT * FROM orders WHERE order_num=? AND driver_id=?",
        (order_num, staff['id'])
    ).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    if order['status'] != 'delivering':
        db.close(); return jsonify({'error': 'Not delivering'}), 400

    cash_received = d.get('cash_received')
    cash_collected = int(cash_received) if cash_received is not None else order['total']
    now            = bkk_now()

    with db:
        db.execute(
            """UPDATE orders SET status='completed', delivered_at=?,
               updated_at=?, cash_collected=? WHERE order_num=?""",
            (now, now, cash_collected, order_num)
        )
        # Driver cash record
        db.execute(
            """INSERT INTO driver_cash
               (id,driver_id,order_id,amount,cleared,created_at)
               VALUES (?,?,?,?,0,?)""",
            (new_id(), staff['id'], order['id'], cash_collected, now)
        )
        # Tank stock update on delivery
        items = json.loads(order['items_json'] or '[]')
        for item in items:
            pid = item.get('product_id', '')
            qty = item.get('qty', 0)
            if not pid or not qty:
                continue
            if order['service_type'] == 'exchange':
                # exchange: full was already deducted at order creation
                # on delivery: empty_qty from customer returns
                pass  # stock already adjusted at order create
            else:
                pass  # new tank: customer_qty already incremented at create
            verify_stock_invariant(db, pid)

        audit(db, staff['id'], staff['name'], 'driver',
              'delivered', 'order', order['id'],
              {'cash': cash_collected, 'order_num': order_num},
              d.get('lat'), d.get('lng'))

    db.close()
    notify_line(
        f"\n✅ ส่งแล้ว {order_num}\n"
        f"👤 {order['cust_name']}\n💰 ฿{order['total']:,}"
    )
    return jsonify({'ok': True})


@driver_bp.route('/orders/<order_num>/customer-absent', methods=['POST'])
@require_auth(DRIVER_ROLES)
def customer_absent(order_num):
    staff = g.actor
    d     = request.get_json() or {}
    db    = get_db()
    order = db.execute(
        "SELECT * FROM orders WHERE order_num=? AND driver_id=?",
        (order_num, staff['id'])
    ).fetchone()
    if not order:
        db.close(); return jsonify({'error': 'Not found'}), 404
    now = bkk_now()
    with db:
        db.execute(
            "UPDATE orders SET note=COALESCE(note,'')||?, updated_at=? WHERE order_num=?",
            (f' [ลูกค้าไม่อยู่ {now}]', now, order_num)
        )
        audit(db, staff['id'], staff['name'], 'driver',
              'customer_absent', 'order', order['id'],
              {'order_num': order_num},
              d.get('lat'), d.get('lng'))
    db.close()
    notify_line(
        f"\n⚠️ ลูกค้าไม่อยู่ {order_num}\n"
        f"👤 {order['cust_name']} | 📍 {order['address']}"
    )
    return jsonify({'ok': True, 'message': 'Reported to supervisor'})


# ─── Cash ─────────────────────────────────────────────────────────────────────

@driver_bp.route('/cash/summary')
@require_auth(DRIVER_ROLES)
def cash_summary():
    staff = g.actor
    db    = get_db()
    today = bkk_now()[:10]
    orders = db.execute(
        """SELECT order_num, cust_name, cash_collected, payment_method
           FROM orders
           WHERE driver_id=? AND date=? AND status='completed'
           ORDER BY delivered_at""",
        (staff['id'], today)
    ).fetchall()
    total_cash = sum(
        o['cash_collected'] for o in orders
        if o['payment_method'] == 'เงินสด'
    )
    db.close()
    return jsonify({
        'orders': [dict(o) for o in orders],
        'total_cash': total_cash,
        'driver': staff['name'],
    })


@driver_bp.route('/cash/return', methods=['POST'])
@require_auth(DRIVER_ROLES)
def return_cash():
    staff = g.actor
    d     = request.get_json() or {}
    db    = get_db()
    today = bkk_now()[:10]
    # Sum uncleared cash
    row = db.execute(
        """SELECT SUM(cash_collected) as total FROM orders
           WHERE driver_id=? AND date=? AND status='completed'
           AND payment_method='เงินสด' AND cash_cleared=0""",
        (staff['id'], today)
    ).fetchone()
    returned = row['total'] or 0
    now = bkk_now()
    with db:
        db.execute(
            """UPDATE orders SET cash_cleared=1, cleared_at=?
               WHERE driver_id=? AND date=? AND status='completed'
               AND payment_method='เงินสด' AND cash_cleared=0""",
            (now, staff['id'], today)
        )
        audit(db, staff['id'], staff['name'], 'driver',
              'cash_return', 'driver', staff['id'], {'amount': returned})
    db.close()
    return jsonify({'ok': True, 'returned': returned})
