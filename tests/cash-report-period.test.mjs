import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extract(start, end) {
  const first = html.indexOf(`      function ${start}(`);
  const last = html.indexOf(`      function ${end}(`, first);
  assert.ok(first >= 0 && last > first, `Could not find ${start}`);
  return html.slice(first, last);
}

function createContext() {
  const page = { innerHTML: "" };
  const filterForm = { addEventListener() {} };
  const context = {
    state: { cashSessions: [] },
    cashReportStart: "2026-11-20",
    cashReportEnd: "2026-11-23",
    number: value => Number(value) || 0,
    money: value => `R$ ${Number(value).toFixed(2)}`,
    escapeHtml: value => String(value),
    cashSessionReceipts: () => [{ payment: "Pix", receiptAmount: 85 }],
    cashRegisterMovementTotals: () => ({ additions: 0, withdrawals: 0 }),
    cashSessionExpected: () => 85,
    cashSessionTotalReceived: () => 85,
    cashSessionPaymentTotals: () => [{ payment: "Pix", amount: 85 }],
    document: { getElementById: id => id === "pageContent" ? page : filterForm }
  };
  vm.createContext(context);
  vm.runInContext(extract("localDateKey", "renderReports"), context);
  vm.runInContext(extract("cashSessionOverlapsPeriod", "localDateKey"), context);
  context.page = page;
  return context;
}

test("includes sessions overlapping the selected dates, including their boundary days", () => {
  const { cashSessionOverlapsPeriod: overlaps } = createContext();
  const start = "2026-11-20";
  const end = "2026-11-23";
  const today = "2026-11-23";
  assert.equal(overlaps({ openedAt: "2026-11-07T10:00:00", closedAt: "2026-11-23T12:00:00" }, start, end, today), true);
  assert.equal(overlaps({ openedAt: "2026-11-01T10:00:00", closedAt: "2026-11-20T12:00:00" }, start, end, today), true);
  assert.equal(overlaps({ openedAt: "2026-11-23T10:00:00", closedAt: "2026-11-24T12:00:00" }, start, end, today), true);
  assert.equal(overlaps({ openedAt: "2026-11-07T10:00:00" }, start, end, today), true);
  assert.equal(overlaps({ openedAt: "2026-11-01T10:00:00", closedAt: "2026-11-19T12:00:00" }, start, end, today), false);
  assert.equal(overlaps({ openedAt: "2026-11-24T10:00:00", closedAt: "2026-11-25T12:00:00" }, start, end, today), false);
  assert.equal(overlaps({ openedAt: "2026-11-07T10:00:00" }, "2026-11-24", "2026-11-25", today), false);
});

test("report displays a recently closed older session and its full-turn totals", () => {
  const context = createContext();
  context.state.cashSessions = [
    { id: "included", openedAt: "2026-11-07T10:00:00", closedAt: "2026-11-23T12:00:00", expectedCash: 85, countedCash: 85, difference: 0 },
    { id: "excluded", openedAt: "2026-11-01T10:00:00", closedAt: "2026-11-19T12:00:00", expectedCash: 100, countedCash: 100, difference: 0 }
  ];
  context.renderCashReports();
  assert.match(context.page.innerHTML, /1 turno\(s\)/);
  assert.match(context.page.innerHTML, /R\$ 85\.00/);
  assert.doesNotMatch(context.page.innerHTML, /R\$ 100\.00/);
  assert.match(context.page.innerHTML, /valores apresentados são do turno inteiro/);
  assert.match(context.page.innerHTML, /mesmo turno pode aparecer em relatórios de períodos diferentes/);
});

test("invalid ranges do not include sessions", () => {
  const context = createContext();
  context.cashReportStart = "2026-11-24";
  context.state.cashSessions = [{ id: "open", openedAt: "2026-11-07T10:00:00" }];
  context.renderCashReports();
  assert.match(context.page.innerHTML, /Período inválido/);
  assert.match(context.page.innerHTML, /Nenhum turno de caixa no período selecionado/);
});

test("provisional closures are identified and excluded from report totals", () => {
  const context = createContext();
  context.state.cashSessions = [
    { id: "final", openedAt: "2026-11-20T10:00:00", closedAt: "2026-11-20T12:00:00",
      expectedCash: 85, countedCash: 80, difference: -5 },
    { id: "provisional", openedAt: "2026-11-21T10:00:00", closedAt: "2026-11-21T12:00:00",
      offlineClosureStatus: "provisional", offlineProvisional: { localExpected: 999, countedCash: 999 } }
  ];
  context.cashSessionReceipts = id => [{ payment: "Pix", receiptAmount: id === "final" ? 85 : 999 }];
  context.renderCashReports();
  assert.match(context.page.innerHTML, /Provisório — aguarda conciliação/);
  assert.match(context.page.innerHTML, /1 turno\(s\) aguardam conciliação e foram excluídos/);
  assert.match(context.page.innerHTML, /R\$ 85\.00/);
  assert.match(context.page.innerHTML, /R\$ -5\.00/);
  assert.doesNotMatch(context.page.innerHTML, /R\$ 999\.00|R\$ 1084\.00/);
});
