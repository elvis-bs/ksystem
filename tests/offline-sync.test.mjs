import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { createOwnedSupabaseSyncRemote, createSupabaseSyncRemote, OfflineSyncConflict, uploadPending } from "../local/offline-sync.mjs";

const snapshot = () => ({ products: [], ingredients: [], sales: [], cashSessions: [] });

test("retries the same persisted operation after a lost response and restart", async t => {
  const directory = mkdtempSync(join(tmpdir(), "bora-sync-"));
  const filename = join(directory, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.initialize("store", snapshot(), 4);
  const local = store.read("store");
  local.snapshot.sales.push({ id: "first" });
  store.save("store", local.snapshot, local.localRevision);
  const requests = [];
  const server = {
    async applySnapshot(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new Error("response lost after server committed");
      return { status: "applied", revision: 5 };
    }
  };
  await assert.rejects(uploadPending(store, "store", server), /response lost/);
  const pending = store.pendingUpload("store");
  store.close();
  store = new OfflineStore(filename);
  const later = store.read("store");
  later.snapshot.sales.push({ id: "second" });
  store.save("store", later.snapshot, later.localRevision);
  assert.deepEqual(store.pendingUpload("store"), pending);
  assert.deepEqual(await uploadPending(store, "store", server),
    { status: "pending", localRevision: 2 });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(store.read("store").syncedRevision, 1);
  assert.equal(store.read("store").snapshot.sales.length, 2);
  assert.equal(store.pendingUpload("store"), null);
});

test("conflicts and unexpected responses preserve the pending operation and local data", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 3);
  const local = store.read("store");
  local.snapshot.sales.push({ id: "offline" });
  store.save("store", local.snapshot, local.localRevision);
  await assert.rejects(
    uploadPending(store, "store", { applySnapshot: async () => ({ status: "conflict", revision: 4 }) }),
    error => error instanceof OfflineSyncConflict && error.expectedRevision === 3 && error.actualRevision === 4
  );
  const pending = store.pendingUpload("store");
  await assert.rejects(uploadPending(store, "store", {
    applySnapshot: async () => ({ status: "applied", revision: 9 })
  }), /Unexpected response/);
  assert.deepEqual(store.pendingUpload("store"), pending);
  assert.equal(store.read("store").snapshot.sales[0].id, "offline");
  assert.throws(() => store.acknowledgeUpload("store", "wrong", 4), /Unknown/);
});

test("sends a later local revision only after the previous upload is acknowledged", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", snapshot(), 2);
  const local = store.read("store");
  local.snapshot.sales.push({ id: "first" });
  store.save("store", local.snapshot, local.localRevision);
  const first = store.prepareUpload("store");
  const next = store.read("store");
  next.snapshot.sales.push({ id: "second" });
  store.save("store", next.snapshot, next.localRevision);
  assert.deepEqual(store.prepareUpload("store"), first);
  store.acknowledgeUpload("store", first.operationId, 3);
  const second = store.prepareUpload("store");
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(second.remoteRevision, 3);
  assert.equal(second.snapshot.sales.length, 2);
  store.acknowledgeUpload("store", second.operationId, 4);
  assert.deepEqual(await uploadPending(store, "store", {}), { status: "up-to-date" });
});

test("Supabase adapter forwards the operation and surfaces errors", async () => {
  const request = { operationId: "op", snapshot: snapshot(), expectedRevision: 7 };
  const client = {
    async rpc(name, args) {
      assert.equal(name, "apply_offline_snapshot");
      assert.deepEqual(args, { p_operation_id: "op", p_snapshot: request.snapshot, p_expected_revision: 7 });
      return { data: { status: "applied", revision: 8 }, error: null };
    }
  };
  assert.deepEqual(await createSupabaseSyncRemote(client).applySnapshot(request),
    { status: "applied", revision: 8 });
  await assert.rejects(createSupabaseSyncRemote({
    rpc: async () => ({ error: { message: "offline" } })
  }).applySnapshot(request), /offline/);
});

test("owned sync forwards the device credential and propagates remote failures", async () => {
  const credential = "a".repeat(64);
  const request = { operationId: "op", snapshot: snapshot(), expectedRevision: 7 };
  const client = {
    async rpc(name, args) {
      assert.equal(name, "experimental_apply_owned_snapshot");
      assert.deepEqual(args, {
        p_credential: credential, p_operation_id: "op",
        p_snapshot: request.snapshot, p_expected_revision: 7
      });
      return { data: { status: "applied", revision: 8 }, error: null };
    }
  };
  assert.deepEqual(await createOwnedSupabaseSyncRemote(client, credential).applySnapshot(request),
    { status: "applied", revision: 8 });
  assert.throws(() => createOwnedSupabaseSyncRemote(client, "bad"), /Invalid device credential/);
  assert.throws(() => createOwnedSupabaseSyncRemote({}, credential), /Supabase client/);
  await assert.rejects(createOwnedSupabaseSyncRemote({
    rpc: async () => ({ error: { message: "Invalid device credential" } })
  }, credential).applySnapshot(request), /Invalid device credential/);
});
