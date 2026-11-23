import { uploadPending } from "./offline-sync.mjs";

export class SyncPresence {
  constructor(store, businessId, remote) {
    if (!store || typeof store.read !== "function") throw new TypeError("store is required");
    if (typeof businessId !== "string" || !businessId.trim()) throw new TypeError("businessId is required");
    if (!remote || typeof remote.applySnapshot !== "function" || typeof remote.heartbeat !== "function") {
      throw new TypeError("remote sync and heartbeat are required");
    }
    this.store = store;
    this.businessId = businessId;
    this.remote = remote;
    this.running = false;
  }

  async runOnce() {
    if (this.running) throw new Error("Sync already running");
    this.running = true;
    try {
      await uploadPending(this.store, this.businessId, this.remote);
      const current = this.store.read(this.businessId);
      if (!current) throw new Error("Local snapshot does not exist");
      if (current.pending || this.store.pendingUpload(this.businessId)) {
        return { status: "pending" };
      }
      await this.remote.heartbeat(current.remoteRevision);
      const afterHeartbeat = this.store.read(this.businessId);
      if (!afterHeartbeat || afterHeartbeat.pending || afterHeartbeat.localRevision !== current.localRevision
        || afterHeartbeat.remoteRevision !== current.remoteRevision) {
        return { status: "pending" };
      }
      return { status: "synced", localRevision: current.localRevision, remoteRevision: current.remoteRevision };
    } finally {
      this.running = false;
    }
  }
}

export function createSupabasePresenceRemote(client, credential, syncRemote) {
  if (!client || typeof client.rpc !== "function") throw new TypeError("Supabase client is required");
  if (typeof credential !== "string" || !/^[0-9a-f]{64}$/.test(credential)) {
    throw new TypeError("Invalid device credential");
  }
  if (!syncRemote || typeof syncRemote.applySnapshot !== "function") throw new TypeError("Sync remote is required");
  return {
    applySnapshot: request => syncRemote.applySnapshot(request),
    async heartbeat(revision) {
      if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("Invalid remote revision");
      const { error } = await client.rpc("experimental_store_heartbeat", {
        p_credential: credential,
        p_expected_revision: revision
      });
      if (error) throw new Error(`Store presence failed: ${error.message}`, { cause: error });
    }
  };
}
