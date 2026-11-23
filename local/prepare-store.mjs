import { isDeepStrictEqual } from "node:util";

export async function prepareStore(store, photos, businessId, remote) {
  if (!store || !photos || photos.store !== store || !remote
    || typeof remote.readSnapshot !== "function" || typeof remote.downloadPhoto !== "function") {
    throw new TypeError("Invalid store preparation dependencies");
  }
  const before = store.read(businessId);
  if (before?.pending || store.pendingUpload(businessId)) throw new Error("Local changes must be synchronized first");
  const received = await remote.readSnapshot(businessId);
  if (!received || !Number.isSafeInteger(received.revision) || received.revision < 0
    || !received.snapshot || typeof received.snapshot !== "object"
    || !Array.isArray(received.snapshot.products)) throw new Error("Invalid remote snapshot");
  if (before && received.revision < before.remoteRevision) throw new Error("Remote revision moved backwards");
  if (before && received.revision === before.remoteRevision
    && !isDeepStrictEqual(received.snapshot, before.snapshot)) {
    throw new Error("Snapshot changed without a new revision");
  }
  const staged = await photos.stage(businessId, received.snapshot, remote.downloadPhoto);
  const latest = await remote.readSnapshot(businessId);
  if (!latest || latest.revision !== received.revision
    || !isDeepStrictEqual(latest.snapshot, received.snapshot)) {
    throw new Error("Remote snapshot changed during preparation");
  }
  let photoResult;
  const commitPhotos = () => { photoResult = photos.commit(businessId, staged); };
  if (!before) {
    store.initialize(businessId, received.snapshot, received.revision, commitPhotos);
  } else if (received.revision > before.remoteRevision) {
    store.acceptRemote(businessId, received.snapshot, before.remoteRevision, received.revision, () => {
      const current = store.read(businessId);
      if (current.localRevision !== before.localRevision + 1) throw new Error("Local snapshot changed during preparation");
      commitPhotos();
    });
  } else {
    store.transaction(() => {
      const current = store.read(businessId);
      if (!current || current.pending || current.localRevision !== before.localRevision
        || current.remoteRevision !== before.remoteRevision || store.pendingUpload(businessId)) {
        throw new Error("Local snapshot changed during preparation");
      }
      commitPhotos();
    });
  }
  return { revision: received.revision, ...photoResult };
}

export function createSupabasePreparationRemote(client, downloadPhoto) {
  if (!client || typeof client.from !== "function" || typeof downloadPhoto !== "function") {
    throw new TypeError("Invalid preparation client");
  }
  return {
    downloadPhoto,
    async readSnapshot(businessId) {
      const { data, error } = await client.from("business_data").select("data,sync_revision")
        .eq("user_id", businessId).maybeSingle();
      if (error) throw new Error(`Remote snapshot failed: ${error.message}`, { cause: error });
      if (!data) throw new Error("Remote snapshot not found");
      return { snapshot: data.data, revision: data.sync_revision };
    }
  };
}
