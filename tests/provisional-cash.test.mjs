import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { LocalSales } from "../local/local-sales.mjs";
import { inspectPendingUpload, uploadPending } from "../local/offline-sync.mjs";
import { SyncPresence } from "../local/sync-presence.mjs";
import { compareCashCheckpoint } from "../local/cash-review.mjs";

const initial = () => ({
  products: [], ingredients: [], sales: [
    { id: "s1", paid: true, payment: "Dinheiro", total: 25, cashSessionId: "cash" },
    { id: "pending", paid: false, payment: "Pix", total: 90 },
    { id: "credit", paid: true, payment: "Crediário", total: 50, cashSessionId: "cash" }
  ],
  cashSessions: [{ id: "cash", openedAt: "2026-01-01T10:00:00Z", openingAmount: 10,
    cashMovements: [{ type: "addition", amount: 5 }, { type: "withdrawal", amount: 3 }] }],
  financeEntries: [
    { kind: "receivable", saleId: "credit", payments: [{ amount: 20, method: "Pix", cashSessionId: "cash" }] },
    { kind: "receivable", payments: [{ amount: 7, method: "Dinheiro", cashSessionId: "cash" }] }
  ],
  onlineOrderPayments: [{ onlineOrderId: "unknown-online", cashSessionId: "cash", method: "Dinheiro" }]
});

test("disabled provisional close keeps the shift open across restart and permits later synchronization", async t => {
  const dir = mkdtempSync(join(tmpdir(), "cash-online-only-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const snapshot = initial();
  snapshot.products = [{ id: "p1", name: "Suco", category: "bebida", active: true, price: 10, cost: 4, addons: [] }];
  store.initialize("store", snapshot, 3);
  let sales = new LocalSales(store, "store");
  const before = store.read("store");
  const result = sales.closeCashProvisionally("close", "cash", 65, "conferido", null, false);
  assert.deepEqual(result, { status: "rejected", reason: "online-close-unavailable" });
  assert.deepEqual(store.read("store"), before);
  assert.throws(() => sales.openCash("another", 0), /already open/);
  store.close();
  store = new OfflineStore(filename);
  sales = new LocalSales(store, "store");
  assert.deepEqual(sales.closeCashProvisionally("close", "cash", 65, "conferido", null, false), result);
  assert.equal(sales.recordSale("sale-after-restart", [{ productId: "p1", optionName: "Padrão", quantity: 1 }],
    "Dinheiro", true).total, 10);
  let uploaded;
  const synced = await uploadPending(store, "store", { async applySnapshot(request) {
    uploaded = request.snapshot;
    return { status: "applied", revision: request.expectedRevision + 1 };
  } });
  assert.equal(synced.status, "synced");
  assert.equal(uploaded.cashSessions[0].closedAt, undefined);
  assert.equal(uploaded.cashSessions[0].offlineClosureStatus, undefined);
  assert.equal(uploaded.sales.at(-1).id.startsWith("sale-"), true);
});

test("provisional close records only local receipts, movements, and survives idempotent restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "cash-provisional-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize("store", initial(), 3);
  const service = new LocalSales(store, "store");
  const result = service.closeCashProvisionally("close", "cash", 65, "conferir");
  const closeBaseline = store.cashCloseBaseline("store", "cash");
  assert.equal(closeBaseline.localRevision, 1);
  assert.deepEqual(closeBaseline.snapshot, store.read("store").snapshot);
  assert.equal(result.status, "provisional");
  assert.equal(result.localReceived, 52);
  assert.equal(result.localExpected, 64);
  assert.equal(result.localDifference, 1);
  assert.deepEqual(result.localByMethod, [{ payment: "Dinheiro", amount: 32 }, { payment: "Pix", amount: 20 }]);
  assert.deepEqual(service.closeCashProvisionally("close", "cash", 65, "conferir"), result);
  assert.throws(() => service.closeCashProvisionally("other", "cash", 65), /open cash/);
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(new LocalSales(store, "store").closeCashProvisionally("close", "cash", 65, "conferir"), result);
  assert.deepEqual(store.cashCloseBaseline("store", "cash"), closeBaseline);
  const session = store.read("store").snapshot.cashSessions[0];
  assert.equal(session.offlineClosureStatus, "provisional");
  assert.equal(session.expectedCash, undefined);
  assert.equal(session.receivedTotalAtClose, undefined);
  let calls = 0;
  await assert.rejects(uploadPending(store, "store", { applySnapshot() { calls++; } }), /requires online reconciliation/);
  assert.equal(calls, 0);
  assert.equal(store.pendingUpload("store"), null);
  assert.equal(store.read("store").pending, true);
});

test("close baseline and cash command roll back together when baseline storage fails", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const before = store.read("store");
  store.db.exec(`CREATE TRIGGER fail_cash_baseline BEFORE INSERT ON offline_cash_close_baselines
    BEGIN SELECT RAISE(ABORT, 'baseline write failed'); END;`);
  assert.throws(() => new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0), /baseline write failed/);
  assert.deepEqual(store.read("store"), before);
  assert.equal(store.cashCloseBaseline("store", "cash"), null);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM offline_commands").get().count, 0);
  store.db.exec("DROP TRIGGER fail_cash_baseline");
  new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
  assert.equal(store.cashCloseBaseline("store", "cash").localRevision, 1);
});

