import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { PhotoCache } from "../local/photo-cache.mjs";
import { prepareStore, createSupabasePreparationRemote } from "../local/prepare-store.mjs";

const business = "11111111-1111-1111-1111-111111111111";
const path = `${business}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg`;
const photo = Buffer.from([255, 216, 1, 2, 255, 217]);
const snapshot = () => ({
  products: [{ id: "p", category: "lanche", active: true, photoPath: path }],
  ingredients: [], sales: [], cashSessions: []
});
const remote = (snapshotValue = snapshot(), revision = 2) => ({
  readSnapshot: async () => ({ snapshot: structuredClone(snapshotValue), revision }),
  downloadPhoto: async () => photo
});

test("prepares snapshot and photo together and retains both after restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bora-prepared-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let photos = new PhotoCache(store);
  assert.deepEqual(await prepareStore(store, photos, business, remote()), { revision: 2, photoCount: 1, downloaded: 1 });
  store.close();
  store = new OfflineStore(filename);
  photos = new PhotoCache(store);
  assert.deepEqual(store.read(business).snapshot, snapshot());
  assert.deepEqual(photos.getForProduct(business, "p"), photo);
  assert.deepEqual(await prepareStore(store, photos, business, remote()), { revision: 2, photoCount: 1, downloaded: 0 });
});

test("download failures and remote changes preserve the existing snapshot", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const photos = new PhotoCache(store);
  const old = snapshot();
  old.products = [];
  store.initialize(business, old, 1);
  await assert.rejects(prepareStore(store, photos, business, {
    ...remote(), downloadPhoto: async () => { throw new Error("offline"); }
  }), /offline/);
  assert.deepEqual(store.read(business).snapshot, old);
  let count = 0;
  await assert.rejects(prepareStore(store, photos, business, {
    ...remote(), readSnapshot: async () => ({ snapshot: snapshot(), revision: ++count === 1 ? 2 : 3 })
  }), /Remote snapshot changed/);
  assert.deepEqual(store.read(business).snapshot, old);
  assert.equal(photos.getForProduct(business, "p"), null);
});

test("local edits made during download and pending outbox prevent remote overwrite", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const photos = new PhotoCache(store);
  const old = snapshot();
  old.products = [];
  store.initialize(business, old, 1);
  await assert.rejects(prepareStore(store, photos, business, {
    ...remote(),
    downloadPhoto: async () => {
      const current = store.read(business);
      current.snapshot.sales.push({ id: "offline-sale" });
      store.save(business, current.snapshot, current.localRevision);
      return photo;
    }
  }), /conflicts|changed/);
  assert.equal(store.read(business).snapshot.sales[0].id, "offline-sale");
  store.prepareUpload(business);
  await assert.rejects(prepareStore(store, photos, business, remote()), /synchronized first/);
});

test("photo commit failure rolls back bootstrap and refresh", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const photos = new PhotoCache(store);
  photos.commit = () => { throw new Error("disk full"); };
  await assert.rejects(prepareStore(store, photos, business, remote()), /disk full/);
  assert.equal(store.read(business), null);
  const old = snapshot();
  old.products = [];
  store.initialize(business, old, 1);
  await assert.rejects(prepareStore(store, photos, business, remote()), /disk full/);
  assert.equal(store.read(business).remoteRevision, 1);
  assert.deepEqual(store.read(business).snapshot, old);
});

test("concurrent conflicting photo bytes roll back snapshot update", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const photos = new PhotoCache(store);
  const old = snapshot();
  old.products = [];
  store.initialize(business, old, 1);
  await assert.rejects(prepareStore(store, photos, business, {
    ...remote(),
    downloadPhoto: async () => {
      store.db.prepare("INSERT INTO offline_photos (business_id, photo_path, content) VALUES (?, ?, ?)")
        .run(business, path, Buffer.from([255, 216, 9, 255, 217]));
      return photo;
    }
  }), /Photo changed/);
  assert.equal(store.read(business).remoteRevision, 1);
  assert.deepEqual(store.read(business).snapshot, old);
});

test("rejects malformed, backwards or inconsistent remote revisions", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const photos = new PhotoCache(store);
  store.initialize(business, snapshot(), 2);
  await assert.rejects(prepareStore(store, photos, business, remote(snapshot(), 1)), /backwards/);
  const different = snapshot();
  different.sales.push({ id: "other" });
  await assert.rejects(prepareStore(store, photos, business, remote(different, 2)), /without a new revision/);
  await assert.rejects(prepareStore(store, photos, business, remote(snapshot(), "2")), /Invalid remote snapshot/);
});

test("Supabase preparation adapter reads only the selected account and surfaces failures", async () => {
  const client = {
    from(table) {
      assert.equal(table, "business_data");
      return { select(columns) {
        assert.equal(columns, "data,sync_revision");
        return { eq(field, id) {
          assert.equal(field, "user_id");
          assert.equal(id, business);
          return { maybeSingle: async () => ({ data: { data: snapshot(), sync_revision: 2 }, error: null }) };
        } };
      } };
    }
  };
  const adapter = createSupabasePreparationRemote(client, async () => photo);
  assert.deepEqual(await adapter.readSnapshot(business), { snapshot: snapshot(), revision: 2 });
  assert.deepEqual(await adapter.downloadPhoto(path), photo);
});
