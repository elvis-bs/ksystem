import { setTimeout as delay } from "node:timers/promises";
import { OfflineSyncConflict, createOwnedSupabaseSyncRemote } from "./offline-sync.mjs";
import { createSupabasePresenceRemote, SyncPresence } from "./sync-presence.mjs";

function interval(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new TypeError(`${name} must be a positive interval in milliseconds`);
  }
  return value;
}

export class AutomaticSync {
  constructor(coordinator, { onStatus, syncedInterval = 20000, pendingInterval = 1000, retryInterval = 10000 } = {}) {
    if (!coordinator || typeof coordinator.runOnce !== "function") throw new TypeError("Sync coordinator is required");
    if (typeof onStatus !== "function") throw new TypeError("Status callback is required");
    this.coordinator = coordinator;
    this.onStatus = onStatus;
    this.syncedInterval = interval(syncedInterval, "syncedInterval");
    this.pendingInterval = interval(pendingInterval, "pendingInterval");
    this.retryInterval = interval(retryInterval, "retryInterval");
    this.controller = null;
    this.task = null;
  }

  start() {
    if (this.task) throw new Error("Automatic sync already started");
    const controller = new AbortController();
    this.controller = controller;
    this.task = Promise.resolve().then(() => this.run(controller.signal));
    return this.task;
  }

  async stop() {
    if (!this.task) return;
    this.controller.abort();
    await this.task;
  }

  async run(signal) {
    try {
      while (!signal.aborted) {
        let result;
        try {
          result = await this.coordinator.runOnce();
          if (!result || !["synced", "pending"].includes(result.status)) {
            throw new Error("Invalid automatic sync result");
          }
        } catch (error) {
          if (error instanceof OfflineSyncConflict) {
            this.onStatus({ status: "conflict", error });
            return;
          }
          this.onStatus({ status: "error", error });
          if (!signal.aborted) await this.wait(this.retryInterval, signal);
          continue;
        }
        this.onStatus(result);
        const next = result.status === "pending" ? this.pendingInterval : this.syncedInterval;
        if (!signal.aborted) await this.wait(next, signal);
      }
    } finally {
      this.task = null;
      this.controller = null;
    }
  }

  async wait(milliseconds, signal) {
    try {
      await delay(milliseconds, undefined, { signal });
    } catch (error) {
      if (error.name !== "AbortError" || !signal.aborted) throw error;
    }
  }
}

export function createAutomaticSync({ store, businessId, client, credential, onStatus, ...options }) {
  const syncRemote = createOwnedSupabaseSyncRemote(client, credential);
  const remote = createSupabasePresenceRemote(client, credential, syncRemote);
  return new AutomaticSync(new SyncPresence(store, businessId, remote), { onStatus, ...options });
}
