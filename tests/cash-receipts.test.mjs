import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const first = html.indexOf(`      function ${start}(`);
  const last = html.indexOf(`      function ${end}(`, first);
  assert.ok(first >= 0 && last > first, `Could not find ${start}`);
  return html.slice(first, last);
}

function createContext() {
  const state = {
    cashSessions: [
      { id: "old", openedAt: "2026-11-01T10:00:00Z", closedAt: "2026-11-01T12:00:00Z" },
      { id: "current", openedAt: "2026-11-01T12:01:00Z" }
    ],
    sales: [
      { id: "direct", customerName: "Ana <Silva>", paid: true, payment: "Pix online", total: 25, cashSessionId: "old" },
      { id: "credit", customerName: "Bruno", paid: true, payment: "Crediário", total: 50, cashSessionId: "old" },
      { id: "legacy", customerName: "Carla", paid: true, payment: "Dinheiro", total: 10, createdAt: "2026-11-01T11:00:00Z" },
      { id: "pending", customerName: "Pendente", paid: false, total: 99, cashSessionId: "old" },
      { id: "new", customerName: "Outro turno", paid: true, payment: "Pix", total: 70, cashSessionId: "current" }
    ],
    financeEntries: [
      { kind: "receivable", saleId: "credit", partyName: "Bruno", payments: [
        { id: "part1", amount: 20, method: "Dinheiro", cashSessionId: "old" },
        { id: "part2", amount: 30, method: "Pix", cashSessionId: "current" }
      ] },
      { kind: "receivable", saleId: "missing", partyName: "Débora", payments: [
        { id: "legacy-payment", amount: 5, method: "Pix", date: "2026-11-01T11:30:00Z" }
      ] },
      { kind: "receivable", partyName: "Eva", description: "Conta <avulsa>", payments: [
        { id: "other", amount: 15, method: "Transferência", cashSessionId: "old" },
        { id: "unassigned", amount: 40, method: "Pix", date: "2026-11-01T11:30:00Z" }
      ] }
    ]
  };
  const context = {
    state,
    localMainPreview: false,
    allSales: () => state.sales,
    number: value => Number(value) || 0,
    paymentMethodForSale: sale => sale.payment === "Pix online" ? "Pix" : sale.payment || "A combinar",
    money: amount => `R$ ${Number(amount).toFixed(2)}`,
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    openModal: (...args) => { context.modal = args; },
    showToast: message => { context.toast = message; }
  };
  vm.createContext(context);
  vm.runInContext(sourceBetween("cashSessionForDate", "financeBalance"), context);
  vm.runInContext(sourceBetween("showCashReceipts", "renderCash"), context);
  return context;
}

test("details use the same session receipts as cash totals, including partial and legacy payments", () => {
  const context = createContext();
  const receipts = context.cashSessionReceipts("old");
  assert.equal(receipts.length, 5);
  assert.equal(receipts.reduce((sum, item) => sum + item.receiptAmount, 0), 75);
  assert.equal(receipts.find(item => item.id === "direct").payment, "Pix");
  assert.equal(receipts.find(item => item.id === "part1").customerName, "Bruno");
  assert.equal(receipts.find(item => item.id === "legacy-payment").customerName, "Débora");
  assert.equal(receipts.find(item => item.id === "other").receiptType, "Conta a receber");
  assert.equal(context.cashSessionReceipts("current").length, 2);
});

test("details show escaped names, payment methods, amounts, origin and closed-session notice", () => {
  const context = createContext();
  context.showCashReceipts("old");
  const [title, body, type, id] = context.modal;
  assert.equal(title, "Vendas e recebimentos do caixa");
  assert.equal(type, "cashReceipts");
  assert.equal(id, "old");
  assert.match(body, /Ana &lt;Silva&gt;/);
  assert.match(body, /Bruno/);
  assert.match(body, /Pagamento de venda no crediário/);
  assert.match(body, /Conta &lt;avulsa&gt;/);
  assert.match(body, /Transferência/);
  assert.match(body, /Total dos recebimentos: R\$ 75\.00/);
  assert.match(body, /pode mudar após o fechamento/);
  assert.doesNotMatch(body, /Pendente|Outro turno/);
});

test("empty or missing sessions are handled and both cash views expose the action", () => {
  const context = createContext();
  context.state.cashSessions.push({ id: "empty", openedAt: "2026-11-02T10:00:00Z" });
  context.showCashReceipts("empty");
  assert.match(context.modal[1], /Nenhum recebimento registrado neste caixa/);
  context.showCashReceipts("missing");
  assert.match(context.toast, /Não foi possível encontrar/);
  const renderCash = sourceBetween("renderCash", "renderCashReports");
  assert.equal((renderCash.match(/data-action="cash-receipts"/g) || []).length, 2);
  assert.match(html, /action\.dataset\.action === "cash-receipts"\) showCashReceipts\(id\)/);
});

test("provisional cash details explicitly warn the total is not final", () => {
  const context = createContext();
  context.state.cashSessions[0].offlineClosureStatus = "provisional";
  context.showCashReceipts("old");
  assert.match(context.modal[1], /Fechamento provisório/);
  assert.match(context.modal[1], /não representam o total final/);
});

test("main cash history shows provisional status without final-looking totals", () => {
  const context = createContext();
  context.state.cashSessions = [{ id: "provisional", openedAt: "2026-11-01T10:00:00Z",
    closedAt: "2026-11-01T12:00:00Z", offlineClosureStatus: "provisional" }];
  const page = { innerHTML: "" };
  context.currentCashSession = () => null;
  context.cashSessionTotalReceived = () => 123;
  context.cashSessionPaymentTotals = () => [{ payment: "Pix", amount: 123 }];
  context.document = { getElementById: id => id === "pageContent" ? page : null };
  vm.runInContext(sourceBetween("renderCash", "cashSessionOverlapsPeriod"), context);
  context.renderCash();
  assert.match(page.innerHTML, /Provisório — aguarda conciliação/);
  assert.doesNotMatch(page.innerHTML, /R\$ 123\.00|R\$ 0\.00/);
});

test("main screen refuses to save snapshots containing provisional closures", () => {
  const context = createContext();
  context.state.cashSessions[0].offlineClosureStatus = "provisional";
  context.localStorage = { setItem() { throw new Error("Must not write"); } };
  vm.runInContext(sourceBetween("saveState", "publicMenuSnapshot"), context);
  assert.equal(context.saveState(), false);
  assert.match(context.toast, /fechamento provisório pendente/);
});

test("local main preview refuses all snapshot saves", () => {
  const context = createContext();
  context.localMainPreview = true;
  context.localStorage = { setItem() { throw new Error("Must not write"); } };
  vm.runInContext(sourceBetween("saveState", "publicMenuSnapshot"), context);
  assert.equal(context.saveState(), false);
  assert.match(context.toast, /somente leitura/);
});
