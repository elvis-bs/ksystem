import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("      async function decideOnlineOrder(");
const end = html.indexOf("      function renderOrders(", start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);

function createContext() {
  const updates = [];
  const confirmations = [];
  const messages = [];
  const sales = [];
  const context = {
    currentUser: { id: "store" }, onlineMenuReady: true, currentPage: "pedidos",
    document: { hidden: false },
    autoAcceptOnlineOrders: false, autoAcceptRunning: false,
    onlineOrderDecisionsInProgress: new Set(),
    allSales: () => sales,
    refreshOnlineOrders: async () => true,
    renderOrders: () => {},
    confirm: text => { confirmations.push(text); return context.confirmResult; },
    confirmResult: true,
    showToast: message => messages.push(message),
    console: { error() {} },
    supabaseClient: {
      from: table => {
        assert.equal(table, "online_orders");
        const update = { filters: [] };
        updates.push(update);
        const query = {
          update: values => { update.values = values; return query; },
          eq: (field, value) => { update.filters.push([field, value]); return query; },
          select: () => query,
          maybeSingle: async () => {
            if (context.resultError) return { error: context.resultError };
            const sale = sales.find(item => item.onlineOrderId === update.filters[0][1]);
            if (context.conflict || !sale || sale.status !== "Recebido") return { data: null, error: null };
            sale.status = update.values.status;
            return { data: { id: sale.onlineOrderId }, error: null };
          }
        };
        return query;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, updates, confirmations, messages, sales };
}

const order = (id, extra = {}) => ({ id: `online-${id}`, onlineOrderId: id, status: "Recebido", paymentMethod: "cash_on_delivery", paid: false, ...extra });

test("manual acceptance uses an atomic pending-status guard and starts preparation", async () => {
  const { context, updates, sales } = createContext();
  const sale = order("1");
  sales.push(sale);
  assert.equal(await context.decideOnlineOrder(sale, true), true);
  assert.equal(sale.status, "Em preparo");
  assert.deepEqual(updates[0].filters, [["id", "1"], ["business_id", "store"], ["status", "Recebido"]]);
});

test("refusing a paid order requires confirmation and explains manual refund and contact", async () => {
  const { context, confirmations, messages, updates, sales } = createContext();
  const sale = order("2", { paymentMethod: "pix", paid: true });
  sales.push(sale);
  context.confirmResult = false;
  assert.equal(await context.decideOnlineOrder(sale, false), false);
  assert.equal(updates.length, 0);
  assert.match(confirmations[0], /NÃO faz o estorno nem avisa o cliente/);
  context.confirmResult = true;
  assert.equal(await context.decideOnlineOrder(sale, false), true);
  assert.equal(sale.status, "Cancelado");
  assert.ok(updates[0].filters.some(([field, value]) => field === "payment_status" && value === "approved"));
  assert.match(messages.at(-1), /estorno e avise o cliente manualmente/);
});

test("automatic mode affects only ready online orders while the orders screen is visible", async () => {
  const { context, sales, updates } = createContext();
  sales.push(order("cash"), order("paid-pix", { paymentMethod: "pix", paid: true }),
    order("pending-pix", { paymentMethod: "pix", paid: false }),
    { id: "local", status: "Recebido" }, order("finished", { status: "Concluído" }));
  context.autoAcceptOnlineOrders = true;
  context.document.hidden = true;
  await context.acceptPendingOnlineOrders();
  assert.equal(updates.length, 0);
  context.document.hidden = false;
  context.currentPage = "caixa";
  await context.acceptPendingOnlineOrders();
  assert.equal(updates.length, 0);
  context.currentPage = "pedidos";
  await context.acceptPendingOnlineOrders();
  assert.equal(updates.length, 2);
  assert.equal(sales[0].status, "Em preparo");
  assert.equal(sales[1].status, "Em preparo");
  assert.equal(sales[2].status, "Recebido");
});

test("conflicting changes or failed refresh stop automatic mode without overwriting status", async () => {
  const { context, sales, messages } = createContext();
  sales.push(order("1"));
  context.autoAcceptOnlineOrders = true;
  context.conflict = true;
  await context.acceptPendingOnlineOrders();
  assert.equal(context.autoAcceptOnlineOrders, false);
  assert.equal(sales[0].status, "Recebido");
  assert.match(messages[0], /Aceite automático desativado/);
  context.conflict = false;
  context.autoAcceptOnlineOrders = true;
  context.refreshOnlineOrders = async () => false;
  await context.acceptPendingOnlineOrders();
  assert.equal(context.autoAcceptOnlineOrders, false);
  assert.match(messages.at(-1), /Não foi possível atualizar/);
});

test("activation confirms it applies to existing online orders and the UI exposes the controls", () => {
  const { context, confirmations } = createContext();
  context.toggleAutoAcceptOnlineOrders();
  assert.equal(context.autoAcceptOnlineOrders, true);
  assert.match(confirmations[0], /já aguardando/);
  assert.match(confirmations[0], /Pix só serão aceitos após a confirmação/);
  context.toggleAutoAcceptOnlineOrders();
  assert.equal(context.autoAcceptOnlineOrders, false);
  assert.match(html, /data-action="accept-online-order"/);
  assert.match(html, /data-action="reject-online-order"/);
  assert.match(html, /data-action="toggle-auto-accept"/);
  assert.match(html, /funciona somente com esta tela aberta e visível/);
});

test("existing status controls also warn before cancelling a paid online order", () => {
  const first = html.indexOf("      function changeSaleStatus(");
  const last = html.indexOf("      function advanceOrder(", first);
  assert.ok(first >= 0 && last > first);
  const messages = [];
  let renders = 0;
  const context = {
    confirm: text => { messages.push(text); return false; },
    render: () => { renders++; }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(first, last), context);
  const sale = order("paid", { paid: true });
  let rejected = false;
  context.changeSaleStatus(sale, "Cancelado", null, () => { rejected = true; });
  assert.equal(sale.status, "Recebido");
  assert.equal(renders, 1);
  assert.equal(rejected, true);
  assert.match(messages[0], /NÃO faz o estorno nem avisa o cliente/);
});
