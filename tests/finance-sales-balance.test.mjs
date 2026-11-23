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
  const context = {
    state: { sales: [], financeEntries: [] },
    currentUser: { id: "store" },
    onlineMenuReady: true,
    number: value => Number(value) || 0,
    roundMoney: value => Math.round((value + Number.EPSILON) * 100) / 100,
    money: value => `R$ ${Number(value).toFixed(2)}`,
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
  assert.match(body, /R\$ 125\.00/);
  assert.match(body, /R\$ 130\.00/);
  assert.match(body, /R\$ 5\.00/);
  assert.match(body, /independentemente dos filtros/);
  assert.match(body, /não é lucro contábil/);
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
