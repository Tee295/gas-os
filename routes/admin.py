"""
routes/admin.py — Admin back office endpoints (session-cookie auth)
Admin CANNOT create orders — enforced here and in UI.
"""
import json
from flask import Blueprint, jsonify, request, g

from helpers import (
    get_db, bkk_now, new_id, calc_vat, audit, require_auth
)

admin_bp = Blueprint('admin', __name__)

ADMIN_ONLY = ['admin']


# ─── Dashboard ───────────────────────────────────────────────────────────────

@admin_bp.route('/dashboard')
@require_auth(ADMIN_ONLY)
def dashboard():
    staff = g.actor
    db    = get_db()
    today = bkk_now()[:10]
    month = today[:7]

    revenue        = db.execute("SELECT COALESCE(SUM(total),0) FROM orders WHERE date=? AND status='completed'", (today,)).fetchone()[0]
    month_revenue  = db.execute("SELECT COALESCE(SUM(total),0) FROM orders WHERE date LIKE ? AND status='completed'", (f'{month}%',)).fetchone()[0]
    expenses_today = db.execute("SELECT COALESCE(SUM(amount),0) FROM expenses WHERE date=?", (today,)).fetchone()[0]
    cogs_today     = db.execute("SELECT COALESCE(SUM(net_total),0) FROM restock_invoices WHERE date=?", (today,)).fetchone()[0]
    uncleared_cash = db.execute("SELECT COALESCE(SUM(cash_collected),0) FROM orders WHERE status='completed' AND cash_cleared=0 AND payment_method='เงินสด'").fetchone()[0]
    pending_credit = db.execute("SELECT COALESCE(SUM(credit_bal),0) FROM customers WHERE credit_bal>0").fetchone()[0]
    recent_audit   = db.execute("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10").fetchall()
    db.close()
    return jsonify({
        'today': today,
        'revenue': revenue,
        'month_revenue': month_revenue,
        'gross_profit': revenue - cogs_today,
        'expenses': expenses_today,
        'net_profit': revenue - cogs_today - expenses_today,
        'uncleared_cash': uncleared_cash,
        'pending_credit': pending_credit,
        'recent_audit': [dict(r) for r in recent_audit],
    })


# ─── Orders ───────────────────────────────────────────────────────────────────

@admin_bp.route('/orders/<order_num>')
@require_auth(ADMIN_ONLY)
def get_order_detail(order_num):
    db = get_db()
    row = db.execute("SELECT * FROM orders WHERE order_num=?", (order_num,)).fetchone()
    db.close()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    o = dict(row)
    try: o['items_json'] = json.loads(o.get('items_json') or '[]')
    except: o['items_json'] = []
    try: o['fees_json'] = json.loads(o.get('fees_json') or '[]')
    except: o['fees_json'] = []
    return jsonify(o)


@admin_bp.route('/orders')
@require_auth(ADMIN_ONLY)
def get_orders():
    db        = get_db()
    date_from = request.args.get('from', '')
    date_to   = request.args.get('to', bkk_now()[:10])
    status    = request.args.get('status', '')
    driver_id = request.args.get('driver_id', '')
    limit     = int(request.args.get('limit', 100))
    offset    = int(request.args.get('offset', 0))
    sql, params = "SELECT * FROM orders WHERE 1=1", []
    if date_from: sql += " AND date>=?";      params.append(date_from)
    if date_to:   sql += " AND date<=?";      params.append(date_to)
    if status:    sql += " AND status=?";     params.append(status)
    if driver_id: sql += " AND driver_id=?";  params.append(driver_id)
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
    params += [limit, offset]
    rows = db.execute(sql, params).fetchall()
    db.close()
    result = []
    for r in rows:
        o = dict(r)
        try: o['items_json'] = json.loads(o.get('items_json') or '[]')
        except: o['items_json'] = []
        result.append(o)
    return jsonify(result)


# ─── Customers ───────────────────────────────────────────────────────────────

