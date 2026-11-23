import assert from "node:assert/strict";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { OfflineSyncConflict } from "../local/offline-sync.mjs";
import { createSupabasePresenceRemote, SyncPresence } from "../local/sync-presence.mjs";

function setup(t) {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize("store", { products: [], ingredients: [], sales: [], cashSessions: [] }, 3);
  return store;
}

function addSale(store, id) {
  const current = store.read("store");
  current.snapshot.sales.push({ id });
  store.save("store", current.snapshot, current.localRevision);
}

test("uploads before heartbeat and sends the acknowledged revision", async t => {
  const store = setup(t);
  addSale(store, "sale");
  const events = [];
  const coordinator = new SyncPresence(store, "store", {
    applySnapshot: async request => {
      events.push(["upload", request.expectedRevision]);
      return { status: "applied", revision: 4 };
    },
    heartbeat: async revision => events.push(["heartbeat", revision])
  });
  assert.deepEqual(await coordinator.runOnce(), { status: "synced", localRevision: 1, remoteRevision: 4 });
  assert.deepEqual(events, [["upload", 3], ["heartbeat", 4]]);
});

test("unsynced later changes prevent heartbeat until a subsequent upload", async t => {
  const store = setup(t);
  addSale(store, "first");
  const events = [];
  const coordinator = new SyncPresence(store, "store", {
    applySnapshot: async request => {
      events.push("upload");
      if (request.expectedRevision === 3) addSale(store, "second");
      return { status: "applied", revision: request.expectedRevision + 1 };
    },
    heartbeat: async revision => events.push(`heartbeat-${revision}`)
  });
  assert.deepEqual(await coordinator.runOnce(), { status: "pending" });
  assert.deepEqual(events, ["upload"]);
  assert.deepEqual(await coordinator.runOnce(), { status: "synced", localRevision: 2, remoteRevision: 5 });
  assert.deepEqual(events, ["upload", "upload", "heartbeat-5"]);
});

test("conflict, lost response, and heartbeat failure are visible and do not discard pending data", async t => {
  const store = setup(t);
  addSale(store, "sale");
  let action = "conflict";
  let heartbeats = 0;
  const ids = [];
  const coordinator = new SyncPresence(store, "store", {
    applySnapshot: async request => {
      ids.push(request.operationId);
      if (action === "conflict") return { status: "conflict", revision: 4 };
      if (action === "lost") throw new Error("response lost");
      return { status: "applied", revision: 4 };
    },
    heartbeat: async () => { heartbeats++; throw new Error("heartbeat failed"); }
  });
  await assert.rejects(coordinator.runOnce(), OfflineSyncConflict);
  action = "lost";
  await assert.rejects(coordinator.runOnce(), /response lost/);
  assert.equal(heartbeats, 0);
  assert.equal(store.read("store").pending, true);
  action = "success";
  await assert.rejects(coordinator.runOnce(), /heartbeat failed/);
  assert.equal(new Set(ids).size, 1);
  assert.equal(store.read("store").pending, false);
  assert.equal(store.read("store").snapshot.sales[0].id, "sale");
});

test("overlapping runs are rejected and writes during heartbeat are reported pending", async t => {
  const store = setup(t);
  let release;
  let markStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const coordinator = new SyncPresence(store, "store", {
    applySnapshot: async () => { throw new Error("Unexpected upload"); },
    heartbeat: async () => { markStarted(); await gate; }
  });
  const first = coordinator.runOnce();
  await started;
  await assert.rejects(coordinator.runOnce(), /already running/);
  addSale(store, "during-heartbeat");
  release();
  assert.deepEqual(await first, { status: "pending" });
});

test("Supabase adapter validates credential, forwards revision, and reports RPC errors", async () => {
  const calls = [];
  const client = { rpc: async (...args) => { calls.push(args); return { error: null }; } };
  const syncRemote = { applySnapshot: async request => request };
  const remote = createSupabasePresenceRemote(client, "a".repeat(64), syncRemote);
  await remote.heartbeat(7);
  assert.deepEqual(calls, [["experimental_store_heartbeat", {
    p_credential: "a".repeat(64), p_expected_revision: 7
  }]]);
  assert.deepEqual(await remote.applySnapshot({ id: 1 }), { id: 1 });
  await assert.rejects(remote.heartbeat(-1), /revision/);
  assert.throws(() => createSupabasePresenceRemote(client, "short", syncRemote), /credential/);
  await assert.rejects(createSupabasePresenceRemote({
    rpc: async () => ({ error: { message: "offline" } })
  }, "a".repeat(64), syncRemote).heartbeat(7), /offline/);
});
