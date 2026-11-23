import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";

const initial = () => ({
  products: [], ingredients: [], sales: [{ id: "s", paid: true, total: 15 }],
  financeEntries: [], onlineOrderPayments: [],
  cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", openingAmount: 10,
    cashMovements: [{ type: "addition", amount: 5 }, { type: "withdrawal", amount: 3 }] }]
});
const request = { sessionId: "cash", counted: 30, notes: "Conferido" };
const result = () => {
  const snapshot = initial();
  Object.assign(snapshot.cashSessions[0], {
    closedAt: "2026-01-01T12:00:00Z", expectedCash: 27, countedCash: 30, difference: 3,
    receivedTotalAtClose: 15, receivedByMethodAtClose: [{ payment: "Dinheiro", amount: 15 }],
    closeNotes: "Conferido"
  });
  return { status: "closed", operationId: "close", sessionId: "cash", revision: 4, snapshot };
};
function reserve(store) {
  store.prepareOnlineCashClose("store", "close", request, 0);
  store.markOnlineCashCloseDispatched("store", "close");
}

test("commits snapshot, revisions, command and reservation together and replays after restart", t => {
  const dir = mkdtempSync(join(tmpdir(), "online-close-confirmation-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize("store", initial(), 3);
  reserve(store);
  assert.deepEqual(store.completeOnlineCashClose("store", "close", result()), result());
  assert.deepEqual(store.read("store"), { snapshot: result().snapshot, localRevision: 1,
    syncedRevision: 1, remoteRevision: 4, pending: false });
  assert.equal(store.pendingOnlineCashClose("store"), null);
  assert.equal(store.pendingUpload("store"), null);
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(store.completeOnlineCashClose("store", "close", result()), result());
  assert.throws(() => store.completeOnlineCashClose("store", "close", result(),
    () => { throw new Error("authorization revoked"); }), /revoked/);
  const changed = result();
  changed.revision = 5;
  assert.throws(() => store.completeOnlineCashClose("store", "close", changed), /different data/);
  store.save("store", store.read("store").snapshot, 1);
  assert.equal(store.read("store").pending, true);
});

test("only a matching dispatched close with consistent totals and unchanged data can be accepted", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 3);
  store.prepareOnlineCashClose("store", "close", request, 0);
  assert.throws(() => store.completeOnlineCashClose("store", "close", result()), /Dispatched/);
  store.markOnlineCashCloseDispatched("store", "close");
  const before = store.read("store");
  const invalid = [
    value => { value.status = "conflict"; },
    value => { value.operationId = "other"; },
    value => { value.sessionId = "other"; },
    value => { value.revision = 3; },
    value => { value.snapshot.cashSessions[0].closedAt = "2026-01-01T09:00:00Z"; },
    value => { value.snapshot.cashSessions[0].countedCash = 31; },
    value => { value.snapshot.cashSessions[0].difference = 0; },
    value => { value.snapshot.cashSessions[0].expectedCash = 999; },
    value => { value.snapshot.cashSessions[0].receivedTotalAtClose = 14; },
    value => { value.snapshot.cashSessions[0].receivedByMethodAtClose.push({ payment: "Dinheiro", amount: 0 }); },
    value => { value.snapshot.cashSessions[0].closeNotes = "alterado"; },
    value => { value.snapshot.cashSessions[0].openingAmount = 100; },
    value => { value.snapshot.cashSessions[0].unexpected = true; },
    value => { value.snapshot.sales[0].total = 900; }
  ];
  for (const change of invalid) {
    const bad = result();
    change(bad);
    assert.throws(() => store.completeOnlineCashClose("store", "close", bad));
    assert.deepEqual(store.read("store"), before);
    assert.equal(store.pendingOnlineCashClose("store").phase, "dispatched");
  }
  assert.throws(() => store.completeOnlineCashClose("store", "close", result(),
    () => { throw new Error("revoked"); }), /revoked/);
  assert.deepEqual(store.read("store"), before);
});

test("write failures roll back every part and leave the dispatched reservation recoverable", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 3);
  reserve(store);
  const before = store.read("store");
  const pending = store.pendingOnlineCashClose("store");
  for (const [name, table, action] of [
    ["fail_command", "offline_commands", "INSERT"],
    ["fail_release", "offline_online_cash_close_pending", "DELETE"]
  ]) {
    store.db.exec(`CREATE TRIGGER ${name} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'write failed'); END;`);
    assert.throws(() => store.completeOnlineCashClose("store", "close", result()), /write failed/);
    assert.deepEqual(store.read("store"), before);
    assert.deepEqual(store.pendingOnlineCashClose("store"), pending);
    assert.equal(store.db.prepare("SELECT count(*) AS count FROM offline_commands").get().count, 0);
    store.db.exec(`DROP TRIGGER ${name}`);
  }
  assert.deepEqual(store.completeOnlineCashClose("store", "close", result()), result());
});

test("accepts PostgreSQL's lowercase UUID without permitting a different operation", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 3);
  const id = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
  store.prepareOnlineCashClose("store", id, request, 0);
  store.markOnlineCashCloseDispatched("store", id);
  const response = { ...result(), operationId: id.toLowerCase() };
  assert.throws(() => store.completeOnlineCashClose("store", id,
    { ...response, operationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }), /Invalid/);
  assert.deepEqual(store.completeOnlineCashClose("store", id, response), response);
  assert.deepEqual(store.completeOnlineCashClose("store", id, response), response);
});