test("quoted cash close rejects stale data durably and captures an accepted close atomically", async t => {
  const dir = mkdtempSync(join(tmpdir(), "quoted-cash-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize("store", initial(), 0);
  let sales = new LocalSales(store, "store");
  const before = store.read("store");
  const stale = sales.closeQuotedCashProvisionally("stale", "cash", 65, "", 1);
  assert.deepEqual(stale, { status: "rejected", reason: "changed" });
  assert.deepEqual(store.read("store"), before);
  assert.equal(store.cashCloseBaseline("store", "cash"), null);
  const wrongCash = sales.closeQuotedCashProvisionally("wrong", "another", 65, "", 0);
  assert.deepEqual(wrongCash, { status: "rejected", reason: "cash-changed" });
  assert.equal(store.cashCloseBaseline("store", "another"), null);
  const result = sales.closeQuotedCashProvisionally("close", "cash", 65, "conferir", 0);
  assert.equal(result.status, "provisional");
  assert.equal(result.localExpected, 64);
  assert.deepEqual(store.cashCloseBaseline("store", "cash").snapshot, store.read("store").snapshot);
  store.close();
  store = new OfflineStore(filename);
  sales = new LocalSales(store, "store");
  assert.deepEqual(sales.closeQuotedCashProvisionally("close", "cash", 65, "conferir", 0), result);
  assert.deepEqual(sales.closeQuotedCashProvisionally("stale", "cash", 65, "", 1), stale);
  assert.throws(() => sales.closeQuotedCashProvisionally("close", "cash", 66, "conferir", 0), /different data/);
  let calls = 0;
  await assert.rejects(uploadPending(store, "store", { applySnapshot() { calls++; } }), /requires online reconciliation/);
  assert.equal(calls, 0);
});

test("quoted open is idempotent and rejects a stale or already open session without mutation", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const snapshot = initial();
  snapshot.cashSessions = [];
  store.initialize("store", snapshot, 0);
  const sales = new LocalSales(store, "store");
  const before = store.read("store");
  assert.deepEqual(sales.openQuotedCash("stale", 10, "", 1), { status: "rejected", reason: "changed" });
  assert.deepEqual(store.read("store"), before);
  const opened = sales.openQuotedCash("open", 10, "troco", 0);
  assert.equal(opened.status, "opened");
  assert.deepEqual(sales.openQuotedCash("open", 10, "troco", 0), opened);
  assert.deepEqual(sales.openQuotedCash("other", 10, "", 1), { status: "rejected", reason: "cash-changed" });
  assert.equal(store.read("store").snapshot.cashSessions.length, 1);
});

test("quoted close rolls back snapshot and command if the close baseline fails", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const before = store.read("store");
  store.db.exec(`CREATE TRIGGER fail_quoted_baseline BEFORE INSERT ON offline_cash_close_baselines
    BEGIN SELECT RAISE(ABORT, 'baseline write failed'); END;`);
  const service = new LocalSales(store, "store");
  assert.throws(() => service.closeQuotedCashProvisionally("close", "cash", 65, "", 0), /baseline write failed/);
  assert.deepEqual(store.read("store"), before);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM offline_commands").get().count, 0);
  store.db.exec("DROP TRIGGER fail_quoted_baseline");
  assert.equal(service.closeQuotedCashProvisionally("close", "cash", 65, "", 0).status, "provisional");
});

