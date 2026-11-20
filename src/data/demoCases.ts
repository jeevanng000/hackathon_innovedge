import type { DemoCase } from '../types/autopatch';

export const DEMO_CASES: DemoCase[] = [
  {
    id: 'auth-service-none-sub',
    title: 'Auth Service',
    category: 'TypeError + KeyError',
    language: 'python',
    expectedOutcome: 'auto-verified',
    description:
      'Python AST + isolated subprocess: users_db.get(username) returns None for unknown users, raising TypeError on user["password"], while reset_password mutates users_db[username] without checking key existence.',
    filename: 'auth_service.py',
    testFilename: 'test_auth_service.py',
    sourceCode: `def authenticate_user(users_db, username, password):
    """Authenticates a user and checks account status."""
    user = users_db.get(username)
    
    # Bug: Raises AttributeError if user is None (user does not exist)
    if user["password"] == password:
        if user["is_active"]:
            return {"status": "SUCCESS", "role": user.get("role", "member")}
        return {"status": "ACCOUNT_DISABLED", "role": None}
    
    return {"status": "INVALID_CREDENTIALS", "role": None}

def reset_password(users_db, username, new_password):
    """Resets password for an existing user."""
    users_db[username]["password"] = new_password
    return True
`,
    testCode: `from auth_service import authenticate_user, reset_password


def test_authenticate_existing_active_user():
    db = {
        "alice": {"password": "secret-123", "is_active": True, "role": "admin"},
    }
    assert authenticate_user(db, "alice", "secret-123") == {
        "status": "SUCCESS",
        "role": "admin",
    }


def test_authenticate_unknown_user_returns_invalid_credentials():
    db = {
        "alice": {"password": "secret-123", "is_active": True, "role": "admin"},
    }
    assert authenticate_user(db, "ghost_user", "any-pass") == {
        "status": "INVALID_CREDENTIALS",
        "role": None,
    }


def test_authenticate_disabled_account():
    db = {
        "bob": {"password": "pw", "is_active": False},
    }
    assert authenticate_user(db, "bob", "pw") == {
        "status": "ACCOUNT_DISABLED",
        "role": None,
    }


def test_reset_password_existing_and_missing_user():
    db = {
        "alice": {"password": "old", "is_active": True},
    }
    assert reset_password(db, "alice", "new-pw") is True
    assert db["alice"]["password"] == "new-pw"
    assert reset_password(db, "unknown_user", "new-pw") is False
`,
    bugContext: `TypeError: 'NoneType' object is not subscriptable
  File "backend/auth_service.py", line 6, in authenticate_user
    if user["password"] == password:`,
  },
  {
    id: 'pricing-zero-div',
    title: 'Pricing Engine',
    category: 'ZeroDivisionError',
    language: 'python',
    expectedOutcome: 'auto-verified',
    description:
      'Python AST + isolated subprocess: computes average unit price across cart line items without guarding against empty carts.',
    filename: 'pricing_engine.py',
    testFilename: 'test_pricing_engine.py',
    sourceCode: `def calculate_average_unit_price(items):
    """Return average unit price across a list of item price dicts."""
    total_revenue = sum(item["price"] * item["qty"] for item in items)
    total_units = sum(item["qty"] for item in items)
    return round(total_revenue / total_units, 2)


def apply_bulk_discount(subtotal, rate=0.10):
    """Apply a bounded bulk discount percentage to a positive subtotal."""
    if subtotal <= 0:
        return 0.0
    return round(subtotal * (1.0 - rate), 2)
`,
    testCode: `from pricing_engine import calculate_average_unit_price, apply_bulk_discount


def test_standard_cart_average():
    cart = [
        {"price": 20.0, "qty": 2},
        {"price": 50.0, "qty": 1},
    ]
    assert calculate_average_unit_price(cart) == 30.0


def test_single_item_average():
    cart = [{"price": 12.5, "qty": 4}]
    assert calculate_average_unit_price(cart) == 12.5


def test_empty_cart_returns_zero():
    assert calculate_average_unit_price([]) == 0.0


def test_bulk_discount_regression():
    assert apply_bulk_discount(100.0, 0.15) == 85.0
    assert apply_bulk_discount(0.0, 0.15) == 0.0
`,
  },
  {
    id: 'discount-sbfl-mutation',
    title: 'Tier Discount Rules',
    category: 'SBFL + Mutation',
    language: 'python',
    expectedOutcome: 'auto-verified',
    description:
      'Python sys.settrace SBFL (Ochiai / Tarantula) localizes a boundary bug (> instead of >=) and repairs it via Search-Based Mutation APR.',
    filename: 'discount_rules.py',
    testFilename: 'test_discount_rules.py',
    sourceCode: `def calculate_shipping_fee(order_total, is_express=False):
    """Orders of $100 or more qualify for free standard shipping."""
    if is_express:
        return 19.99
    if order_total > 100:
        return 0.0
    return 9.99


def apply_loyalty_credit(subtotal, points):
    """Deduct $1 per 100 loyalty points without going negative."""
    credit = (points // 100) * 1.0
    return max(0.0, round(subtotal - credit, 2))
`,
    testCode: `from discount_rules import calculate_shipping_fee, apply_loyalty_credit


def test_express_shipping_always_charged():
    assert calculate_shipping_fee(250.0, is_express=True) == 19.99


def test_below_threshold_pays_standard_shipping():
    assert calculate_shipping_fee(49.50) == 9.99


def test_exact_threshold_qualifies_for_free_shipping():
    assert calculate_shipping_fee(100.0) == 0.0


def test_above_threshold_qualifies_for_free_shipping():
    assert calculate_shipping_fee(145.0) == 0.0


def test_loyalty_credit_regression():
    assert apply_loyalty_credit(50.0, 500) == 45.0
`,
  },
  {
    id: 'ts-cart-index',
    title: 'Cart Subtotal (TS)',
    category: 'IndexError',
    language: 'typescript',
    expectedOutcome: 'auto-verified',
    description:
      'TypeScript esbuild + isolated Node.js sandbox: off-by-one loop bound (i <= items.length) crashes reading undefined item.',
    filename: 'cart_totals.ts',
    testFilename: 'test_cart_totals.ts',
    sourceCode: `export interface CartItem {
  sku: string;
  price: number;
  qty: number;
}

export function sumCartSubtotal(items: CartItem[]): number {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  return Math.round(total * 100) / 100;
}

export function countDistinctSkus(items: CartItem[]): number {
  return new Set(items.map((item) => item.sku)).size;
}
`,
    testCode: `import assert from 'node:assert/strict';
import { sumCartSubtotal, countDistinctSkus } from './cart_totals';

export function test_standard_cart_subtotal() {
  const cart = [
    { sku: 'A-1', price: 15.5, qty: 2 },
    { sku: 'B-2', price: 9.0, qty: 1 },
  ];
  assert.equal(sumCartSubtotal(cart), 40.0);
}

export function test_empty_cart_subtotal() {
  assert.equal(sumCartSubtotal([]), 0);
}

export function test_distinct_sku_regression() {
  const cart = [
    { sku: 'A-1', price: 5, qty: 1 },
    { sku: 'A-1', price: 5, qty: 2 },
    { sku: 'C-9', price: 12, qty: 1 },
  ];
  assert.equal(countDistinctSkus(cart), 2);
}
`,
  },
  {
    id: 'c-telemetry-div',
    title: 'Telemetry Math (C)',
    category: 'ZeroDivisionError',
    language: 'c',
    expectedOutcome: 'auto-verified',
    description:
      'GCC compiler + isolated native C binary sandbox: divides latency sum by sample count without guarding count == 0.',
    filename: 'telemetry_math.c',
    testFilename: 'test_telemetry_math.c',
    sourceCode: `#include <stddef.h>

double compute_average_latency(const int *samples, int count) {
    long total = 0;
    for (int i = 0; i < count; i++) {
        total += samples[i];
    }
    return (double)total / count;
}

int compute_peak_latency(const int *samples, int count) {
    if (count <= 0 || samples == NULL) {
        return 0;
    }
    int peak = samples[0];
    for (int i = 1; i < count; i++) {
        if (samples[i] > peak) {
            peak = samples[i];
        }
    }
    return peak;
}
`,
    testCode: `#include <stdio.h>
#include <math.h>
#include "telemetry_math.c"

int main(void) {
    int failed = 0;

    int standard[] = {10, 20, 30};
    double avg1 = compute_average_latency(standard, 3);
    if (fabs(avg1 - 20.0) < 0.001) {
        printf("PASS:test_standard_latency_average\\n");
    } else {
        printf("FAIL:test_standard_latency_average:Expected 20.0, got %.2f\\n", avg1);
        failed++;
    }

    int empty[] = {0};
    double avg2 = compute_average_latency(empty, 0);
    if (!isnan(avg2) && fabs(avg2 - 0.0) < 0.001) {
        printf("PASS:test_empty_samples_returns_zero\\n");
    } else {
        printf("FAIL:test_empty_samples_returns_zero:Zero division produced NaN or non-zero result\\n");
        failed++;
    }

    int peak = compute_peak_latency(standard, 3);
    if (peak == 30) {
        printf("PASS:test_peak_latency_regression\\n");
    } else {
        printf("FAIL:test_peak_latency_regression:Expected 30, got %d\\n", peak);
        failed++;
    }

    return failed > 0 ? 1 : 0;
}
`,
  },
  {
    id: 'java-order-taint',
    title: 'Order Query (Java)',
    category: 'Taint + CFG',
    language: 'java',
    expectedOutcome: 'auto-verified',
    description:
      'Universal static CFG & taint verifier: detects SQL injection string concatenation, off-by-one loop bound, and unreachable dead code in Java.',
    filename: 'OrderQuery.java',
    testFilename: 'OrderQueryTest.java',
    sourceCode: `public class OrderQuery {
    public String buildLookupSql(String customerId) {
        String sql = "SELECT id, total FROM orders WHERE customer_id = " + customerId;
        return sql;
        String unreachableLog = "stale";
    }

    public int countValidIds(String[] ids) {
        int valid = 0;
        for (int i = 0; i <= ids.length; i++) {
            if (ids[i] != null && !ids[i].isEmpty()) {
                valid++;
            }
        }
        return valid;
    }
}
`,
    testCode: `// Universal static CFG, bounds, and taint verifier checks OrderQuery.java
// 1. Parameterized SQL query safety (no dynamic concatenation)
// 2. 0-based loop boundary integrity (i < ids.length)
// 3. Control-flow reachability (zero dead statements after return)
`,
  },
  {
    id: 'retry-loop-blocked',
    title: 'Retry Queue Worker',
    category: 'InfiniteLoopTimeout',
    language: 'python',
    expectedOutcome: 'blocked-review',
    description:
      'Re-queues malformed payloads forever without a dead-letter policy; triggers 2.0s sandbox timeout and Trust Gate block requiring human review.',
    filename: 'retry_worker.py',
    testFilename: 'test_retry_worker.py',
    sourceCode: `def drain_job_queue(jobs):
    """Process jobs until the queue empties. Re-queue jobs missing 'payload'."""
    queue = list(jobs)
    processed = []
    while queue:
        current = queue.pop(0)
        if "payload" not in current:
            queue.append(current)
            continue
        processed.append(current["payload"])
    return processed
`,
    testCode: `from retry_worker import drain_job_queue


def test_valid_jobs_complete():
    jobs = [{"id": 1, "payload": "alpha"}, {"id": 2, "payload": "beta"}]
    assert drain_job_queue(jobs) == ["alpha", "beta"]


def test_malformed_job_does_not_hang():
    jobs = [{"id": 1, "payload": "alpha"}, {"id": 2}]
    result = drain_job_queue(jobs)
    assert result == ["alpha"]
`,
  },
];
