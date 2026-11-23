import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfflineStore } from "../local/offline-store.mjs";
import { createSupabasePhotoDownloader, PhotoCache } from "../local/photo-cache.mjs";

const business = "11111111-1111-1111-1111-111111111111";
const firstPath = `${business}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg`;
const secondPath = `${business}/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jpg`;
const photo = Buffer.from([255, 216, 1, 2, 255, 217]);
const snapshot = () => ({
  products: [{ id: "p1", category: "lanche", active: true, photoPath: firstPath }],
  ingredients: [], sales: [], cashSessions: []
});

test("downloads owned photos once and retains them across restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bora-photos-"));
  const filename = join(dir, "store.sqlite");
  let store = new OfflineStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize(business, snapshot(), 0);
  let cache = new PhotoCache(store);
  assert.deepEqual(await cache.refresh(business, async path => {
    assert.equal(path, firstPath);
    return photo;
  }), { photoCount: 1, downloaded: 1 });
  store.close();
  store = new OfflineStore(filename);
  cache = new PhotoCache(store);
  assert.deepEqual(await cache.refresh(business, async () => { throw new Error("offline"); }), { photoCount: 1, downloaded: 0 });
  assert.deepEqual(cache.getForProduct(business, "p1"), photo);
  assert.equal(cache.getForProduct(business, "unknown"), null);
});

test("failed downloads, invalid photos and changed catalog never publish partial cache", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const state = snapshot();
  state.products.push({ id: "p2", category: "lanche", active: true, photoPath: secondPath });
  store.initialize(business, state, 0);
  const cache = new PhotoCache(store);
  await assert.rejects(cache.refresh(business, async path => path === firstPath ? photo : Buffer.from("invalid")), /Invalid product photo/);
  assert.throws(() => cache.getForProduct(business, "p1"), /not available/);
  await assert.rejects(cache.refresh(business, async path => {
    if (path === secondPath) throw new Error("connection lost");
    return photo;
  }), /connection lost/);
  assert.throws(() => cache.getForProduct(business, "p1"), /not available/);
  await assert.rejects(cache.refresh(business, async () => {
    const changed = store.read(business);
    changed.snapshot.sales.push({ id: "sale" });
    store.save(business, changed.snapshot, changed.localRevision);
    return photo;
  }), /snapshot changed/);
  assert.throws(() => cache.getForProduct(business, "p1"), /not available/);
});

test("does not fetch unowned paths, inactive products cannot be served, and missing photos fail explicitly", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  const state = snapshot();
  state.products[0].photoPath = "22222222-2222-2222-2222-222222222222/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg";
  store.initialize(business, state, 0);
  const cache = new PhotoCache(store);
  await assert.rejects(cache.refresh(business, async () => { throw new Error("unexpected"); }), /Invalid product photo path/);
  const current = store.read(business);
  current.snapshot.products[0].photoPath = firstPath;
  store.save(business, current.snapshot, current.localRevision);
  assert.throws(() => cache.getForProduct(business, "p1"), /not available/);
  await cache.refresh(business, async () => photo);
  const changed = store.read(business);
  changed.snapshot.products[0].active = false;
  store.save(business, changed.snapshot, changed.localRevision);
  assert.equal(cache.getForProduct(business, "p1"), null);
});

test("replaced photos do not fall back to the old image after a failed download", async t => {
  const store = new OfflineStore(":memory:");
  t.after(() => store.close());
  store.initialize(business, snapshot(), 0);
  const cache = new PhotoCache(store);
  await cache.refresh(business, async () => photo);
  const current = store.read(business);
  current.snapshot.products[0].photoPath = secondPath;
  store.save(business, current.snapshot, current.localRevision);
  await assert.rejects(cache.refresh(business, async () => { throw new Error("offline"); }), /offline/);
  assert.throws(() => cache.getForProduct(business, "p1"), /not available/);
  const replacement = Buffer.from([255, 216, 3, 4, 255, 217]);
  await cache.refresh(business, async () => replacement);
  assert.deepEqual(cache.getForProduct(business, "p1"), replacement);
});

test("Supabase adapter checks size and surfaces download failures", async () => {
  const download = createSupabasePhotoDownloader({ storage: { from: bucket => {
    assert.equal(bucket, "product-photos");
    return { download: async path => ({ data: new Blob([photo]), error: null }) };
  } } });
  assert.deepEqual(Buffer.from(await download(firstPath)), photo);
  await assert.rejects(download("../file.jpg"), /Invalid photo path/);
  const failed = createSupabasePhotoDownloader({ storage: { from: () => ({
    download: async () => ({ error: { message: "offline" } })
  }) } });
  await assert.rejects(failed(firstPath), /offline/);
  const oversized = createSupabasePhotoDownloader({ storage: { from: () => ({
    download: async () => ({ data: { size: 524289, arrayBuffer() { throw new Error("must not read"); } }, error: null })
  }) } });
  await assert.rejects(oversized(firstPath), /Invalid photo download/);
});
