import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { OfflineStore } from "../local/offline-store.mjs";
import { TableOrders } from "../local/table-orders.mjs";

const initial = () => ({
  products: [{ id: "product-1", name: "Lanche", category: "lanche", active: true, price: 10.1,
    recipe: [{ ingredientId: "ingredient-1", quantity: 1 }],
    addons: [{ name: "Queijo", price: 1.05, cost: 0.5 }] }],
  ingredients: [{ id: "ingredient-1", cost: 5 }],
  sales: [], cashSessions: [{ id: "cash-1", openedAt: "2026-01-01T10:00:00Z" }],
  financeEntries: []
});
const item = () => ({
  productId: "product-1", optionName: "Padrão", quantity: 2, addonIndexes: [0]
});

test("open orders are not sales; paid closure produces exactly one cash receipt", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 2);
  const service = new TableOrders(store, "store");
  const { tableId } = service.createTable("create-1", "Mesa 1");
  const { orderId, total } = service.addItems("add-1", tableId, null, [item()]);
  assert.equal(total, 22.3);
  assert.equal(store.read("store").snapshot.sales.length, 0);
  assert.equal(service.addItems("add-2", tableId, orderId, [item()]).total, 44.6);
  const closed = service.closeOrder("close-1", tableId, orderId, "Pix");
  assert.deepEqual(service.closeOrder("close-1", tableId, orderId, "Pix"), closed);
  assert.throws(() => service.closeOrder("close-again", tableId, orderId, "Pix"), /no longer open/);
  const state = store.read("store").snapshot;
  assert.equal(state.tables[0].order, null);
  assert.equal(state.sales.length, 1);
  assert.equal(state.sales[0].tableOrderId, orderId);

  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("      function cashSessionForDate(");
  const end = html.indexOf("      function financeBalance(", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    state, allSales: () => state.sales, number: value => Number(value) || 0,
    paymentMethodForSale: sale => sale.payment
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  const receipts = context.cashSessionReceipts("cash-1");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receiptAmount, 44.6);
});

test("retries survive restart and another connection cannot overwrite added items", t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-tables-"));
  const filename = join(directory, "store.sqlite");
  let first = new OfflineStore(filename);
  const second = new OfflineStore(filename);
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  first.initialize("store", initial(), 0);
  const firstService = new TableOrders(first, "store");
  const secondService = new TableOrders(second, "store");
  const { tableId } = firstService.createTable("create", "Mesa 2");
  const saved = firstService.addItems("request-1", tableId, null, [item()]);
  secondService.addItems("request-2", tableId, saved.orderId, [item()]);
  first.close();
  first = new OfflineStore(filename);
  const reopened = new TableOrders(first, "store");
  assert.deepEqual(reopened.addItems("request-1", tableId, null, [item()]), saved);
  assert.equal(first.read("store").snapshot.tables[0].order.items.length, 2);
  assert.throws(() => reopened.addItems("request-1", tableId, null, [{ ...item(), quantity: 3 }]), /different data/);
  assert.throws(() => reopened.createTable("other", "mesa 2"), /already exists/);
});

test("failed or stale commands leave the order and sales unchanged", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const data = initial();
  data.cashSessions = [];
  store.initialize("store", data, 0);
  const service = new TableOrders(store, "store");
  const { tableId } = service.createTable("create", "Mesa 3");
  const { orderId } = service.addItems("add", tableId, null, [item()]);
  const before = store.read("store");
  assert.throws(() => service.closeOrder("close", tableId, orderId, "Dinheiro"), /open cash/);
  assert.throws(() => service.addItems("invalid", tableId, orderId, [{ ...item(), price: -1 }]), /Unexpected/);
  assert.throws(() => service.addItems("invalid", tableId, orderId, [{ ...item(), quantity: 1.5 }]), /quantity/);
  assert.deepEqual(store.read("store"), before);
  const opened = before.snapshot;
  opened.cashSessions.push({ id: "cash-new", openedAt: "2026-01-01T10:00:00Z" });
  store.save("store", opened, before.localRevision);
  service.closeOrder("close", tableId, orderId, "Dinheiro");
  const newOrder = service.addItems("new", tableId, null, [item()]);
  assert.notEqual(newOrder.orderId, orderId);
  assert.throws(() => service.closeOrder("stale-close", tableId, orderId, "Pix"), /no longer open/);
  assert.throws(() => service.addItems("stale-add", tableId, orderId, [item()]), /order changed/);
  assert.equal(store.read("store").snapshot.tables[0].order.id, newOrder.orderId);
});
