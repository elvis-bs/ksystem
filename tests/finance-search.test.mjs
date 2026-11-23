import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("      function renderFinance(");
const end = html.indexOf("      function financeEntryForm(", start);
assert.ok(start >= 0 && end > start);

function createContext() {
  const elements = {
    pageContent: { innerHTML: "" },
    financeFilters: { addEventListener(type, handler) { this[type] = handler; } },
    financeSearch: { value: "", selectionStart: 0, addEventListener(type, handler) { this[type] = handler; }, focus() { this.focused = true; }, setSelectionRange(start, end) { this.selection = [start, end]; } },
    financeDate: { value: "" },
    financeKind: { value: "all" }
  };
  const context = {
    state: { financeEntries: [
      { kind: "receivable", description: "Venda antiga", partyName: "Pâmela", amount: 28, paidAmount: 0, createdAt: "2026-11-07T12:00:00", id: "1" },
      { kind: "receivable", description: "Outra venda", partyName: "Pamela", amount: 60, paidAmount: 0, createdAt: "2026-11-23T12:00:00", id: "2" },
      { kind: "payable", description: "Despesa", partyName: "Fornecedor", amount: 10, paidAmount: 0, createdAt: "2026-11-23T12:00:00", id: "3" }
    ] },
    financeDateFilter: "", financeSearch: "", financeKindFilter: "all",
    financeSummaryData: () => ({ received: 88, payable: 10, overdue: [], receivables: [1, 2], payables: [3] }),
    financeBalance: entry => entry.amount - entry.paidAmount,
    financeEntryStatus: () => "Em aberto",
    localDateKey: value => value.slice(0, 10),
    number: value => Number(value) || 0,
    money: amount => `R$ ${Number(amount).toFixed(2)}`,
    escapeHtml: value => String(value),
    document: { getElementById: id => elements[id] }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.elements = elements;
  return context;
}

test("typing a name finds entries across all dates and ignores accents", () => {
  const context = createContext();
  context.renderFinance();
  const input = context.elements.financeSearch;
  input.value = "pamela";
  input.selectionStart = 6;
  input.input({ currentTarget: input, isComposing: false });
  assert.match(context.elements.pageContent.innerHTML, /2 resultado\(s\)/);
  assert.match(context.elements.pageContent.innerHTML, /Venda antiga/);
  assert.match(context.elements.pageContent.innerHTML, /Outra venda/);
  assert.doesNotMatch(context.elements.pageContent.innerHTML, /Fornecedor/);
  assert.equal(input.focused, true);
  assert.deepEqual(input.selection, [6, 6]);
});

test("explicit date and type still narrow the live search", () => {
  const context = createContext();
  context.renderFinance();
  context.elements.financeDate.value = "2026-11-23";
  context.elements.financeKind.value = "receivable";
  const input = context.elements.financeSearch;
  input.value = "pamela";
  input.selectionStart = 6;
  input.input({ currentTarget: input, isComposing: false });
  assert.match(context.elements.pageContent.innerHTML, /1 resultado\(s\)/);
  assert.match(context.elements.pageContent.innerHTML, /Outra venda/);
  assert.doesNotMatch(context.elements.pageContent.innerHTML, /Venda antiga/);
});

test("all-days action preserves current search and type and default date is empty", () => {
  assert.match(html, /let financeDateFilter = "";/);
  const start = html.indexOf('        if (action.dataset.action === "clear-finance-filters")');
  const end = html.indexOf('        if (action.dataset.action === "settle-finance-entry")', start);
  assert.ok(start >= 0 && end > start);
  const actionCode = html.slice(start, end);
  const context = createContext();
  context.action = { dataset: { action: "clear-finance-filters" } };
  context.elements.financeSearch.value = "pamela";
  context.elements.financeKind.value = "receivable";
  context.financeDateFilter = "2026-11-23";
  vm.runInContext(actionCode, context);
  assert.equal(context.financeDateFilter, "");
  assert.equal(context.financeSearch, "pamela");
  assert.equal(context.financeKindFilter, "receivable");
  assert.match(context.elements.pageContent.innerHTML, /2 resultado\(s\)/);
});
