import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("      function financeSummaryData(");
const end = html.indexOf("      function renderFinance(", start);
assert.ok(start >= 0 && end > start);

function createContext() {
  const context = {
    state: { financeEntries: [
      { kind: "receivable", description: "Venda <1>", partyName: "Ana & Bia", amount: 100, paidAmount: 25, dueDate: "2026-11-01", createdAt: "2026-11-02" },
      { kind: "receivable", description: "Quitada", amount: 10, paidAmount: 10, dueDate: "2026-11-01", createdAt: "2026-11-02" },
      { kind: "payable", description: "Fornecedor", partyName: "Loja", amount: 40, paidAmount: 10, dueDate: "2026-12-01", createdAt: "2026-11-02" },
      { kind: "payable", description: "Conta atrasada", amount: 5, paidAmount: 0, dueDate: "2026-11-01", createdAt: "2026-11-02" }
    ] },
    financeBalance: entry => Math.max(0, Number(entry.amount) - Number(entry.paidAmount)),
    financeEntryStatus: entry => Number(entry.amount) <= Number(entry.paidAmount) ? "Quitado" : entry.dueDate && entry.dueDate < "2026-11-23" ? "Atrasado" : "Em aberto",
    money: amount => `R$ ${Number(amount).toFixed(2)}`,
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
    openModal: (...args) => { context.modal = args; },
    showToast: message => { context.toast = message; }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test("summary cards and detail lists use the same outstanding amounts and overdue rules", () => {
  const context = createContext();
  const summary = context.financeSummaryData(context.state.financeEntries);
  assert.equal(summary.received, 75);
  assert.equal(summary.payable, 35);
  assert.equal(summary.receivables.length, 1);
  assert.equal(summary.payables.length, 2);
  assert.equal(summary.overdue.length, 2);

  context.showFinanceSummary("receivables");
  assert.equal(context.modal[0], "Contas a receber");
  assert.match(context.modal[1], /Venda &lt;1&gt;/);
  assert.match(context.modal[1], /Ana &amp; Bia/);
  assert.match(context.modal[1], /R\$ 75\.00/);
  assert.doesNotMatch(context.modal[1], /Quitada|Fornecedor/);
  assert.match(context.modal[1], /independentemente dos filtros/);

  context.showFinanceSummary("payables");
  assert.match(context.modal[1], /R\$ 35\.00/);
  assert.match(context.modal[1], /Fornecedor/);
  assert.doesNotMatch(context.modal[1], /Venda &lt;1&gt;/);

  context.showFinanceSummary("balance");
  assert.match(context.modal[1], /R\$ 40\.00/);
  assert.match(context.modal[1], /Venda &lt;1&gt;/);
  assert.match(context.modal[1], /Fornecedor/);

  context.showFinanceSummary("overdue");
  assert.match(context.modal[1], /2 conta\(s\)/);
  assert.match(context.modal[1], /Conta atrasada/);
  assert.doesNotMatch(context.modal[1], /Quitada|Fornecedor/);
});

test("empty lists and unknown summary are handled without changing entries", () => {
  const context = createContext();
  context.state.financeEntries = [];
  for (const type of ["receivables", "payables", "balance", "overdue"]) {
    context.showFinanceSummary(type);
    assert.match(context.modal[1], /Nenhuma conta/);
    assert.equal(context.modal[2], "financeSummary");
  }
  context.showFinanceSummary("invalid");
  assert.match(context.toast, /Não foi possível/);
  assert.equal(context.state.financeEntries.length, 0);
});

test("all four finance cards are accessible buttons wired to their details", () => {
  const first = html.indexOf("      function renderFinance(");
  const last = html.indexOf("      function financeEntryForm(", first);
  const render = html.slice(first, last);
  for (const type of ["receivables", "payables", "balance", "overdue"]) {
    assert.match(render, new RegExp(`<button type="button" class="stat-card finance-stat-button" data-action="finance-summary" data-summary="${type}"`));
  }
  assert.match(html, /action\.dataset\.action === "finance-summary"\) showFinanceSummary\(action\.dataset\.summary\)/);
  assert.match(html, /#modalForm\[data-type="financeSummary"\] \.modal-footer \{ display: none; \}/);
});
