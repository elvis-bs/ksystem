import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";

const snapshot = () => ({ products: [], ingredients: [], sales: [], cashSessions: [] });

test("saves sales and cash durably across restart and isolates businesses", t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-offline-test-"));
  const filename = join(directory, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.initialize("store-a", snapshot(), 4);
  store.initialize("store-b", snapshot(), 2);
  const local = store.read("store-a");
  local.snapshot.sales.push({ id: "sale-1", total: 25 });
  local.snapshot.cashSessions.push({ id: "cash-1", openingAmount: 10 });
  store.save("store-a", local.snapshot, local.localRevision);
  store.close();

  store = new OfflineStore(filename);
  const restored = store.read("store-a");
  assert.equal(restored.pending, true);
  assert.equal(restored.remoteRevision, 4);
  assert.equal(restored.snapshot.sales[0].id, "sale-1");
  assert.equal(restored.snapshot.cashSessions[0].id, "cash-1");
  assert.equal(store.read("store-b").snapshot.sales.length, 0);
});

test("rejects stale local writers without losing the first sale", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 0);
  const first = store.read("store");
  const stale = store.read("store");
  first.snapshot.sales.push({ id: "first" });
  store.save("store", first.snapshot, first.localRevision);
  stale.snapshot.sales.push({ id: "second" });
  assert.throws(() => store.save("store", stale.snapshot, stale.localRevision), /changed/);
  assert.deepEqual(store.read("store").snapshot.sales, [{ id: "first" }]);
});

test("read-only command results cannot conceal snapshot changes", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 0);
  const before = store.read("store");
  assert.throws(() => store.executeCommand("store", "command", { action: "test" }, data => {
    data.sales.push({ id: "hidden" });
    return { status: "rejected" };
  }, null, { readOnlyResult: result => result.status === "rejected" }), /Read-only command changed/);
  assert.deepEqual(store.read("store"), before);
  const accepted = store.executeCommand("store", "command", { action: "test" },
    data => { data.sales.push({ id: "visible" }); return { status: "recorded" }; },
    null, { readOnlyResult: result => result.status === "rejected" });
  assert.equal(accepted.status, "recorded");
  assert.equal(store.read("store").snapshot.sales[0].id, "visible");
});

test("separate connections cannot overwrite each other's local changes", t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-offline-concurrency-"));
  const filename = join(directory, "store.sqlite");
  const first = new OfflineStore(filename);
  const second = new OfflineStore(filename);
  t.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  first.initialize("store", snapshot(), 7);
  const firstView = first.read("store");
  const secondView = second.read("store");
  firstView.snapshot.sales.push({ id: "sale-from-first" });
  first.save("store", firstView.snapshot, firstView.localRevision);
  secondView.snapshot.cashSessions.push({ id: "cash-from-second" });
  assert.throws(() => second.save("store", secondView.snapshot, secondView.localRevision), /changed/);
  assert.equal(second.read("store").snapshot.sales[0].id, "sale-from-first");
  assert.equal(second.read("store").snapshot.cashSessions.length, 0);
});

test("does not overwrite pending changes with a remote snapshot", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 1);
  const local = store.read("store");
  local.snapshot.sales.push({ id: "offline-sale" });
  store.save("store", local.snapshot, local.localRevision);
  assert.throws(() => store.acceptRemote("store", snapshot(), 1, 2), /conflicts/);
  assert.equal(store.read("store").snapshot.sales[0].id, "offline-sale");
  assert.equal(store.read("store").pending, true);
});

test("acknowledging a transmitted revision retains later unsynced sales", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 3);
  const first = store.read("store");
  first.snapshot.sales.push({ id: "first" });
  const sent = store.save("store", first.snapshot, first.localRevision);
  const upload = store.prepareUpload("store");
  sent.snapshot.sales.push({ id: "second" });
  store.save("store", sent.snapshot, sent.localRevision);
  const afterAck = store.acknowledgeUpload("store", upload.operationId, 4);
  assert.equal(afterAck.pending, true);
  assert.equal(afterAck.syncedRevision, 1);
  assert.equal(afterAck.remoteRevision, 4);
  assert.equal(afterAck.snapshot.sales.length, 2);
  assert.throws(() => store.acknowledgeUpload("store", upload.operationId, 4), /Unknown/);
  const second = store.prepareUpload("store");
  assert.equal(store.acknowledgeUpload("store", second.operationId, 5).pending, false);
});

test("remote changes invalidate stale local versions and cannot move revisions backwards", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 4);
  const stale = store.read("store");
  const remote = snapshot();
  remote.sales.push({ id: "remote" });
  const accepted = store.acceptRemote("store", remote, 4, 5);
  assert.equal(accepted.pending, false);
  assert.equal(accepted.localRevision, 1);
  assert.throws(() => store.save("store", stale.snapshot, stale.localRevision), /changed/);
  assert.throws(() => store.acceptRemote("store", remote, 5, 4), /increase/);
  assert.throws(() => store.acceptRemote("store", remote, 5, 5), /increase/);
  assert.equal(store.read("store").snapshot.sales[0].id, "remote");
});

test("invalid snapshots and unknown stores are never silently accepted", t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  assert.throws(() => store.initialize("store", {}, 0), /arrays/);
  assert.throws(() => store.save("missing", snapshot(), 0), /does not exist/);
  assert.equal(store.read("missing"), null);
});
