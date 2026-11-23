import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = readFileSync(new URL("../supabase/functions/_shared/mercadopago.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function reconcilePayment(");
assert.ok(start >= 0);
const javascript = stripTypeScriptTypes(source.slice(start).replace("export async function", "async function"));
const context = vm.createContext({ Date, Number, Math, String, Error });
vm.runInContext(javascript, context);
const reconcile = context.reconcilePayment;

const initialOrder = () => ({
  id: "order-1", business_id: "business-1", total: 25,
  status: "Aguardando Pix", payment_id: null, payment_status: "pending", paid_at: null
});
const payment = (status = "approved") => ({
  id: "payment-1", status, external_reference: "order-1", transaction_amount: 25, currency_id: "BRL"
});

function fakeDatabase(initial = initialOrder()) {
  const db = { order: structuredClone(initial), beforeUpdate: null, updates: 0 };
  db.client = {
    from(table) {
      assert.equal(table, "online_orders");
      const filters = [];
      let update = null;
      const query = {
        select() { return query; },
        update(value) { update = value; return query; },
        eq(field, value) { filters.push([field, value]); return query; },
        is(field, value) { filters.push([field, value]); return query; },
        async maybeSingle() {
          if (update) {
            db.updates++;
            if (db.beforeUpdate) await db.beforeUpdate(db);
          }
          if (!db.order || filters.some(([field, value]) => db.order[field] !== value)) {
            return { data: null, error: null };
          }
          if (update) {
            Object.assign(db.order, update);
            return { data: { id: db.order.id }, error: null };
          }
          return { data: structuredClone(db.order), error: null };
        }
      };
      return query;
    }
  };
  return db;
}

test("retries after an order advances without reverting delivery status", async () => {
  const db = fakeDatabase();
  db.beforeUpdate = database => {
    database.beforeUpdate = null;
    database.order.status = "Em preparo";
  };
  const result = await reconcile(db.client, payment(), "business-1");
  assert.equal(result.paymentStatus, "approved");
  assert.equal(db.updates, 2);
  assert.equal(db.order.status, "Em preparo");
  assert.equal(db.order.payment_status, "approved");
  assert.equal(db.order.payment_id, "payment-1");
  assert.ok(db.order.paid_at);
});

test("a later webhook can reconcile a pending order after the Pix creation response was lost", async () => {
  const db = fakeDatabase();
  const result = await reconcile(db.client, payment(), "business-1");
  assert.equal(result.paymentStatus, "approved");
  assert.equal(db.order.payment_status, "approved");
  assert.equal(db.order.status, "Recebido");
  assert.equal(db.order.payment_id, "payment-1");
  assert.ok(db.order.paid_at);
});

test("an older pending, rejected or cancelled response cannot undo an approved payment", async () => {
  for (const status of ["pending", "rejected", "cancelled"]) {
    const db = fakeDatabase();
    db.beforeUpdate = database => {
      database.beforeUpdate = null;
      Object.assign(database.order, {
        status: "Recebido", payment_status: "approved", payment_id: "payment-1",
        paid_at: "2026-01-01T10:00:00.000Z"
      });
    };
    const result = await reconcile(db.client, payment(status), "business-1");
    assert.equal(result.paymentStatus, "approved");
    assert.equal(db.order.status, "Recebido");
    assert.equal(db.order.paid_at, "2026-01-01T10:00:00.000Z");
  }
});

test("a refund can replace an approval but later approval cannot reverse the refund", async () => {
  const db = fakeDatabase({
    ...initialOrder(), status: "Recebido", payment_status: "approved",
    payment_id: "payment-1", paid_at: "2026-01-01T10:00:00.000Z"
  });
  assert.equal((await reconcile(db.client, payment("refunded"), "business-1")).paymentStatus, "refunded");
  assert.equal(db.order.status, "Cancelado");
  assert.equal(db.order.paid_at, "2026-01-01T10:00:00.000Z");
  assert.equal((await reconcile(db.client, payment("approved"), "business-1")).paymentStatus, "refunded");
  assert.equal(db.order.payment_status, "refunded");
});

test("refund is not overwritten by an older approval and conflicting payment IDs fail", async () => {
  const refunded = fakeDatabase();
  refunded.beforeUpdate = database => {
    database.beforeUpdate = null;
    Object.assign(database.order, { payment_status: "refunded", status: "Cancelado", payment_id: "payment-1" });
  };
  const result = await reconcile(refunded.client, payment(), "business-1");
  assert.equal(result.paymentStatus, "refunded");
  assert.equal(refunded.order.payment_status, "refunded");
  assert.equal(refunded.order.status, "Cancelado");

  const conflicting = fakeDatabase();
  conflicting.beforeUpdate = database => {
    database.beforeUpdate = null;
    database.order.payment_id = "another-payment";
  };
  await assert.rejects(reconcile(conflicting.client, payment(), "business-1"), /Payment ID does not match/);
  assert.equal(conflicting.order.payment_id, "another-payment");
});

test("failed comparisons do not return a success and validation rejects invalid payment data", async () => {
  const db = fakeDatabase();
  db.beforeUpdate = database => {
    database.order.status = database.order.status === "Aguardando Pix" ? "Recebido" : "Aguardando Pix";
  };
  await assert.rejects(reconcile(db.client, payment(), "business-1"), /conflicted/);
  assert.equal(db.updates, 5);
  assert.equal(db.order.payment_status, "pending");
  for (const amount of [undefined, NaN, Infinity, 50]) {
    const invalid = fakeDatabase();
    await assert.rejects(reconcile(invalid.client, { ...payment(), transaction_amount: amount }, "business-1"),
      /amount or currency/);
    assert.equal(invalid.updates, 0);
  }
  await assert.rejects(reconcile(fakeDatabase().client, payment(), "other-business"), /specified store/);
});
