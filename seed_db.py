#!/usr/bin/env python3
"""
seed_db.py — Initialize development/testing data.
Run AFTER init_db() has created schema (import from helpers and server).

Usage:
    python3 seed_db.py [--reset]
    
    --reset : Drop and recreate all tables before seeding
"""
import os
import sys
import json
from datetime import datetime, timedelta, timezone
from helpers import get_db, new_id, bkk_now, generate_order_num, audit

BKK = timezone(timedelta(hours=7))

def bkk_date_offset(days: int = 0) -> str:
    """Return date DAYS ago (negative) or in future (positive)."""
    return (datetime.now(BKK) + timedelta(days=days)).strftime('%Y-%m-%d')

def seed_languages(conn):
    """Insert supported languages."""
    langs = [
        ('th', 'Thai', 'ไทย', '🇹🇭', 1, 0),
        ('en', 'English', 'English', '🇺🇸', 1, 1),
    ]
    for code, name, native_name, flag, active, sort_order in langs:
        conn.execute(
            """INSERT OR IGNORE INTO languages 
               (code, name, native_name, flag, active, sort_order)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (code, name, native_name, flag, active, sort_order)
        )
    print("✓ Seeded languages")


def seed_staff(conn):
    """Insert demo staff with PIN 1234."""
    staff_list = [
        ('admin01', 'ธีร์ธวัช', 'admin', '1234', 'car', 1),
        ('sup01', 'สมชาย', 'supervisor', '1234', 'car', 1),
        ('driver01', 'อนุชา', 'driver', '1234', 'bike', 1),
        ('driver02', 'สุรเชษฐ์', 'driver', '1234', 'bike', 1),
    ]
    for username, name, role, pin, vehicle, active in staff_list:
        staff_id = new_id()
        conn.execute(
            """INSERT INTO staff 
               (id, name, phone, role, pin, vehicle, active, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (staff_id, name, '08X-XXX-XXXX', role, pin, vehicle, active, bkk_now())
        )
    print("✓ Seeded staff (PIN: 1234 for all)")


def seed_products(conn):
    """Insert demo LPG products."""
    products = [
        ('ถังแก๊ส 15 กก.', 'LPG Cylinder 15kg', '🔵', 450, 400, 350, 100, 50),
        ('ถังแก๊ส 7 กก.', 'LPG Cylinder 7kg', '🟢', 350, 310, 280, 80, 40),
        ('ถังแก๊ส 4 กก.', 'LPG Cylinder 4kg', '🟡', 250, 220, 190, 60, 30),
    ]
    for name, name_en, ico, price, price_excl, price_transfer, full_qty, empty_qty in products:
        product_id = new_id()
        conn.execute(
            """INSERT INTO products
               (id, name, name_en, ico, size_kg, price, price_excl_vat, 
                price_transfer, cost, status, reorder_point, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (product_id, name, name_en, ico, 15 if '15' in name else (7 if '7' in name else 4),
             price, price_excl, price_transfer, price * 0.6,
             'available', 20, bkk_now())
        )
        # Initialize tank stock
        conn.execute(
            """INSERT INTO tank_stock (id, product_id, full_qty, empty_qty, customer_qty, last_updated)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (new_id(), product_id, full_qty, empty_qty, 0, bkk_now())
        )
    print("✓ Seeded products & tank stock")


def seed_customers(conn):
    """Insert demo customers."""
    customers = [
        ('คุณสมชาย', '08X-111-1111', 'บ้าน', 50.5, 101.5, 0, 0),
        ('ร้านอาหารตามสั่ง', '08X-222-2222', 'shop', 50.3, 101.3, 5000, 30),
        ('สถานีดับเพลิง', '08X-333-3333', 'institution', 50.4, 101.4, 10000, 60),
    ]
    for name, phone, place_type, lat, lng, credit_limit, credit_due_days in customers:
        customer_id = new_id()
        conn.execute(
            """INSERT INTO customers
               (id, name, phone, place_type, lat, lng, 
                credit_approved, credit_limit, credit_due_days, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (customer_id, name, phone, place_type, lat, lng, 1, credit_limit, credit_due_days, bkk_now())
        )
    print("✓ Seeded customers")


def seed_sample_orders(conn):
    """Insert a few sample orders for demo/testing."""
    # Get IDs of first product and customer
    product = conn.execute("SELECT id FROM products LIMIT 1").fetchone()
    customer = conn.execute("SELECT id FROM customers LIMIT 1").fetchone()
    driver = conn.execute("SELECT id FROM staff WHERE role='driver' LIMIT 1").fetchone()
    
    if not (product and customer and driver):
        print("⊘ Skipped orders (missing product/customer/driver)")
        return
    
    statuses = ['pending', 'preparing', 'delivering', 'completed']
    for i in range(4):
        order_id = new_id()
        order_num = generate_order_num(conn)
        status = statuses[i]
        
        # Build items_json
        items = [
            {'product_id': product['id'], 'qty': 2, 'price': 450, 'subtotal': 900}
        ]
        
        total = 900
        vat = round(total * 7 / 107, 2)
        
        conn.execute(
            """INSERT INTO orders
               (id, order_num, date, customer_id, status, order_type,
                items_json, items_summary, total_amount, vat_amount,
                payment_method, paid_at, driver_id, delivered_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                order_id, order_num, bkk_date_offset(-i), customer['id'], status, 'exchange',
                json.dumps(items, ensure_ascii=False), '2x ถังแก๊ส 15กก.',
                total, vat, 'cash', None, driver['id'] if status != 'pending' else None,
                bkk_now() if status == 'completed' else None,
                bkk_now()
            )
        )
    
    conn.commit()
    print("✓ Seeded sample orders")


def main():
    reset = '--reset' in sys.argv
    
    conn = get_db()
    
    if reset:
        print("🔄 Dropping all tables...")
        # This would require importing _create_tables from server.py
        # For now, just warn
        print("   (Manual reset: delete gasshop.db and re-run server.py)")
    
    try:
        seed_languages(conn)
        seed_staff(conn)
        seed_products(conn)
        seed_customers(conn)
        seed_sample_orders(conn)
        
        conn.commit()
        print("\n✅ Seed complete!")
        print("\nDemo credentials (PIN: 1234):")
        print("  Admin:      admin01 / ธีร์ธวัช")
        print("  Supervisor: sup01 / สมชาย")
        print("  Driver:     driver01 / อนุชา")
    except Exception as e:
        conn.rollback()
        print(f"❌ Seed failed: {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
