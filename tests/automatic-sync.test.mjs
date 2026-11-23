import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomaticSync, createAutomaticSync } from "../local/automatic-sync.mjs";
import { OfflineStore } from "../local/offline-store.mjs";
import { OfflineSyncConflict } from "../local/offline-sync.mjs";

const snapshot = () => ({ products: [], ingredients: [], sales: [], cashSessions: [] });
const options = { syncedInterval: 10000, pendingInterval: 5, retryInterval: 5 };

function waitForStatus(events, status) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const check = () => {
      const event = events.find(item => item.status === status);
      if (event) resolve(event);
      else if (Date.now() >= deadline) reject(new Error(`Missing status: ${status}`));
      else setTimeout(check, 5);
    };
    check();
  });
}

function addSale(store, id) {
  const current = store.read("store");
  current.snapshot.sales.push({ id });
  store.save("store", current.snapshot, current.localRevision);
}

test("retries a lost response using the persisted operation and confirms presence only afterward", async t => {
  const directory = mkdtempSync(join(tmpdir(), "automatic-sync-"));
  const store = new OfflineStore(join(directory, "store.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize("store", snapshot(), 4);
  addSale(store, "sale");
  const calls = [];
  const events = [];
  let attempts = 0;
  const client = {
    async rpc(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name === "experimental_apply_owned_snapshot") {
        attempts++;
        if (attempts === 1) return { error: { message: "response lost" } };
        return { data: { status: "applied", revision: 5 }, error: null };
      }
      assert.equal(name, "experimental_store_heartbeat");
      return { error: null };
    }
  };
  const sync = createAutomaticSync({ store, businessId: "store", client, credential: "a".repeat(64),
    onStatus: event => events.push(event), ...options });
  const running = sync.start();
  assert.throws(() => sync.start(), /already started/);
  await waitForStatus(events, "synced");
  await sync.stop();
  await running;
  assert.deepEqual(events.map(event => event.status), ["error", "synced"]);
  assert.match(events[0].error.message, /response lost/);
  assert.deepEqual(calls.map(call => call.name),
    ["experimental_apply_owned_snapshot", "experimental_apply_owned_snapshot", "experimental_store_heartbeat"]);
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.equal(calls[2].args.p_expected_revision, 5);
  assert.equal(store.read("store").pending, false);
  assert.equal(store.read("store").snapshot.sales[0].id, "sale");
});

test("a conflict stops retries and survives restart without replacing local sales", async t => {
  const directory = mkdtempSync(join(tmpdir(), "automatic-conflict-"));
  const filename = join(directory, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize("store", snapshot(), 4);
  addSale(store, "offline");
  const events = [];
  let attempts = 0;
  const client = {
    async rpc(name) {
      assert.equal(name, "experimental_apply_owned_snapshot");
      attempts++;
      return { data: { status: "conflict", revision: 6 }, error: null };
    }
  };
  const create = () => createAutomaticSync({ store, businessId: "store", client, credential: "a".repeat(64),
    onStatus: event => events.push(event), ...options });
  await create().start();
  assert.equal(attempts, 1);
  assert.ok(events[0].error instanceof OfflineSyncConflict);
  const pending = store.pendingUpload("store");
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(store.pendingUpload("store"), pending);
  await create().start();
  assert.equal(attempts, 2);
  assert.deepEqual(store.pendingUpload("store"), pending);
  assert.equal(store.read("store").snapshot.sales[0].id, "offline");
});

test("stopping after a network failure preserves the outbox for the next process", async t => {
  const directory = mkdtempSync(join(tmpdir(), "automatic-restart-"));
  const filename = join(directory, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize("store", snapshot(), 4);
  addSale(store, "offline");
  const events = [];
  let firstRequest;
  const failedClient = {
    async rpc(name, args) {
      assert.equal(name, "experimental_apply_owned_snapshot");
      firstRequest = structuredClone(args);
      throw new Error("network unavailable");
    }
  };
  const first = createAutomaticSync({ store, businessId: "store", client: failedClient, credential: "a".repeat(64),
    onStatus: event => events.push(event), ...options, retryInterval: 10000 });
  const running = first.start();
  await waitForStatus(events, "error");
  await first.stop();
  await running;
  const pending = store.pendingUpload("store");
  store.close();
  store = new OfflineStore(filename);
  assert.deepEqual(store.pendingUpload("store"), pending);
  const recoveredEvents = [];
  const client = {
    async rpc(name, args) {
      if (name === "experimental_apply_owned_snapshot") {
        assert.deepEqual(args, firstRequest);
        return { data: { status: "applied", revision: 5 }, error: null };
      }
      assert.equal(name, "experimental_store_heartbeat");
      return { error: null };
    }
  };
  const second = createAutomaticSync({ store, businessId: "store", client, credential: "a".repeat(64),
    onStatus: event => recoveredEvents.push(event), ...options });
  const resumed = second.start();
  await waitForStatus(recoveredEvents, "synced");
  await second.stop();
  await resumed;
  assert.equal(store.pendingUpload("store"), null);
  assert.equal(store.read("store").snapshot.sales[0].id, "offline");
});

test("pending changes run again without overlap, and stop waits for an active operation", async () => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const events = [];
  let calls = 0;
  const sync = new AutomaticSync({
    async runOnce() {
      calls++;
      if (calls === 1) return { status: "pending" };
      started();
      await gate;
      return { status: "synced", remoteRevision: 7 };
    }
  }, { onStatus: event => events.push(event), ...options });
  const running = sync.start();
  await entered;
  let stopped = false;
  const stopping = sync.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  release();
  await stopping;
  await running;
  assert.equal(calls, 2);
  assert.deepEqual(events.map(event => event.status), ["pending", "synced"]);
});

test("status callback failures surface to the caller and do not leave the scheduler locked", async () => {
  const sync = new AutomaticSync({ runOnce: async () => ({ status: "synced" }) }, {
    onStatus: () => { throw new Error("status delivery failed"); }, ...options
  });
  await assert.rejects(sync.start(), /status delivery failed/);
  await assert.rejects(sync.start(), /status delivery failed/);
  assert.throws(() => new AutomaticSync({ runOnce() {} }, { onStatus() {}, retryInterval: 0 }), /retryInterval/);
});
