import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { LocalSales } from "../local/local-sales.mjs";

const initial = () => ({
  products: [], ingredients: [], sales: [], financeEntries: [], onlineOrderPayments: [],
  cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", openingAmount: 10 }]
});
const request = { sessionId: "cash", counted: 10, notes: "Conferido" };

test("online close reserves only a synchronized open shift and survives restart", t => {
  const dir = mkdtempSync(join(tmpdir(), "online-close-reservation-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize("store", initial(), 3);
  const before = store.read("store");
  const reserved = store.prepareOnlineCashClose("store", "close", request, 0);
  assert.deepEqual(reserved, { commandId: "close", request, localRevision: 0,
    remoteRevision: 3, snapshot: before.snapshot, phase: "prepared" });
  assert.deepEqual(store.read("store"), before);
  assert.deepEqual(store.prepareOnlineCashClose("store", "close", request, 0), reserved);
  assert.throws(() => store.prepareOnlineCashClose("store", "close", { ...request, counted: 11 }, 0), /Another/);
  assert.throws(() => store.prepareOnlineCashClose("store", "other", request, 0), /Another/);
  assert.throws(() => store.save("store", before.snapshot, 0), /awaiting confirmation/);
  assert.throws(() => store.acceptRemote("store", before.snapshot, 3, 4), /awaiting confirmation/);
  assert.throws(() => store.prepareUpload("store"), /awaiting confirmation/);
  assert.throws(() => new LocalSales(store, "store").openCash("open", 0), /awaiting confirmation/);
  const another = new OfflineStore(filename);
  try {
    assert.deepEqual(another.pendingOnlineCashClose("store"), reserved);
    assert.throws(() => another.save("store", before.snapshot, 0), /awaiting confirmation/);
  } finally { another.close(); }
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(store.pendingOnlineCashClose("store"), reserved);
  assert.deepEqual(store.prepareOnlineCashClose("store", "close", request, 0), reserved);
  assert.throws(() => store.prepareOnlineCashClose("store", "close", request, 0, () => {
    throw new Error("authorization revoked");
  }), /authorization revoked/);
});

test("only an unsent reservation can be cancelled; a dispatched operation survives restart", t => {
  const dir = mkdtempSync(join(tmpdir(), "online-close-dispatch-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize("store", initial(), 0);
  store.prepareOnlineCashClose("store", "first", request, 0);
  assert.throws(() => store.cancelPreparedOnlineCashClose("store", "first", () => { throw new Error("revoked"); }), /revoked/);
  assert.throws(() => store.cancelPreparedOnlineCashClose("store", "other"), /not found/);
  store.cancelPreparedOnlineCashClose("store", "first");
  assert.equal(store.pendingOnlineCashClose("store"), null);
  store.prepareOnlineCashClose("store", "second", request, 0);
  const dispatched = store.markOnlineCashCloseDispatched("store", "second");
  assert.equal(dispatched.phase, "dispatched");
  assert.deepEqual(store.markOnlineCashCloseDispatched("store", "second"), dispatched);
  assert.throws(() => store.cancelPreparedOnlineCashClose("store", "second"), /must be reconciled/);
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(store.pendingOnlineCashClose("store"), dispatched);
  assert.throws(() => store.cancelPreparedOnlineCashClose("store", "second"), /must be reconciled/);
  assert.throws(() => store.save("store", initial(), 0), /awaiting confirmation/);
});

test("reservation rejects unsynchronized data, bad shift and provisional closures without mutation", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("dirty", initial(), 0);
  store.save("dirty", initial(), 0);
  assert.throws(() => store.prepareOnlineCashClose("dirty", "close", request, 1), /synchronized/);
  assert.throws(() => store.prepareOnlineCashClose("dirty", "close", request, 0), /changed/);
  assert.equal(store.pendingOnlineCashClose("dirty"), null);
  store.initialize("clean", initial(), 0);
  for (const invalid of [
    { ...request, counted: -1 }, { ...request, counted: 0.001 },
    { ...request, notes: " " }, { ...request, sessionId: "" }, { ...request, extra: true }
  ]) assert.throws(() => store.prepareOnlineCashClose("clean", "close", invalid, 0), /Invalid/);
  assert.throws(() => store.prepareOnlineCashClose("clean", "close", { ...request, sessionId: "wrong" }, 0), /matching open/);
  const provisional = initial();
  provisional.cashSessions.push({ id: "old", closedAt: "2026-01-01T09:00:00Z", offlineClosureStatus: "provisional" });
  store.initialize("provisional", provisional, 0);
  assert.throws(() => store.prepareOnlineCashClose("provisional", "close", request, 0), /provisional/);
  assert.equal(store.pendingOnlineCashClose("clean"), null);
});

test("failed reservation and dispatch writes roll back without losing local data", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const before = store.read("store");
  store.db.exec(`CREATE TRIGGER fail_reservation BEFORE INSERT ON offline_online_cash_close_pending
    BEGIN SELECT RAISE(ABORT, 'reservation write failed'); END;`);
  assert.throws(() => store.prepareOnlineCashClose("store", "close", request, 0), /reservation write failed/);
  assert.equal(store.pendingOnlineCashClose("store"), null);
  assert.deepEqual(store.read("store"), before);
  store.db.exec("DROP TRIGGER fail_reservation");
  const prepared = store.prepareOnlineCashClose("store", "close", request, 0);
  store.db.exec(`CREATE TRIGGER fail_dispatch BEFORE UPDATE ON offline_online_cash_close_pending
    BEGIN SELECT RAISE(ABORT, 'dispatch write failed'); END;`);
  assert.throws(() => store.markOnlineCashCloseDispatched("store", "close"), /dispatch write failed/);
  assert.deepEqual(store.pendingOnlineCashClose("store"), prepared);
  assert.deepEqual(store.read("store"), before);
});

test("existing recorded commands remain replayable but new writes cannot cross the reservation", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const snapshot = initial();
  snapshot.cashSessions = [];
  store.initialize("store", snapshot, 0);
  const sales = new LocalSales(store, "store");
  const opened = sales.openCash("open", 10);
  const upload = store.prepareUpload("store");
  store.acknowledgeUpload("store", upload.operationId, 1);
  const closeRequest = { ...request, sessionId: opened.cashSessionId };
  assert.throws(() => store.prepareOnlineCashClose("store", "open", closeRequest, 1), /Command ID already used/);
  store.prepareOnlineCashClose("store", "close", closeRequest, 1);
  assert.deepEqual(sales.openCash("open", 10), opened);
  assert.throws(() => sales.openCash("another", 10), /awaiting confirmation/);
  assert.throws(() => sales.openCash("open", 11), /different data/);
  assert.throws(() => sales.openCash("open", 10, "", () => { throw new Error("revoked"); }), /revoked/);
});
