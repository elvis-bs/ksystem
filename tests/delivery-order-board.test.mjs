import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const section = (start, end) => {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return html.slice(first, last);
};
const source = section("      function onlineOrderSale(", "      function onlinePaymentLabel(")
  + section("      async function refreshOnlineOrders(", "      function setSyncStatus(")
  + section("      function startOnlineOrderRefresh(", "      async function refreshPublicAvailability(")
  + section("      function renderOrders(", "      function showOrderDetails(");

function setup() {
  let orders = [];
  let drivers = [];
  let driverError = null;
  let driverFailure = null;
  let timer;
  const requests = [];
  const messages = [];
  const target = { innerHTML: "" };
  const context = {
    currentUser: { id: "store" }, onlineMenuReady: true, onlineOrders: [],
    onlineOrdersRefreshVersion: 0, orderDriverNames: new Map(),
    state: { onlineOrderPayments: [], sales: [] },
    currentPage: "pedidos", document: { hidden: false, getElementById: () => target,
      querySelector: () => ({ addEventListener() {} }) },
    autoAcceptOnlineOrders: false, orderAlertEnabled: false, onlineOrderRefreshTimer: null,
    setInterval: callback => { timer = callback; return 1; }, clearInterval() {},
    console: { error() {} }, showToast: text => messages.push(text), orderCanTriggerAlert: () => false,
    number: value => Number(value) || 0, onlinePaymentLabel: () => "Dinheiro na entrega",
    cashSessionForDate: () => null, localDateKey: () => "today", money: value => `R$ ${value}`,
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    receiptPaymentStatus: () => "A receber", toggleOrderAlert() {}, acceptPendingOnlineOrders() {},
    allSales() { return context.onlineOrders.map(context.onlineOrderSale); },
    render() { context.renderOrders(); },
    supabaseClient: { from(table) {
      const request = { table, filters: [] };
      requests.push(request);
      return {
        select(value) { request.fields = value; return this; },
        eq(field, value) { request.filters.push([field, value]); return this; },
        in(field, value) {
          request.filters.push([field, value]);
          if (driverFailure) return Promise.reject(driverFailure);
          return Promise.resolve({ data: drivers, error: driverError });
        },
        order() { return Promise.resolve({ data: orders, error: null }); }
      };
    } }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, target, messages, requests, setOrders(value) { orders = value; },
    setDrivers(value) { drivers = value; }, setDriverError(value) { driverError = value; },
    setDriverFailure(value) { driverFailure = value; },
    async tick() { await timer(); } };
}

test("board shows accepted driver and removes delivery after completion on refresh", async () => {
  const test = setup();
  const order = { id: "order-1", status: "Saiu para entrega", payment_status: "pending",
    order_data: { fulfillment: "delivery", paymentMethod: "cash_on_delivery", customerName: "Cliente", items: [] },
    total: 21, created_at: new Date().toISOString(), delivery_driver_id: null };
  test.setOrders([order]);
  assert.equal(await test.context.refreshOnlineOrders(), true);
  test.context.renderOrders();
  assert.match(test.target.innerHTML, /Aguardando aceite do entregador/);
  test.setOrders([{ ...order, delivery_driver_id: "driver-1" }]);
  test.setDrivers([{ user_id: "driver-1", name: "<João>" }]);
  test.context.startOnlineOrderRefresh();
  await test.tick();
  assert.match(test.target.innerHTML, /Entrega aceita por: &lt;João&gt;/);
  assert.ok(test.requests.find(request => request.table === "online_orders").fields.includes("delivery_driver_id"));
  const driverRequest = test.requests.find(request => request.table === "delivery_drivers");
  assert.deepEqual(driverRequest.filters.map(filter => [filter[0], JSON.stringify(filter[1])]),
    [["business_id", '"store"'], ["user_id", '["driver-1"]']]);
  test.setOrders([{ ...order, delivery_driver_id: "driver-1", status: "Concluído" }]);
  await test.tick();
  assert.match(test.target.innerHTML, /Pedidos finalizados \(1\)/);
  assert.doesNotMatch(test.target.innerHTML, /Entrega aceita por/);
  assert.match(test.target.innerHTML, /Nenhum pedido nesta etapa/);
});

test("driver lookup failure preserves the accepted state and displays an explicit warning", async () => {
  const test = setup();
  test.setOrders([{ id: "order-1", status: "Saiu para entrega", payment_status: "pending",
    order_data: { fulfillment: "delivery", paymentMethod: "cash_on_delivery", items: [] },
    total: 10, created_at: new Date().toISOString(), delivery_driver_id: "driver-1" }]);
  test.setDriverError({ message: "offline" });
  assert.equal(await test.context.refreshOnlineOrders(), true);
  test.context.renderOrders();
  assert.match(test.target.innerHTML, /Entrega aceita por: entregador não identificado/);
  assert.match(test.messages[0], /Não foi possível carregar os nomes/);
  test.setDriverError(null);
  test.setDriverFailure(new Error("network"));
  assert.equal(await test.context.refreshOnlineOrders(), true);
  assert.equal(test.messages.length, 2);
});