test("close baseline remains unchanged when later local receipts are edited", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  store.initialize("other", initial(), 0);
  new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
  const baseline = store.cashCloseBaseline("store", "cash");
  const later = store.read("store");
  later.snapshot.sales[0].total = 80;
  store.save("store", later.snapshot, later.localRevision);
  assert.deepEqual(store.cashCloseBaseline("store", "cash"), baseline);
  assert.equal(baseline.snapshot.sales[0].total, 25);
  assert.equal(store.cashCloseBaseline("other", "cash"), null);
});

test("first online attempt cannot replace the original close baseline", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
  const afterClose = store.read("store");
  afterClose.snapshot.sales[0].total = 80;
  store.save("store", afterClose.snapshot, afterClose.localRevision);
  store.cashCheckpoint("store", "cash");
  const closeBaseline = store.cashCloseBaseline("store", "cash");
  const attemptBaseline = store.cashCheckpointBaseline("store", "cash");
  assert.equal(compareCashCheckpoint(closeBaseline.snapshot, "cash", []).localChanged, false);
  assert.equal(compareCashCheckpoint(attemptBaseline.snapshot, "cash", []).localChanged, true);
  assert.equal(closeBaseline.snapshot.sales[0].total, 25);
  assert.equal(attemptBaseline.snapshot.sales[0].total, 80);
});

test("missing or ambiguous receipt data prevents close without changing the snapshot", t => {
  for (const change of [
    data => { delete data.financeEntries; },
    data => { data.cashSessions[0].openingAmount = null; },
    data => { data.sales[0].total = "invalid"; },
    data => { data.cashSessions[0].cashMovements[0].type = "unknown"; }
  ]) {
    const data = initial();
    change(data);
    const store = new OfflineStore(":memory:");
    t.after(() => store.close());
    store.initialize("store", data, 0);
    const before = store.read("store");
    assert.throws(() => new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0));
    assert.deepEqual(store.read("store"), before);
  }
});

test("pre-existing outbox is preserved and not sent after provisional closing", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const current = store.read("store");
  store.save("store", current.snapshot, current.localRevision);
  const pending = store.prepareUpload("store");
  new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
  let calls = 0;
  await assert.rejects(uploadPending(store, "store", { applySnapshot() { calls++; } }), /requires online reconciliation/);
  assert.deepEqual(store.pendingUpload("store"), pending);
  assert.equal(calls, 0);
});

test("cash checkpoint identifier survives restart and rejects a changed or nonprovisional session", t => {
  const dir = mkdtempSync(join(tmpdir(), "cash-checkpoint-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize("store", initial(), 0);
  assert.throws(() => store.cashCheckpoint("store", "cash"), /provisional/);
  new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
  const checkpoint = store.cashCheckpoint("store", "cash");
  const baseline = store.cashCheckpointBaseline("store", "cash");
  assert.equal(baseline.localRevision, store.read("store").localRevision);
  assert.equal(baseline.snapshot.cashSessions[0].offlineClosureStatus, "provisional");
  assert.deepEqual(store.cashCheckpoint("store", "cash"), checkpoint);
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(store.cashCheckpoint("store", "cash"), checkpoint);
  assert.deepEqual(store.cashCheckpointBaseline("store", "cash"), baseline);
  const changed = store.read("store");
  changed.snapshot.cashSessions[0].closedAt = "2026-01-01T12:00:00Z";
  store.save("store", changed.snapshot, changed.localRevision);
  assert.throws(() => store.cashCheckpoint("store", "cash"), /changed after checkpoint/);
  assert.deepEqual(store.cashCheckpointBaseline("store", "cash"), baseline);
});

test("legacy checkpoints are not retroactively assigned an unverified local baseline", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
  const closedAt = store.read("store").snapshot.cashSessions[0].closedAt;
  store.db.prepare(`INSERT INTO offline_cash_checkpoints (business_id, session_id, checkpoint_id, closed_at)
    VALUES (?, ?, ?, ?)`).run("store", "cash", "legacy", closedAt);
  assert.equal(store.cashCheckpoint("store", "cash").checkpointId, "legacy");
  assert.equal(store.cashCheckpointBaseline("store", "cash"), null);
});

test("closure between the initial read and outbox preparation prevents sending", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const read = store.read.bind(store);
  let first = true;
  store.read = businessId => {
    const snapshot = read(businessId);
    if (first) {
      first = false;
      new LocalSales(store, businessId).closeCashProvisionally("close", "cash", 0);
    }
    return snapshot;
  };
  let sends = 0;
  await assert.rejects(uploadPending(store, "store", { applySnapshot() { sends++; } }), /requires online reconciliation/);
  assert.equal(sends, 0);
  assert.equal(store.pendingUpload("store"), null);
  assert.equal(read("store").snapshot.cashSessions[0].offlineClosureStatus, "provisional");
});