@admin_bp.route('/customers')
@require_auth(ADMIN_ONLY)
def get_customers():
    db = get_db(); q = request.args.get('q', '')
    rows = db.execute(
        "SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name LIMIT 200",
        (f'%{q}%', f'%{q}%')
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/customers', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_customer():
    staff = g.actor; d = request.get_json(silent=True) or {}
    if not d.get('name') or not d.get('phone'):
        return jsonify({'error': 'name and phone required'}), 400
    cid = new_id(); now = bkk_now()
    db = get_db()
    with db:
        db.execute(
            """INSERT INTO customers
               (id,name,phone,address,lat,lng,tier,lang,credit_limit,credit_days,
                credit_bal,need_invoice,tax_id,note,total_orders,total_spent,
                last_order_items,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,0,0,'[]',?)""",
            (cid, d['name'], d['phone'], d.get('address',''), d.get('lat'), d.get('lng'),
             d.get('tier','retail'), d.get('lang','th'), d.get('credit_limit',0),
             d.get('credit_days',30), d.get('need_invoice','no'), d.get('tax_id',''),
             d.get('note',''), now)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'customer_created', 'customer', cid)
    db.close()
    return jsonify({'id': cid}), 201


@admin_bp.route('/customers/<cid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_customer(cid):
    staff = g.actor; d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE customers SET name=COALESCE(?,name), phone=COALESCE(?,phone),
               address=COALESCE(?,address), tier=COALESCE(?,tier),
               credit_limit=COALESCE(?,credit_limit), credit_days=COALESCE(?,credit_days),
               need_invoice=COALESCE(?,need_invoice), tax_id=COALESCE(?,tax_id),
               note=COALESCE(?,note) WHERE id=?""",
            (d.get('name'), d.get('phone'), d.get('address'), d.get('tier'),
             d.get('credit_limit'), d.get('credit_days'), d.get('need_invoice'),
             d.get('tax_id'), d.get('note'), cid)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'customer_updated', 'customer', cid)
    db.close()
    return jsonify({'ok': True})


@admin_bp.route('/customers/<cid>/credit', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_customer_credit(cid):
    """Approve/revoke credit + set limit + days."""
    staff = g.actor; d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE customers SET
               credit_approved=?, credit_limit=?, credit_days=?
               WHERE id=?""",
            (1 if d.get('approved') else 0,
             int(d.get('limit', 0)),
             int(d.get('days', 30)),
             cid)
        )
        audit(db, staff['id'], staff['name'], 'admin',
              'credit_updated', 'customer', cid, d)
    db.close()
    return jsonify({'ok': True})


@admin_bp.route('/customers/<cid>/documents', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_customer_documents(cid):
    """Set default document preferences (delivery_note + invoice)."""
    staff = g.actor; d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE customers SET
               default_delivery_note=?, default_invoice=?,
               tax_id=COALESCE(?, tax_id)
               WHERE id=?""",
            (1 if d.get('delivery_note') else 0,
             1 if d.get('invoice') else 0,
             d.get('tax_id'),
             cid)
        )
        audit(db, staff['id'], staff['name'], 'admin',
              'documents_updated', 'customer', cid, d)
    db.close()
    return jsonify({'ok': True})


@admin_bp.route('/customers/<cid>/payment', methods=['POST'])
@require_auth(ADMIN_ONLY)
def record_credit_payment(cid):
    staff = g.actor; d = request.get_json(silent=True) or {}
    amount = float(d.get('amount', 0))
    if amount <= 0: return jsonify({'error': 'amount must be positive'}), 400
    now = bkk_now(); db = get_db()
    cust = db.execute("SELECT * FROM customers WHERE id=?", (cid,)).fetchone()
    if not cust: db.close(); return jsonify({'error': 'Not found'}), 404
    new_bal = max(0, cust['credit_bal'] - amount)
    with db:
        db.execute("UPDATE customers SET credit_bal=? WHERE id=?", (new_bal, cid))
        db.execute(
            """INSERT INTO customer_ledger
               (id,customer_id,order_id,type,amount,balance_after,note,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (new_id(), cid, '', 'PAYMENT', amount, new_bal,
             d.get('note', f'รับชำระ ฿{amount:,.0f}'), now)
        )
        audit(db, staff['id'], staff['name'], 'admin',
              'credit_payment', 'customer', cid, {'amount': amount, 'balance_after': new_bal})
    db.close()
    return jsonify({'ok': True, 'balance': new_bal})


@admin_bp.route('/customers/<cid>/ledger')
@require_auth(ADMIN_ONLY)
def customer_ledger(cid):
    db   = get_db()
    rows = db.execute(
        "SELECT * FROM customer_ledger WHERE customer_id=? ORDER BY created_at DESC LIMIT 100",
        (cid,)
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


# ─── Products ─────────────────────────────────────────────────────────────────

@admin_bp.route('/products')
@require_auth(ADMIN_ONLY)
def get_products():
    db   = get_db()
    rows = db.execute(
        """SELECT p.*, ts.full_qty, ts.empty_qty, ts.customer_qty
           FROM products p
           LEFT JOIN tank_stock ts ON ts.product_id=p.id
           ORDER BY p.sort_order, p.brand, p.size_kg"""
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/products', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_product():
    staff = g.actor; d = request.get_json(silent=True) or {}
    if not d.get('name'): return jsonify({'error': 'name required'}), 400
    pid = new_id(); now = bkk_now(); price = int(d.get('price', 0))
    base, _ = calc_vat(price)
    db = get_db()
    with db:
        db.execute(
            """INSERT INTO products
               (id,brand,name,name_en,ico,image_url,size_kg,price,price_excl_vat,
                price_transfer,cost,status,reorder_point,sort_order,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (pid, d.get('brand',''), d['name'], d.get('name_en',''),
             d.get('ico','🔵'), d.get('image_url',''), d.get('size_kg',0),
             price, base, d.get('price_transfer',price),
             d.get('cost',0), d.get('status','available'),
             d.get('reorder_point',5), d.get('sort_order',0), now)
        )
        db.execute(
            """INSERT OR IGNORE INTO tank_stock
               (id,product_id,full_qty,empty_qty,customer_qty,reorder_point,last_updated)
               VALUES (?,?,?,?,?,?,?)""",
            (new_id(), pid, d.get('full_qty',0), d.get('empty_qty',0), 0,
             d.get('reorder_point',5), now)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'product_created', 'product', pid)
    db.close()
    return jsonify({'id': pid}), 201


@admin_bp.route('/products/<pid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_product(pid):
    staff = g.actor; d = request.get_json(silent=True) or {}; db = get_db(); now = bkk_now()
    old = db.execute("SELECT price FROM products WHERE id=?", (pid,)).fetchone()
    if not old: db.close(); return jsonify({'error': 'Not found'}), 404
    new_price = d.get('price')
    price_excl = None
    if new_price is not None:
        base, _ = calc_vat(int(new_price)); price_excl = base
        if old['price'] != int(new_price):
            with db:
                db.execute(
                    "INSERT INTO price_history (id,product_id,customer_id,old_price,new_price,changed_by,changed_at,note) VALUES (?,?,?,?,?,?,?,?)",
                    (new_id(), pid, '', old['price'], int(new_price), staff['name'], now, d.get('note',''))
                )
    with db:
        db.execute(
            """UPDATE products SET brand=COALESCE(?,brand), name=COALESCE(?,name),
               name_en=COALESCE(?,name_en), ico=COALESCE(?,ico),
               price=COALESCE(?,price), price_excl_vat=COALESCE(?,price_excl_vat),
               cost=COALESCE(?,cost), status=COALESCE(?,status),
               reorder_point=COALESCE(?,reorder_point), sort_order=COALESCE(?,sort_order)
               WHERE id=?""",
            (d.get('brand'), d.get('name'), d.get('name_en'), d.get('ico'),
             new_price, price_excl, d.get('cost'), d.get('status'),
             d.get('reorder_point'), d.get('sort_order'), pid)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'product_updated', 'product', pid)
    db.close()
    return jsonify({'ok': True})


@admin_bp.route('/price-history')
@require_auth(ADMIN_ONLY)
def get_price_history():
    db  = get_db(); pid = request.args.get('product_id', '')
    sql = "SELECT ph.*, p.name FROM price_history ph JOIN products p ON p.id=ph.product_id WHERE 1=1"
    params = []
    if pid: sql += " AND ph.product_id=?"; params.append(pid)
    sql += " ORDER BY ph.changed_at DESC LIMIT 100"
    rows = db.execute(sql, params).fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


# ─── Customer Prices ─────────────────────────────────────────────────────────

@admin_bp.route('/customer-prices/<cid>')
@require_auth(ADMIN_ONLY)
def get_customer_prices(cid):
    db   = get_db()
    rows = db.execute(
        "SELECT cp.*, p.name FROM customer_prices cp JOIN products p ON p.id=cp.product_id WHERE cp.customer_id=?",
        (cid,)
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/customer-prices', methods=['POST'])
@require_auth(ADMIN_ONLY)
def set_customer_price():
    staff = g.actor; d = request.get_json(silent=True) or {}
    cid = d.get('customer_id'); pid_p = d.get('product_id'); price = d.get('price')
    if not all([cid, pid_p, price is not None]):
        return jsonify({'error': 'customer_id, product_id, price required'}), 400
    now = bkk_now(); base, _ = calc_vat(int(price)); db = get_db()
    with db:
        db.execute(
            """INSERT OR REPLACE INTO customer_prices
               (id,customer_id,product_id,price,price_excl_vat,note,updated_at,updated_by)
               VALUES (?,?,?,?,?,?,?,?)""",
            (new_id(), cid, pid_p, int(price), base, d.get('note',''), now, staff['name'])
        )
        audit(db, staff['id'], staff['name'], 'admin', 'customer_price_set', 'customer', cid,
              {'product_id': pid_p, 'price': price})
    db.close()
    return jsonify({'ok': True})


# ─── Suppliers ───────────────────────────────────────────────────────────────

@admin_bp.route('/suppliers')
@require_auth(ADMIN_ONLY)
def get_suppliers():
    db = get_db(); rows = db.execute("SELECT * FROM suppliers ORDER BY name").fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/suppliers', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_supplier():
    staff = g.actor; d = request.get_json(silent=True) or {}; sid = new_id(); db = get_db()
    with db:
        db.execute(
            "INSERT INTO suppliers (id,name,brand,phone,address,tax_id,credit_days,balance,note,active) VALUES (?,?,?,?,?,?,?,0,?,1)",
            (sid, d.get('name',''), d.get('brand',''), d.get('phone',''),
             d.get('address',''), d.get('tax_id',''), d.get('credit_days',30), d.get('note',''))
        )
        audit(db, staff['id'], staff['name'], 'admin', 'supplier_created', 'supplier', sid)
    db.close()
    return jsonify({'id': sid}), 201


@admin_bp.route('/suppliers/<sid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_supplier(sid):
    d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE suppliers SET name=COALESCE(?,name), brand=COALESCE(?,brand),
               phone=COALESCE(?,phone), address=COALESCE(?,address),
               tax_id=COALESCE(?,tax_id), credit_days=COALESCE(?,credit_days),
               note=COALESCE(?,note), active=COALESCE(?,active) WHERE id=?""",
            (d.get('name'), d.get('brand'), d.get('phone'), d.get('address'),
             d.get('tax_id'), d.get('credit_days'), d.get('note'), d.get('active'), sid)
        )
    db.close()
    return jsonify({'ok': True})


@admin_bp.route('/suppliers/<sid>/statement')
@require_auth(ADMIN_ONLY)
def supplier_statement(sid):
    db  = get_db(); sup = db.execute("SELECT * FROM suppliers WHERE id=?", (sid,)).fetchone()
    if not sup: db.close(); return jsonify({'error': 'Not found'}), 404
    invoices = db.execute("SELECT * FROM restock_invoices WHERE supplier_id=? ORDER BY date DESC", (sid,)).fetchall()
    payments = db.execute("SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY date DESC", (sid,)).fetchall()
    db.close()
    return jsonify({'supplier': dict(sup), 'invoices': [dict(r) for r in invoices], 'payments': [dict(r) for r in payments]})


@admin_bp.route('/suppliers/<sid>/payment', methods=['POST'])
@require_auth(ADMIN_ONLY)
def supplier_payment(sid):
    staff = g.actor; d = request.get_json(silent=True) or {}
    amount = float(d.get('amount', 0))
    if amount <= 0: return jsonify({'error': 'amount required'}), 400
    now = bkk_now(); today = now[:10]; db = get_db(); pay_id = new_id()
    with db:
        db.execute(
            "INSERT INTO supplier_payments (id,supplier_id,date,amount,invoices_json,method,note,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (pay_id, sid, today, amount, json.dumps(d.get('invoice_ids',[])),
             d.get('method','โอน'), d.get('note',''), now)
        )
        db.execute("UPDATE suppliers SET balance=MAX(0,balance-?) WHERE id=?", (amount, sid))
        for inv_id in d.get('invoice_ids', []):
            db.execute("UPDATE restock_invoices SET status='paid' WHERE id=?", (inv_id,))
        audit(db, staff['id'], staff['name'], 'admin', 'supplier_payment', 'supplier', sid,
              {'amount': amount, 'invoices': d.get('invoice_ids',[])})
    db.close()
    return jsonify({'ok': True})


# ─── Restock ─────────────────────────────────────────────────────────────────

@admin_bp.route('/restock')
@require_auth(ADMIN_ONLY)
def get_restock():
    db   = get_db()
    rows = db.execute(
        """SELECT ri.*, s.name as supplier_name
           FROM restock_invoices ri
           LEFT JOIN suppliers s ON s.id=ri.supplier_id
           ORDER BY ri.date DESC LIMIT 100"""
    ).fetchall()
    result = []
    for r in rows:
        inv   = dict(r)
        items = db.execute(
            "SELECT ri2.*, p.name as product_name FROM restock_items ri2 JOIN products p ON p.id=ri2.product_id WHERE ri2.invoice_id=?",
            (inv['id'],)
        ).fetchall()
        inv['items'] = [dict(i) for i in items]
        result.append(inv)
    db.close()
    return jsonify(result)


# ─── Expenses ────────────────────────────────────────────────────────────────

@admin_bp.route('/expenses')
@require_auth(ADMIN_ONLY)
def get_expenses():
    db = get_db()
    date_from = request.args.get('from', ''); date_to = request.args.get('to', bkk_now()[:10])
    sql, params = "SELECT * FROM expenses WHERE 1=1", []
    if date_from: sql += " AND date>=?"; params.append(date_from)
    sql += " AND date<=? ORDER BY date DESC, created_at DESC LIMIT 200"; params.append(date_to)
    rows = db.execute(sql, params).fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/expenses', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_expense():
    staff = g.actor; d = request.get_json(silent=True) or {}; eid = new_id(); now = bkk_now()
    today = d.get('date', now[:10]); db = get_db()
    with db:
        db.execute(
            "INSERT INTO expenses (id,date,created_at,category,type,to_party,amount,vat_amount,doc_type,doc_no,note,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (eid, today, now, d.get('category','operating'), d.get('type',''),
             d.get('to_party',''), int(d.get('amount',0)), int(d.get('vat_amount',0)),
             d.get('doc_type','cash'), d.get('doc_no',''), d.get('note',''), staff['name'])
        )
        audit(db, staff['id'], staff['name'], 'admin', 'expense_added', 'expense', eid,
              {'amount': d.get('amount'), 'type': d.get('type')})
    db.close()
    return jsonify({'id': eid}), 201


@admin_bp.route('/expenses/<eid>', methods=['DELETE'])
@require_auth(ADMIN_ONLY)
def delete_expense(eid):
    staff = g.actor; db = get_db()
    with db:
        db.execute("DELETE FROM expenses WHERE id=?", (eid,))
        audit(db, staff['id'], staff['name'], 'admin', 'expense_deleted', 'expense', eid)
    db.close()
    return jsonify({'ok': True})


# ─── VAT Report ───────────────────────────────────────────────────────────────

@admin_bp.route('/vat-report')
@require_auth(ADMIN_ONLY)
def vat_report():
    period = request.args.get('period', bkk_now()[:7]); db = get_db()
    output    = db.execute("SELECT * FROM vat_output WHERE tax_month=? AND is_cancelled=0 ORDER BY date", (period,)).fetchall()
    inp       = db.execute("SELECT * FROM vat_input WHERE tax_month=? ORDER BY date", (period,)).fetchall()
    out_total = db.execute("SELECT COALESCE(SUM(vat_amount),0) FROM vat_output WHERE tax_month=? AND is_cancelled=0", (period,)).fetchone()[0]
    in_total  = db.execute("SELECT COALESCE(SUM(vat_amount),0) FROM vat_input WHERE tax_month=?", (period,)).fetchone()[0]
    db.close()
    return jsonify({'period': period, 'output': [dict(r) for r in output], 'input': [dict(r) for r in inp],
                    'output_vat': out_total, 'input_vat': in_total, 'payable': round(out_total - in_total, 2)})


# ─── Staff ───────────────────────────────────────────────────────────────────

@admin_bp.route('/staff')
@require_auth(ADMIN_ONLY)
def get_staff():
    db   = get_db()
    rows = db.execute(
        "SELECT id,name,phone,role,vehicle,active,salary,commission_per_order,start_date,created_at FROM staff ORDER BY name"
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/staff', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_staff():
    staff = g.actor; d = request.get_json(silent=True) or {}
    if not d.get('name') or not d.get('pin'):
        return jsonify({'error': 'name and pin required'}), 400
    sid = new_id(); now = bkk_now(); db = get_db()
    with db:
        db.execute(
            """INSERT INTO staff
               (id,name,phone,role,pin,vehicle,active,note,salary,commission_per_order,start_date,created_at)
               VALUES (?,?,?,?,?,?,1,?,?,?,?,?)""",
            (sid, d['name'], d.get('phone',''), d.get('role','driver'),
             str(d['pin']), d.get('vehicle','bike'), d.get('note',''),
             d.get('salary',0), d.get('commission_per_order',0), d.get('start_date',''), now)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'staff_created', 'staff', sid,
              {'name': d['name'], 'role': d.get('role','driver')})
    db.close()
    return jsonify({'id': sid}), 201


@admin_bp.route('/staff/<sid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_staff(sid):
    staff = g.actor; d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE staff SET name=COALESCE(?,name), phone=COALESCE(?,phone),
               role=COALESCE(?,role), pin=COALESCE(?,pin), vehicle=COALESCE(?,vehicle),
               active=COALESCE(?,active), salary=COALESCE(?,salary),
               commission_per_order=COALESCE(?,commission_per_order), note=COALESCE(?,note)
               WHERE id=?""",
            (d.get('name'), d.get('phone'), d.get('role'), str(d['pin']) if 'pin' in d else None,
             d.get('vehicle'), d.get('active'), d.get('salary'),
             d.get('commission_per_order'), d.get('note'), sid)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'staff_updated', 'staff', sid)
    db.close()
    return jsonify({'ok': True})


# ─── Tare Bonus Rules ────────────────────────────────────────────────────────

@admin_bp.route('/tare-bonus-rules')
@require_auth(ADMIN_ONLY)
def get_tare_rules():
    db = get_db(); rows = db.execute("SELECT * FROM tare_bonus_rules ORDER BY updated_at DESC").fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/tare-bonus-rules', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_tare_rule():
    staff = g.actor; d = request.get_json(silent=True) or {}; rid = new_id(); now = bkk_now(); db = get_db()
    with db:
        db.execute(
            "INSERT INTO tare_bonus_rules (id,name,rate_per_kg,active,updated_by,updated_at) VALUES (?,?,?,?,?,?)",
            (rid, d.get('name','เงินได้พิเศษแก๊สเหลือ'), d.get('rate_per_kg',5.0), d.get('active',1), staff['name'], now)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'tare_rule_created', 'tare_bonus_rules', rid)
    db.close()
    return jsonify({'id': rid}), 201


@admin_bp.route('/tare-bonus-rules/<rid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_tare_rule(rid):
    staff = g.actor; d = request.get_json(silent=True) or {}; now = bkk_now(); db = get_db()
    with db:
        db.execute(
            """UPDATE tare_bonus_rules SET name=COALESCE(?,name),
               rate_per_kg=COALESCE(?,rate_per_kg), active=COALESCE(?,active),
               updated_by=?, updated_at=? WHERE id=?""",
            (d.get('name'), d.get('rate_per_kg'), d.get('active'), staff['name'], now, rid)
        )
        audit(db, staff['id'], staff['name'], 'admin', 'tare_rule_updated', 'tare_bonus_rules', rid)
    db.close()
    return jsonify({'ok': True})


# ─── Staff Bonus Log ─────────────────────────────────────────────────────────

@admin_bp.route('/staff-bonus-log')
@require_auth(ADMIN_ONLY)
def get_bonus_log():
    db        = get_db()
    staff_id  = request.args.get('staff_id', '')
    date_from = request.args.get('from', '')
    date_to   = request.args.get('to', bkk_now()[:10])
    sql, params = "SELECT * FROM staff_bonus_log WHERE 1=1", []
    if staff_id: sql += " AND staff_id=?"; params.append(staff_id)
    if date_from: sql += " AND created_at>=?"; params.append(date_from)
    sql += " AND created_at<=? ORDER BY created_at DESC LIMIT 200"; params.append(date_to + ' 23:59:59')
    rows = db.execute(sql, params).fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


# ─── Translations (admin CRUD) ───────────────────────────────────────────────

@admin_bp.route('/translations')
@require_auth(ADMIN_ONLY)
def get_translations():
    db   = get_db()
    lang = request.args.get('lang', '')
    sql  = "SELECT * FROM translations WHERE 1=1"
    params = []
    if lang: sql += " AND lang_code=?"; params.append(lang)
    sql += " ORDER BY lang_code, key"
    rows = db.execute(sql, params).fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/translations', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def upsert_translation():
    d = request.get_json(silent=True) or {}
    lang_code = d.get('lang_code'); key = d.get('key'); value = d.get('value')
    if not all([lang_code, key, value is not None]):
        return jsonify({'error': 'lang_code, key, value required'}), 400
    db = get_db()
    with db:
        db.execute(
            "INSERT OR REPLACE INTO translations (id,lang_code,key,value) VALUES (?,?,?,?)",
            (new_id(), lang_code, key, value)
        )
    db.close()
    return jsonify({'ok': True})


# ─── Audit Log ───────────────────────────────────────────────────────────────

@admin_bp.route('/audit')
@require_auth(ADMIN_ONLY)
def get_audit():
    db    = get_db()
    date  = request.args.get('date', ''); actor = request.args.get('actor', '')
    action = request.args.get('action', ''); limit = int(request.args.get('limit', 100))
    sql, params = "SELECT * FROM audit_log WHERE 1=1", []
    if date:   sql += " AND timestamp LIKE ?"; params.append(f'{date}%')
    if actor:  sql += " AND actor_name LIKE ?"; params.append(f'%{actor}%')
    if action: sql += " AND action=?"; params.append(action)
    sql += " ORDER BY timestamp DESC LIMIT ?"; params.append(limit)
    rows = db.execute(sql, params).fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


# ─── Settings ────────────────────────────────────────────────────────────────

@admin_bp.route('/settings')
@require_auth(ADMIN_ONLY)
def get_settings():
    db   = get_db()
    rows = db.execute("SELECT key,val FROM settings").fetchall()
    db.close()
    return jsonify({r['key']: r['val'] for r in rows})


@admin_bp.route('/settings', methods=['POST'])
@require_auth(ADMIN_ONLY)
def update_settings():
    staff = g.actor; d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        for k, v in d.items():
            db.execute("INSERT OR REPLACE INTO settings(key,val) VALUES(?,?)", (k, str(v)))
        audit(db, staff['id'], staff['name'], 'admin', 'settings_updated', 'settings', '', list(d.keys()))
    db.close()
    # Reload settings cache
    try:
        import server as srv
        srv.load_settings()
    except Exception:
        pass
    return jsonify({'ok': True})


# ─── Fees (CRUD) ─────────────────────────────────────────────────────────────

@admin_bp.route('/fees')
@require_auth(ADMIN_ONLY)
def get_fees():
    db = get_db(); rows = db.execute("SELECT * FROM fees ORDER BY sort_order").fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/fees', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_fee():
    d = request.get_json(silent=True) or {}; fid = new_id(); db = get_db()
    with db:
        db.execute(
            "INSERT INTO fees (id,name,type,amount,condition_type,condition_value,active,sort_order) VALUES (?,?,?,?,?,?,?,?)",
            (fid, d.get('name',''), d.get('type','fixed'), d.get('amount',0),
             d.get('condition_type',''), d.get('condition_value',''),
             d.get('active',1), d.get('sort_order',0))
        )
    db.close()
    return jsonify({'id': fid}), 201


@admin_bp.route('/fees/<fid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_fee(fid):
    d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE fees SET name=COALESCE(?,name), type=COALESCE(?,type),
               amount=COALESCE(?,amount), condition_type=COALESCE(?,condition_type),
               condition_value=COALESCE(?,condition_value),
               active=COALESCE(?,active), sort_order=COALESCE(?,sort_order) WHERE id=?""",
            (d.get('name'), d.get('type'), d.get('amount'), d.get('condition_type'),
             d.get('condition_value'), d.get('active'), d.get('sort_order'), fid)
        )
    db.close()
    return jsonify({'ok': True})


@admin_bp.route('/fees/<fid>', methods=['DELETE'])
@require_auth(ADMIN_ONLY)
def delete_fee(fid):
    db = get_db()
    with db: db.execute("UPDATE fees SET active=0 WHERE id=?", (fid,))
    db.close()
    return jsonify({'ok': True})


# ─── Payment Methods (CRUD) ──────────────────────────────────────────────────

@admin_bp.route('/payment-methods')
@require_auth(ADMIN_ONLY)
def get_payment_methods():
    db = get_db(); rows = db.execute("SELECT * FROM payment_methods ORDER BY sort_order").fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/payment-methods', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_payment_method():
    d = request.get_json(silent=True) or {}; pid = new_id(); db = get_db()
    with db:
        db.execute(
            "INSERT INTO payment_methods (id,name,type,active,require_tier,sort_order,config_json) VALUES (?,?,?,?,?,?,?)",
            (pid, d.get('name',''), d.get('type','cash'), d.get('active',1),
             d.get('require_tier',''), d.get('sort_order',0), json.dumps(d.get('config',{})))
        )
    db.close()
    return jsonify({'id': pid}), 201


@admin_bp.route('/payment-methods/<pid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_payment_method(pid):
    d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE payment_methods SET name=COALESCE(?,name), type=COALESCE(?,type),
               active=COALESCE(?,active), require_tier=COALESCE(?,require_tier),
               sort_order=COALESCE(?,sort_order) WHERE id=?""",
            (d.get('name'), d.get('type'), d.get('active'), d.get('require_tier'), d.get('sort_order'), pid)
        )
    db.close()
    return jsonify({'ok': True})


# ─── Languages (CRUD) ────────────────────────────────────────────────────────

@admin_bp.route('/languages')
@require_auth(ADMIN_ONLY)
def get_languages():
    db = get_db(); rows = db.execute("SELECT * FROM languages ORDER BY sort_order").fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/languages/<code>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_language(code):
    d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE languages SET name=COALESCE(?,name), native_name=COALESCE(?,native_name),
               flag=COALESCE(?,flag), active=COALESCE(?,active), sort_order=COALESCE(?,sort_order)
               WHERE code=?""",
            (d.get('name'), d.get('native_name'), d.get('flag'), d.get('active'), d.get('sort_order'), code)
        )
    db.close()
    return jsonify({'ok': True})


# ─── Spare Parts ─────────────────────────────────────────────────────────────

@admin_bp.route('/spare-parts')
@require_auth(ADMIN_ONLY)
def get_spare_parts():
    db = get_db(); rows = db.execute("SELECT * FROM spare_parts ORDER BY name").fetchall(); db.close()
    return jsonify([dict(r) for r in rows])


@admin_bp.route('/spare-parts', methods=['POST'])
@require_auth(ADMIN_ONLY)
def create_spare_part():
    d = request.get_json(silent=True) or {}; pid = new_id(); db = get_db()
    with db:
        db.execute(
            "INSERT INTO spare_parts (id,name,qty,unit,reorder_point,cost,note) VALUES (?,?,?,?,?,?,?)",
            (pid, d.get('name',''), d.get('qty',0), d.get('unit','ชิ้น'),
             d.get('reorder_point',10), d.get('cost',0), d.get('note',''))
        )
    db.close()
    return jsonify({'id': pid}), 201


@admin_bp.route('/spare-parts/<pid>', methods=['PUT'])
@require_auth(ADMIN_ONLY)
def update_spare_part(pid):
    d = request.get_json(silent=True) or {}; db = get_db()
    with db:
        db.execute(
            """UPDATE spare_parts SET name=COALESCE(?,name), qty=COALESCE(?,qty),
               unit=COALESCE(?,unit), reorder_point=COALESCE(?,reorder_point),
               cost=COALESCE(?,cost), note=COALESCE(?,note) WHERE id=?""",
            (d.get('name'), d.get('qty'), d.get('unit'), d.get('reorder_point'),
             d.get('cost'), d.get('note'), pid)
        )
    db.close()
    return jsonify({'ok': True})


# ─── Stock ───────────────────────────────────────────────────────────────────

@admin_bp.route('/stock')
@require_auth(ADMIN_ONLY)
def get_stock():
    db   = get_db()
    rows = db.execute(
        """SELECT ts.*, p.name, p.brand, p.size_kg, p.ico, p.reorder_point as prod_reorder
           FROM tank_stock ts JOIN products p ON p.id=ts.product_id
           ORDER BY p.sort_order, p.brand, p.size_kg"""
    ).fetchall()
    db.close()
    return jsonify([dict(r) for r in rows])
