import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { OfflineStore } from "../local/offline-store.mjs";
import { LocalSales } from "../local/local-sales.mjs";
import { TableOrders } from "../local/table-orders.mjs";

const initial = () => ({
  products: [{ id: "p1", name: "Suco", category: "bebida", active: true, price: 10.1, cost: 4, addons: [] }],
  ingredients: [], sales: [], cashSessions: [], financeEntries: []
});
const items = () => [{ productId: "p1", optionName: "Padrão", quantity: 2 }];

function applicationCashReceipts(state, sessionId) {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf("      function cashSessionForDate(");
  const end = html.indexOf("      function financeBalance(", start);
  assert.ok(start >= 0 && end > start);
  const context = { state, allSales: () => state.sales, number: value => Number(value) || 0,
    paymentMethodForSale: sale => sale.payment };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context.cashSessionReceipts(sessionId);
}

test("local sale and table closure contribute exactly once to application cash receipts", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 2);
  const sales = new LocalSales(store, "store");
  const tables = new TableOrders(store, "store");
  const cash = sales.openCash("open", 25, "início");
  assert.deepEqual(sales.openCash("open", 25, "início"), cash);
  assert.throws(() => sales.openCash("other-open", 0), /already open/);
  const sale = sales.recordSale("sale", items(), "Dinheiro", true);
  assert.equal(sale.total, 20.2);
  assert.deepEqual(sales.recordSale("sale", items(), "Dinheiro", true), sale);
  sales.recordSale("pending", items(), "Pix", false);
  const table = tables.createTable("table", "Mesa 1");
  const order = tables.addItems("items", table.tableId, null, items());
  assert.equal(applicationCashReceipts(store.read("store").snapshot, cash.cashSessionId).length, 1);
  tables.closeOrder("close", table.tableId, order.orderId, "Pix");
  const state = store.read("store").snapshot;
  const receipts = applicationCashReceipts(state, cash.cashSessionId);
  assert.equal(receipts.length, 2);
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.receiptAmount, 0), 40.4);
  assert.equal(state.sales.find(item => item.id === sale.saleId).cashSessionId, cash.cashSessionId);
  assert.equal(state.sales.filter(item => !item.paid)[0].cashSessionId, null);
});

test("commands survive restart, are idempotent and reject reused IDs with different data", t => {
  const directory = mkdtempSync(join(tmpdir(), "local-sales-"));
  const filename = join(directory, "store.sqlite");
  let first = new OfflineStore(filename);
  const second = new OfflineStore(filename);
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  first.initialize("store", initial(), 0);
  const service = new LocalSales(first, "store");
  const cash = service.openCash("open", 10);
  const sale = service.recordSale("sale", items(), "Pix", true);
  new LocalSales(second, "store").recordSale("second", items(), "Dinheiro", true);
  first.close();
  first = new OfflineStore(filename);
  const reopened = new LocalSales(first, "store");
  assert.deepEqual(reopened.openCash("open", 10), cash);
  assert.deepEqual(reopened.recordSale("sale", items(), "Pix", true), sale);
  assert.throws(() => reopened.recordSale("sale", items(), "Dinheiro", true), /different data/);
  assert.equal(first.read("store").snapshot.sales.length, 2);
  assert.equal(first.read("store").pending, true);
});

test("invalid inputs and missing or ambiguous cash sessions never record a sale", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const service = new LocalSales(store, "store");
  const before = store.read("store");
  assert.throws(() => service.openCash("invalid", -1), /opening amount/);
  assert.throws(() => service.recordSale("sale", items(), "Pix", true), /open cash/);
  assert.throws(() => service.recordSale("sale", items(), "Pix online", true), /payment method/);
  assert.throws(() => service.recordSale("sale", items(), "Pix", "paid"), /Payment status/);
  assert.deepEqual(store.read("store"), before);
  service.openCash("open", 0);
  const open = store.read("store");
  assert.throws(() => service.recordSale("bad", [{ ...items()[0], price: 0 }], "Pix", true), /Unexpected/);
  assert.throws(() => service.recordSale("bad", [{ ...items()[0], productId: "missing" }], "Pix", true), /unavailable/);
  assert.deepEqual(store.read("store"), open);
  const corrupted = open.snapshot;
  corrupted.cashSessions.push({ id: "second" });
  store.save("store", corrupted, open.localRevision);
  const ambiguous = store.read("store");
  assert.throws(() => service.recordSale("ambiguous", items(), "Pix", true), /Exactly one/);
  assert.deepEqual(store.read("store"), ambiguous);
});

