import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("      function financeSalesBalance(");
const end = html.indexOf("      function renderFinance(", start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);

function createContext(pages = [[]]) {
  const requests = [];
  const elements = Object.fromEntries(["balanceStart", "balanceEnd", "balanceDetails", "balanceApply", "balancePrint"].map(id => [id, {
    value: "", innerHTML: "", addEventListener(type, handler) { this[type] = handler; }
  }]));
  const context = {
    state: { sales: [], financeEntries: [] },
    currentUser: { id: "store" },
    onlineMenuReady: true,
    number: value => Number(value) || 0,
    roundMoney: value => Math.round((value + Number.EPSILON) * 100) / 100,
    money: value => `R$ ${Number(value).toFixed(2)}`,
    localDateKey: value => {
      const date = new Date(value);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    },
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    document: { getElementById: id => elements[id] },
    onlineOrderSale: order => order,
    openModal: (...args) => { context.modal = args; },
    showToast: message => { context.toast = message; },
    console: { error: (...args) => { context.error = args; } },
    supabaseClient: {
      from: table => {
        assert.equal(table, "online_orders");
        const query = {
          select: () => query,
          order: () => query,
          range: async (from, to) => {
            requests.push([from, to]);
            return pages[Math.floor(from / 100)];
          }
        };
        return query;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.requests = requests;
  context.elements = elements;
  return context;
}

test("sums paid direct sales, partial credit receipts and paid costs without duplication", () => {
  const context = createContext();
  const sales = [
    { id: "direct", paid: true, total: 100 },
    { id: "online", paid: true, total: 25 },
    { id: "credit", paid: true, total: 60 },
    { id: "partial", paid: false, total: 90 },
    { id: "pending", paid: false, total: 200 }
  ];
  const entries = [
    { kind: "receivable", saleId: "credit", paidAmount: 60 },
    { kind: "receivable", saleId: "partial", paidAmount: 30 },
    { kind: "receivable", paidAmount: 900 },
    { kind: "expense", paidAmount: 40 },
    { kind: "payable", amount: 80, paidAmount: 15 },
    { kind: "payable", amount: 99, paidAmount: 0 }
  ];
  const totals = context.financeSalesBalance(sales, entries);
  assert.equal(totals.received, 215);
  assert.equal(totals.spent, 55);
  assert.equal(totals.balance, 160);
  assert.equal(context.financeSalesBalance([], [{ kind: "expense", paidAmount: 5 }]).balance, -5);
});

test("reads every page of online orders and displays a read-only breakdown", async () => {
  const first = Array.from({ length: 100 }, (_, id) => ({ id: `online-${id}`, paid: true, total: 1 }));
  const context = createContext([{ data: first }, { data: [{ id: "last", paid: true, total: 20 }] }]);
  context.state.sales.push({ id: "local", paid: true, total: 10 });
  context.state.financeEntries.push({ kind: "expense", paidAmount: 5 });
  const previous = JSON.stringify(context.state);
  await context.showFinanceSalesBalance();
  assert.deepEqual(context.requests, [[0, 99], [100, 199]]);
  assert.equal(JSON.stringify(context.state), previous);
  const [title, body, type] = context.modal;
  assert.equal(title, "Verificar resultado das vendas");
  assert.equal(type, "financeBalance");
  assert.match(context.elements.balanceDetails.innerHTML, /R\$ 125\.00/);
  assert.match(context.elements.balanceDetails.innerHTML, /R\$ 130\.00/);
  assert.match(context.elements.balanceDetails.innerHTML, /R\$ 5\.00/);
  assert.match(body, /independentemente dos filtros/);
  assert.match(body, /não é lucro contábil/);
});

test("date filters use actual payment dates and estimate legacy direct sales", () => {
  const context = createContext();
  const sales = [
    { id: "direct", paid: true, total: 100, createdAt: "2026-11-01T10:00:00", paidAt: "2026-11-23T10:00:00" },
    { id: "legacy", paid: true, total: 25, createdAt: "2026-11-22T10:00:00" },
    { id: "outside", paid: true, total: 90, createdAt: "2026-11-23T10:00:00", paidAt: "2026-11-24T10:00:00" },
    { id: "unknown", paid: true, total: 7 },
    { id: "credit", paid: true, total: 50 }
  ];
  const entries = [
    { kind: "receivable", saleId: "credit", paidAmount: 50, payments: [
      { amount: 20, date: "2026-11-20T10:00:00" }, { amount: 30, date: "2026-11-24T10:00:00" }
    ] },
    { kind: "payable", paidAmount: 60, payments: [
      { amount: 10, date: "2026-11-23T10:00:00" }, { amount: 50, date: "2026-11-24T10:00:00" }
    ] },
    { kind: "expense", paidAmount: 8, createdAt: "2026-11-20T10:00:00" },
    { kind: "payable", paidAmount: 3, payments: [] }
  ];
  const result = context.financeSalesBalance(sales, entries, "2026-11-20", "2026-11-23");
  assert.equal(result.received, 145);
  assert.equal(result.spent, 18);
  assert.equal(result.balance, 127);
  assert.equal(result.estimatedSales, 1);
  assert.equal(result.undatedAmount, 10);
  assert.match(context.financeBalanceWarnings(result)[0], /estimativa/);
  assert.equal(context.financeSalesBalance(sales, entries).received, 272);
  assert.equal(context.financeSalesBalance(sales, entries, "", "2026-11-19").received, 0);
  assert.equal(context.financeSalesBalance(sales, entries, "2026-11-24", "").received, 120);
});

test("filter validates dates and printing uses the current selected period", async () => {
  const context = createContext([{ data: [] }]);
  context.state.sales.push({ id: "a", paid: true, total: 10, paidAt: "2026-11-23T12:00:00" });
  let printed = "";
  context.state.receiptSettings = { storeName: "Loja <Teste>" };
  context.window = { open: () => ({
    document: { open() {}, write: value => { printed = value; }, close() {} },
    addEventListener() {}, focus() {}, print() {}
  }) };
  context.setTimeout = callback => callback();
  await context.showFinanceSalesBalance();
  context.elements.balanceStart.value = "2026-11-24";
  context.elements.balanceEnd.value = "2026-11-23";
  context.elements.balancePrint.click();
  assert.match(context.toast, /data inicial/);
  assert.equal(printed, "");
  context.elements.balanceStart.value = "2026-11-23";
  context.elements.balancePrint.click();
  assert.match(printed, /23\/11\/2026 a 23\/11\/2026/);
  assert.match(printed, /Loja &lt;Teste&gt;/);
  assert.match(printed, /R\$ 10\.00/);
  assert.match(printed, /Não é documento fiscal/);
  assert.match(context.elements.balanceDetails.innerHTML, /23\/11\/2026 a 23\/11\/2026/);
});

test("does not display an incomplete total if any page fails", async () => {
  const context = createContext([{ data: Array.from({ length: 100 }, () => ({})) }, { error: new Error("offline") }]);
  await context.showFinanceSalesBalance();
  assert.equal(context.modal, undefined);
  assert.match(context.toast, /Não foi possível carregar todos/);
  assert.ok(context.error);
});

test("does not display an incomplete total when online orders are unavailable", async () => {
  const context = createContext();
  context.onlineMenuReady = false;
  await context.showFinanceSalesBalance();
  assert.equal(context.modal, undefined);
  assert.match(context.toast, /Não foi possível consultar/);
  assert.equal(context.requests.length, 0);
});

test("finance screen exposes a read-only action", () => {
  assert.match(html, /data-action="finance-sales-balance"/);
  assert.match(html, /action\.dataset\.action === "finance-sales-balance"\) showFinanceSalesBalance\(\)/);
  assert.match(html, /#modalForm\[data-type="financeBalance"\] \.modal-footer \{ display: none; \}/);
});
