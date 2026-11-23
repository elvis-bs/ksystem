export class OfflineSyncConflict extends Error {
  constructor(expected, actual) {
    super(`Remote revision conflict: expected ${expected}, found ${actual}`);
    this.name = "OfflineSyncConflict";
    this.expectedRevision = expected;
    this.actualRevision = actual;
  }
}

export async function uploadPending(store, businessId, remote) {
  const current = store.read(businessId);
  if (!current) throw new Error("Local snapshot does not exist");
  if (current.snapshot.cashSessions.some(session => session.offlineClosureStatus === "provisional")) {
    throw new Error("Provisional cash closure requires online reconciliation before synchronization");
  }
  const pending = store.prepareUpload(businessId);
  if (!pending) return { status: "up-to-date" };
  const result = await remote.applySnapshot({
    operationId: pending.operationId,
    snapshot: pending.snapshot,
    expectedRevision: pending.remoteRevision
  });
  if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0) {
    throw new Error("Invalid response from remote sync");
  }
  if (result.status === "conflict") {
    throw new OfflineSyncConflict(pending.remoteRevision, result.revision);
  }
  if (result.status !== "applied" || result.revision !== pending.remoteRevision + 1) {
    throw new Error("Unexpected response from remote sync");
  }
  const local = store.acknowledgeUpload(businessId, pending.operationId, result.revision);
  return { status: local.pending ? "pending" : "synced", localRevision: local.localRevision };
}

export async function inspectPendingUpload(store, businessId, remote, authorize = null) {
  if (authorize !== null && typeof authorize !== "function") throw new TypeError("Invalid authorization callback");
  const pending = store.pendingUpload(businessId);
  if (!pending) return { status: "none" };
  if (!remote || typeof remote.operationStatus !== "function") throw new TypeError("Operation status remote is required");
  const result = await remote.operationStatus({
    operationId: pending.operationId, snapshot: pending.snapshot, expectedRevision: pending.remoteRevision
  });
  if (authorize) authorize();
  if (result?.status === "unknown") return { status: "unknown" };
  if (result?.status !== "applied" || result.revision !== pending.remoteRevision + 1
    || !Number.isSafeInteger(result.revision)) throw new Error("Invalid operation status response");
  const current = store.pendingUpload(businessId);
  if (!current || current.operationId !== pending.operationId) {
    throw new Error("Pending operation changed during status check");
  }
  const local = store.acknowledgeUpload(businessId, pending.operationId, result.revision);
  return { status: "acknowledged", pending: local.pending };
}

export function createSupabaseSyncRemote(client) {
  return {
    async applySnapshot({ operationId, snapshot, expectedRevision }) {
      const { data, error } = await client.rpc("apply_offline_snapshot", {
        p_operation_id: operationId,
        p_snapshot: snapshot,
        p_expected_revision: expectedRevision
      });
      if (error) throw new Error(`Remote sync failed: ${error.message}`, { cause: error });
      return data;
    }
  };
}

export function createOwnedSupabaseSyncRemote(client, credential) {
  if (!client || typeof client.rpc !== "function") throw new TypeError("Supabase client is required");
  if (typeof credential !== "string" || !/^[0-9a-f]{64}$/.test(credential)) {
    throw new TypeError("Invalid device credential");
  }
  return {
    async applySnapshot({ operationId, snapshot, expectedRevision }) {
      const { data, error } = await client.rpc("experimental_apply_owned_snapshot", {
        p_credential: credential,
        p_operation_id: operationId,
        p_snapshot: snapshot,
        p_expected_revision: expectedRevision
      });
      if (error) throw new Error(`Remote sync failed: ${error.message}`, { cause: error });
      return data;
    },
    async operationStatus({ operationId, snapshot, expectedRevision }) {
      const { data, error } = await client.rpc("experimental_owned_operation_status", {
        p_credential: credential,
        p_operation_id: operationId,
        p_snapshot: snapshot,
        p_expected_revision: expectedRevision
      });
      if (error) throw new Error(`Operation status failed: ${error.message}`, { cause: error });
      return data;
    }
  };
}