test("owner authorization is checked inside the transaction even for command retries", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const sales = new LocalSales(store, "store");
  let allowed = true;
  const authorize = () => {
    assert.equal(store.db.isTransaction, true);
    if (!allowed) throw new Error("Access revoked");
  };
  sales.openCash("open", 0, "", authorize);
  sales.recordSale("sale", items(), "Pix", true, authorize);
  const tables = new TableOrders(store, "store");
  const table = tables.createTable("table", "Mesa 1", authorize);
  const order = tables.addItems("items", table.tableId, null, items());
  tables.closeOrder("close", table.tableId, order.orderId, "Pix", authorize);
  const before = store.read("store");
  allowed = false;
  assert.throws(() => sales.openCash("open", 0, "", authorize), /revoked/);
  assert.throws(() => sales.recordSale("sale", items(), "Pix", true, authorize), /revoked/);
  assert.throws(() => tables.createTable("table", "Mesa 1", authorize), /revoked/);
  assert.throws(() => tables.closeOrder("close", table.tableId, order.orderId, "Pix", authorize), /revoked/);
  assert.deepEqual(store.read("store"), before);
});

test("quoted sale records only the displayed revision, cash session and total; rejection is durable", t => {
  const directory = mkdtempSync(join(tmpdir(), "quoted-sale-"));
  const filename = join(directory, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize("store", initial(), 0);
  let sales = new LocalSales(store, "store");
  const cash = sales.openCash("open", 0);
  const revision = store.read("store").localRevision;
  const quoted = (id, rev = revision, session = cash.cashSessionId, total = 20.2) =>
    sales.recordQuotedSale(id, items(), "Dinheiro", true, rev, session, total);
  const before = store.read("store");
  assert.deepEqual(quoted("wrong-total", revision, cash.cashSessionId, 20.21),
    { status: "rejected", reason: "price-changed" });
  assert.deepEqual(quoted("wrong-cash", revision, "different"),
    { status: "rejected", reason: "cash-changed" });
  const invalid = [{ productId: "missing", optionName: "Padrão", quantity: 1 }];
  assert.deepEqual(sales.recordQuotedSale("invalid", invalid, "Dinheiro", true, revision, cash.cashSessionId, 10),
    { status: "rejected", reason: "invalid-items" });
  assert.deepEqual(store.read("store"), before);
  const result = quoted("sale");
  assert.equal(result.status, "recorded");
  assert.equal(result.total, 20.2);
  assert.equal(result.cashSessionId, cash.cashSessionId);
  assert.deepEqual(quoted("sale"), result);
  assert.deepEqual(quoted("stale"), { status: "rejected", reason: "changed" });
  assert.deepEqual(sales.recordQuotedSale("invalid", invalid, "Dinheiro", true, revision, cash.cashSessionId, 10),
    { status: "rejected", reason: "invalid-items" });
  store.close();
  store = new OfflineStore(filename);
  sales = new LocalSales(store, "store");
  assert.deepEqual(quoted("sale"), result);
  assert.deepEqual(quoted("wrong-total", revision, cash.cashSessionId, 20.21),
    { status: "rejected", reason: "price-changed" });
  assert.deepEqual(quoted("stale"), { status: "rejected", reason: "changed" });
  assert.equal(store.read("store").snapshot.sales.length, 1);
  assert.throws(() => quoted("sale", revision, cash.cashSessionId, 30), /different data/);
});