test("closing while a previous upload is in flight preserves the close and skips heartbeat", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", initial(), 0);
  const current = store.read("store");
  store.save("store", current.snapshot, current.localRevision);
  let started;
  let release;
  const sending = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  let heartbeats = 0;
  const coordinator = new SyncPresence(store, "store", {
    async applySnapshot() { started(); await response; return { status: "applied", revision: 1 }; },
    async heartbeat() { heartbeats++; }
  });
  const sync = coordinator.runOnce();
  await sending;
  new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
  release();
  assert.deepEqual(await sync, { status: "pending" });
  assert.equal(heartbeats, 0);
  assert.equal(store.read("store").pending, true);
  assert.equal(store.read("store").snapshot.cashSessions[0].offlineClosureStatus, "provisional");
  await assert.rejects(coordinator.runOnce(), /requires online reconciliation/);
});

test("status lookup acknowledges only an already applied outbox while keeping the provisional close", async t => {
    const store = new OfflineStore(":memory:");
    t.after(() => store.close());
    store.initialize("store", initial(), 3);
    const current = store.read("store");
    store.save("store", current.snapshot, current.localRevision);
    const outbox = store.prepareUpload("store");
    new LocalSales(store, "store").closeCashProvisionally("close", "cash", 0);
    let calls = 0;
    const remote = { async operationStatus(request) {
      calls++;
      assert.deepEqual(request, { operationId: outbox.operationId, snapshot: outbox.snapshot, expectedRevision: 3 });
      return calls === 1 ? { status: "unknown" } : { status: "applied", revision: 4 };
    } };
    assert.deepEqual(await inspectPendingUpload(store, "store", remote), { status: "unknown" });
    assert.deepEqual(store.pendingUpload("store"), outbox);
    assert.deepEqual(await inspectPendingUpload(store, "store", remote), { status: "acknowledged", pending: true });
    assert.equal(store.pendingUpload("store"), null);
    assert.equal(store.read("store").remoteRevision, 4);
    assert.equal(store.read("store").snapshot.cashSessions[0].offlineClosureStatus, "provisional");
    await assert.rejects(uploadPending(store, "store", {}), /requires online reconciliation/);
    assert.deepEqual(await inspectPendingUpload(store, "store", remote), { status: "none" });
  });

test("status errors and revoked authorization preserve the outbox", async t => {
    const store = new OfflineStore(":memory:");
    t.after(() => store.close());
    store.initialize("store", initial(), 3);
    const current = store.read("store");
    store.save("store", current.snapshot, current.localRevision);
    const outbox = store.prepareUpload("store");
    const applied = { operationStatus: async () => ({ status: "applied", revision: 4 }) };
    await assert.rejects(inspectPendingUpload(store, "store", applied, () => { throw new Error("revoked"); }), /revoked/);
    await assert.rejects(inspectPendingUpload(store, "store", {
      operationStatus: async () => ({ status: "applied", revision: 5 })
    }), /Invalid operation status/);
    await assert.rejects(inspectPendingUpload(store, "store", {
      operationStatus: async () => { throw new Error("offline"); }
    }), /offline/);
    assert.deepEqual(store.pendingUpload("store"), outbox);
    assert.equal(store.read("store").remoteRevision, 3);
  });
